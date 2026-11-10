import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, DeviceRevokedError, type DevicesApi } from '../../src/main/api.ts';
import { DeviceController, type ControllerDeps } from '../../src/main/controller.ts';
import { DurableJournal } from '../../src/main/journal.ts';
import { Keystore } from '../../src/main/keystore.ts';
import { appPaths, type AppPaths } from '../../src/main/paths.ts';
import type { Logger } from '../../src/main/log.ts';
import { ExtensionHub, everydayChrome } from '../../src/main/native-host/extension-transport.ts';
import type { IpcConnection, IpcFrame } from '../../src/main/native-ipc.ts';
import type { UiState } from '../../src/shared/ui-state.ts';
import { FakePower, FakeSocket, fakeSafeStorage } from '../support/fakes.ts';

const deviceId = '6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f';

let userData: string;
let paths: AppPaths;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'veyquo-controller-'));
  paths = appPaths(userData);
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

type Api = Pick<
  DevicesApi,
  | 'startPairing'
  | 'pairingStatus'
  | 'challenge'
  | 'token'
  | 'connectUrl'
  | 'revokeSelf'
  | 'browserSettings'
  | 'updateBrowserMode'
>;

function setup(overrides: Partial<ControllerDeps> = {}, api: Partial<Api> = {}) {
  const sockets: FakeSocket[] = [];
  const states: UiState[] = [];
  const storage = fakeSafeStorage();
  const keystore = new Keystore({ dir: userData, storage, platform: 'darwin' });
  const startPairing = vi.fn<Api['startPairing']>(() =>
    Promise.resolve({
      pairing_id: 'f2b0b8a4-55b5-4b8f-9a63-0b1c2d3e4f51',
      code: 'ABCD2345',
      approve_url: 'http://localhost:3400/app/devices/pair?code=ABCD2345',
      poll_token: 'poll',
      expires_at: '2100-01-01T00:00:00Z',
    }),
  );
  const fullApi: Api = {
    connectUrl: 'ws://gateway.test/v1/devices/connect',
    startPairing,
    pairingStatus: vi.fn(() =>
      Promise.resolve({ status: 'approved' as const, device_id: deviceId }),
    ),
    challenge: vi.fn(() => Promise.resolve('nonce')),
    token: vi.fn(() => Promise.resolve({ access_token: 'device-token', expires_in: 600 })),
    revokeSelf: vi.fn(() => Promise.resolve()),
    browserSettings: vi.fn(() => Promise.resolve({ selected_modes: [], profiles: [] })),
    updateBrowserMode: vi.fn(() => Promise.resolve({ selected_modes: [], profiles: [] })),
    ...api,
  };
  const enableAutostart = vi.fn(() => Promise.resolve());
  const deps: ControllerDeps = {
    paths,
    appVersion: '0.1.0',
    os: 'macos',
    deviceName: 'Ana’s MacBook',
    keystore,
    api: fullApi,
    locateChrome: () =>
      Promise.resolve({ ok: true, path: '/chrome', version: '152.0.1.2', major: 152 }),
    startChrome: () => Promise.reject(new Error('not in this test')),
    stopStaleChrome: () => Promise.resolve(),
    openSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      queueMicrotask(() => {
        socket.open();
      });
      return socket;
    },
    power: new FakePower(),
    openExternal: vi.fn(() => Promise.resolve()),
    confirm: vi.fn(() => Promise.resolve(true)),
    autostart: {
      enable: enableAutostart,
      disable: vi.fn(() => Promise.resolve()),
      isEnabled: () => Promise.resolve(false),
    },
    registerAutostart: true,
    onState: (state) => states.push(state),
    quit: vi.fn(),
    inform: vi.fn(() => Promise.resolve()),
    sleep: () => Promise.resolve(),
    ...overrides,
  };
  return {
    controller: new DeviceController(deps),
    deps,
    sockets,
    states,
    keystore,
    startPairing,
    enableAutostart,
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe('DeviceController', () => {
  it.each([
    { case: 'missing', write: () => Promise.resolve() },
    { case: 'corrupt', write: () => writeFile(paths.journal, 'not a journal\n') },
  ])(
    'a paired computer whose journal is $case says no hello and asks to pair again',
    async ({ write }) => {
      const { controller, sockets, states, keystore } = setup();
      await keystore.create();
      await keystore.setDeviceId(deviceId);
      await write();
      await controller.start();
      expect(sockets).toEqual([]);
      expect(states.at(-1)?.status).toBe('signed_out');
      expect(states.at(-1)?.notice?.text).toMatch(/pair this computer again/iu);
    },
  );

  it('pairing makes a new key and a fresh journal, opens the approve page and connects', async () => {
    const { controller, deps, sockets, states, keystore, enableAutostart } = setup();
    await controller.start();
    expect(states.at(-1)?.status).toBe('signed_out');
    await controller.pair();
    expect(deps.openExternal).toHaveBeenCalledWith(
      'http://localhost:3400/app/devices/pair?code=ABCD2345',
    );
    expect(states.some((s) => s.status === 'pairing' && s.pairing?.code === 'ABCD2345')).toBe(true);
    expect(await keystore.deviceId()).toBe(deviceId);
    await until(() => sockets[0]?.sent[0]?.name === 'hello');
    const header = JSON.parse((await readFile(paths.journal, 'utf8')).split('\n')[0] ?? '') as {
      journal_id: string;
    };
    expect(sockets[0]?.sent[0]).toMatchObject({
      device_id: deviceId,
      journal_id: header.journal_id,
      journal: [],
      modes: ['veyquo_profile'],
      chrome_version: '152.0.1.2',
    });
    await until(() => states.at(-1)?.status === 'online');
    expect(enableAutostart).toHaveBeenCalled();
    controller.shutdown();
  });

  it('reports unacknowledged journal entries in the hello after a restart', async () => {
    const { controller, sockets, keystore } = setup();
    await keystore.create();
    await keystore.setDeviceId(deviceId);
    const journal = await DurableJournal.create(paths.journal, { deviceId });
    const entry = {
      grant_id: '00000000-0000-4000-8000-000000000001',
      application_id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      state: 'received' as const,
      signals_after: null,
    };
    await journal.record(entry);
    await controller.start();
    await until(() => sockets[0]?.sent[0]?.name === 'hello');
    expect(sockets[0]?.sent[0]).toMatchObject({ journal_id: journal.journalId, journal: [entry] });
    controller.shutdown();
  });

  it('sweeps temp files when it starts', async () => {
    await mkdir(join(paths.tmp, '11111111-2222-4333-8444-555555555555'), { recursive: true });
    await writeFile(join(paths.tmp, '11111111-2222-4333-8444-555555555555', 'resume.pdf'), 'x');
    const { controller } = setup();
    await controller.start();
    expect(await readdir(paths.tmp)).toEqual([]);
  });

  it('a computer removed while it was off wipes its state on start, sign-ins after asking', async () => {
    const { controller, deps, states, keystore } = setup(
      {},
      { challenge: () => Promise.reject(new DeviceRevokedError()) },
    );
    await keystore.create();
    await keystore.setDeviceId(deviceId);
    await DurableJournal.create(paths.journal, { deviceId });
    await mkdir(paths.chromeProfile, { recursive: true });
    await controller.start();
    await until(() => states.at(-1)?.status === 'signed_out');
    expect(deps.confirm).toHaveBeenCalledWith('revoked_profile');
    expect(await keystore.load()).toBeNull();
    expect((await readdir(userData)).filter((name) => name !== 'tmp')).toEqual([]);
  });

  it('says plainly when Chrome is missing', async () => {
    const { controller, states } = setup({
      locateChrome: () =>
        Promise.resolve({ ok: false, error: 'chrome_unavailable', reason: 'missing' }),
    });
    await controller.start();
    expect(states.at(-1)?.chrome).toEqual({
      available: false,
      message: 'Google Chrome is not installed on this computer.',
    });
    expect(states.at(-1)?.modes.veyquoProfile).toBe(false);
  });

  it('refuses to pair without secure storage, with a plain error', async () => {
    const { controller, startPairing, states } = setup({
      keystore: new Keystore({
        dir: userData,
        storage: fakeSafeStorage({ available: false }),
        platform: 'darwin',
      }),
    });
    await controller.start();
    await controller.pair();
    expect(startPairing).not.toHaveBeenCalled();
    expect(states.at(-1)?.status).toBe('signed_out');
    expect(states.at(-1)?.notice).toMatchObject({ tone: 'error' });
    expect(states.at(-1)?.notice?.text).toMatch(/secure storage/u);
  });

  it('pausing closes the connection and resuming opens it again', async () => {
    const { controller, sockets, states, keystore } = setup();
    await keystore.create();
    await keystore.setDeviceId(deviceId);
    await DurableJournal.create(paths.journal, { deviceId });
    await controller.start();
    await until(() => states.at(-1)?.status === 'online');
    await controller.setPaused(true);
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(states.at(-1)).toMatchObject({ status: 'paused', paused: true });
    await controller.setPaused(false);
    await until(() => states.at(-1)?.status === 'online');
    expect(sockets).toHaveLength(2);
    controller.shutdown();
  });

  async function pairedAndOnline(overrides: Partial<ControllerDeps> = {}, api: Partial<Api> = {}) {
    const kit = setup(overrides, api);
    await kit.keystore.create();
    await kit.keystore.setDeviceId(deviceId);
    await DurableJournal.create(paths.journal, { deviceId });
    await kit.controller.start();
    await until(() => kit.states.at(-1)?.status === 'online');
    return kit;
  }

  it('removal revokes the device with its own token before deleting its credentials', async () => {
    const seen: { token: string; keyStillThere: boolean; socketOpen: boolean }[] = [];
    const late: { keystore: Keystore | null; sockets: FakeSocket[] } = {
      keystore: null,
      sockets: [],
    };
    const kit = await pairedAndOnline(
      {},
      {
        revokeSelf: async (token: string) => {
          seen.push({
            token,
            keyStillThere: (await late.keystore?.load()) != null,
            socketOpen: late.sockets[0]?.readyState === FakeSocket.OPEN,
          });
        },
      },
    );
    late.keystore = kit.keystore;
    late.sockets = kit.sockets;
    await kit.controller.remove();
    // The socket is closed first, so the gateway's 4401 is not taken for a second revocation.
    expect(seen).toEqual([{ token: 'device-token', keyStillThere: true, socketOpen: false }]);
    expect(await kit.keystore.load()).toBeNull();
    expect(kit.deps.inform).not.toHaveBeenCalled();
    expect(kit.deps.confirm).toHaveBeenCalledTimes(1);
    expect(kit.deps.confirm).toHaveBeenCalledWith('remove');
    expect(kit.deps.quit).toHaveBeenCalledTimes(1);
  });

  it('removal clears this computer even when the account cannot be reached, and says so', async () => {
    const kit = await pairedAndOnline(
      {},
      { revokeSelf: () => Promise.reject(new ApiError('POST', '/v1/devices/self/revoke', 503)) },
    );
    await kit.controller.remove();
    expect(await kit.keystore.load()).toBeNull();
    expect((await readdir(userData)).filter((name) => name !== 'tmp')).toEqual([]);
    expect(kit.deps.inform).toHaveBeenCalledWith('removed_locally');
    expect(kit.deps.quit).toHaveBeenCalledTimes(1);
  });

  it('an unpaired computer is removed without calling the account', async () => {
    const kit = setup();
    await kit.controller.start();
    await kit.controller.remove();
    expect(kit.deps.api.revokeSelf).not.toHaveBeenCalled();
    expect(kit.deps.inform).not.toHaveBeenCalled();
    expect(kit.deps.quit).toHaveBeenCalledTimes(1);
  });
});

describe('DeviceController and the everyday profile', () => {
  async function paired(overrides: Partial<ControllerDeps> = {}, api: Partial<Api> = {}) {
    const kit = setup(overrides, api);
    await kit.keystore.create();
    await kit.keystore.setDeviceId(deviceId);
    await DurableJournal.create(paths.journal, { deviceId });
    return kit;
  }

  it('offers the everyday profile once the extension is connected', async () => {
    const kit = await paired();
    kit.controller.setExtensionConnected(true);
    expect(kit.states.at(-1)?.modes.everydayProfile).toBe(true);
    await kit.controller.start();
    await until(() => kit.sockets[0]?.sent[0]?.name === 'hello');
    expect(kit.sockets[0]?.sent[0]).toMatchObject({
      modes: ['veyquo_profile', 'everyday_profile'],
    });
    kit.controller.setExtensionConnected(false);
    expect(kit.states.at(-1)?.modes.everydayProfile).toBe(false);
    kit.controller.shutdown();
  });

  it('shows the Chrome mode selected by an attached job profile', async () => {
    const browserSettings = vi.fn(() =>
      Promise.resolve({
        selected_modes: ['everyday_profile'] as ('veyquo_profile' | 'everyday_profile')[],
        profiles: [],
      }),
    );
    const kit = await paired({}, { browserSettings });

    await kit.controller.start();
    await until(() => kit.states.at(-1)?.selectedModes.everydayProfile === true);

    expect(browserSettings).toHaveBeenCalled();
    expect(kit.states.at(-1)?.selectedModes).toEqual({
      veyquoProfile: false,
      everydayProfile: true,
    });
    kit.controller.shutdown();
  });

  it('saves a job profile browser choice through the device API and updates its view', async () => {
    const viewId = '7ad19a89-822e-4b42-8f11-86d1c58b2a5a';
    let respond: ((value: Awaited<ReturnType<Api['updateBrowserMode']>>) => void) | undefined;
    const browserSettings = vi.fn(() =>
      Promise.resolve({
        selected_modes: ['veyquo_profile'] as ('veyquo_profile' | 'everyday_profile')[],
        profiles: [
          {
            view_id: viewId,
            name: 'Whole profile',
            chrome_mode: 'veyquo_profile' as const,
            has_proxy: false,
          },
        ],
      }),
    );
    const updateBrowserMode = vi.fn<Api['updateBrowserMode']>(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const kit = await paired({}, { browserSettings, updateBrowserMode });
    await kit.controller.start();
    await until(() => kit.controller.uiState.browserProfiles.length === 1);

    const saving = kit.controller.setBrowserMode(viewId, 'everyday_profile');
    await until(() => kit.controller.uiState.browserModePending === viewId);
    await kit.controller.setBrowserMode(viewId, 'everyday_profile');
    expect(updateBrowserMode).toHaveBeenCalledTimes(1);
    expect(kit.controller.uiState.browserProfiles[0]?.chromeMode).toBe('veyquo_profile');
    await until(() => respond !== undefined);
    respond?.({
      selected_modes: ['everyday_profile'],
      profiles: [
        {
          view_id: viewId,
          name: 'Whole profile',
          chrome_mode: 'everyday_profile',
          has_proxy: false,
        },
      ],
    });
    await saving;

    expect(updateBrowserMode).toHaveBeenCalledWith('device-token', viewId, 'everyday_profile');
    expect(kit.controller.uiState.browserModePending).toBeNull();
    expect(kit.controller.uiState.browserProfiles).toEqual([
      { viewId, name: 'Whole profile', chromeMode: 'everyday_profile', hasProxy: false },
    ]);
    expect(kit.controller.uiState.selectedModes.everydayProfile).toBe(true);
    kit.controller.shutdown();
  });

  it('shows the proxy conflict when the device API refuses everyday Chrome', async () => {
    const viewId = '7ad19a89-822e-4b42-8f11-86d1c58b2a5a';
    const browserSettings = vi.fn(() =>
      Promise.resolve({
        selected_modes: ['veyquo_profile'] as ('veyquo_profile' | 'everyday_profile')[],
        profiles: [
          {
            view_id: viewId,
            name: 'Whole profile',
            chrome_mode: 'veyquo_profile' as const,
            has_proxy: true,
          },
        ],
      }),
    );
    const updateBrowserMode = vi.fn<Api['updateBrowserMode']>(() =>
      Promise.reject(new ApiError('PATCH', '/v1/devices/self/browser-settings/id', 409)),
    );
    const kit = await paired({}, { browserSettings, updateBrowserMode });
    await kit.controller.start();
    await until(() => kit.controller.uiState.browserProfiles.length === 1);

    await kit.controller.setBrowserMode(viewId, 'everyday_profile');

    expect(kit.controller.uiState.notice?.text).toContain('proxy');
    expect(kit.controller.uiState.browserModePending).toBeNull();
    expect(kit.controller.uiState.browserProfiles[0]?.chromeMode).toBe('veyquo_profile');
    kit.controller.shutdown();
  });

  it('does not call a stale-profile conflict a proxy error', async () => {
    const updateBrowserMode = vi.fn<Api['updateBrowserMode']>(() =>
      Promise.reject(new ApiError('PATCH', '/v1/devices/self/browser-settings/id', 409)),
    );
    const kit = await paired({}, { updateBrowserMode });
    await kit.controller.start();

    await kit.controller.setBrowserMode('7ad19a89-822e-4b42-8f11-86d1c58b2a5a', 'everyday_profile');

    expect(kit.controller.uiState.notice?.text).toContain('Could not change');
    expect(kit.controller.uiState.notice?.text).not.toContain('proxy');
    kit.controller.shutdown();
  });

  it('a failed IPC endpoint is a visible security error, and the everyday profile stays off', async () => {
    const kit = await paired();
    kit.controller.nativeIpcFailed();
    kit.controller.setExtensionConnected(true); // cannot happen, but must not turn it on
    const state = kit.states.at(-1);
    expect(state?.security?.tone).toBe('error');
    expect(state?.security?.text).toMatch(/another program/iu);
    expect(state?.modes.everydayProfile).toBe(false);
    await kit.controller.start();
    await until(() => kit.sockets[0]?.sent[0]?.name === 'hello');
    expect(kit.sockets[0]?.sent[0]).toMatchObject({ modes: ['veyquo_profile'] });
    // Later notices never hide it.
    expect(kit.states.at(-1)?.security).toEqual(state?.security);
    kit.controller.shutdown();
  });

  it('routes an everyday-profile session to the extension’s executor, only while connected', async () => {
    const startEveryday = vi.fn(() => null);
    const kit = await paired({ startEveryday });
    await kit.controller.start();
    await until(() => kit.sockets[0]?.sent[0]?.name === 'hello');
    const socket = kit.sockets[0];
    const open = (n: string) => ({
      request_id: `00000000-0000-4000-8000-0000000000${n}`,
      session_id: null,
      op: {
        name: 'session_open',
        application_id: null,
        chrome_mode: 'everyday_profile',
        visibility: 'visible',
        allowed_hosts: ['jobs.example.com'],
        proxy: null,
      },
    });
    const replies = () => (socket?.sent ?? []).filter((m) => 'request_id' in m);
    socket?.receive(open('aa'));
    await until(() => replies().length === 1);
    expect(startEveryday).not.toHaveBeenCalled();
    kit.controller.setExtensionConnected(true);
    socket?.receive(open('ab'));
    await until(() => replies().length === 2);
    expect(startEveryday).toHaveBeenCalledTimes(1);
    for (const reply of replies()) {
      expect(reply).toMatchObject({ ok: false, error: { type: 'chrome_unavailable' } });
    }
    kit.controller.shutdown();
  });

  it('never logs or forwards the text of the extension’s errors', async () => {
    const sentinel = 'SENTINEL-page-text-4242';
    // An extension whose every answer is an error carrying page-like text.
    const handlers: ((frame: IpcFrame) => void)[] = [];
    const connection: IpcConnection = {
      send: (frame) => {
        if (frame.kind === 'state') return;
        const code = frame.kind === 'tabs.open' ? 'cdp_error' : 'unavailable';
        queueMicrotask(() => {
          for (const handler of handlers) {
            handler({
              id: frame.id,
              kind: 'reply',
              payload: { ok: false, error: { code, message: sentinel, cdp_code: -32000 } },
            });
          }
        });
      },
      onFrame: (handler) => handlers.push(handler),
      onClose: () => undefined,
      close: () => undefined,
    };
    const extensions = new ExtensionHub({
      onTakeover: () => undefined,
      onConnected: () => undefined,
      browserSettingsUrl: 'http://localhost:3400/app/settings/browser',
    });
    extensions.accept(connection);
    const lines: string[] = [];
    const log: Logger = {
      info: (event, fields) => lines.push(JSON.stringify({ event, fields })),
      warn: (event, fields) => lines.push(JSON.stringify({ event, fields })),
      error: (event, error, fields) =>
        lines.push(JSON.stringify({ event, error: String(error), fields })),
    };
    const current = extensions.current;
    if (current === null) throw new Error('not connected');
    const kit = await paired({ log, startEveryday: (context) => everydayChrome(current, context) });
    kit.controller.setExtensionConnected(true);
    await kit.controller.start();
    await until(() => kit.sockets[0]?.sent[0]?.name === 'hello');
    const socket = kit.sockets[0];
    socket?.receive({
      request_id: '00000000-0000-4000-8000-0000000000ac',
      session_id: null,
      op: {
        name: 'session_open',
        application_id: null,
        chrome_mode: 'everyday_profile',
        visibility: 'visible',
        allowed_hosts: ['jobs.example.com'],
        proxy: null,
      },
    });
    await until(() => (socket?.sent ?? []).some((m) => 'request_id' in m));
    expect((socket?.sent ?? []).find((m) => 'request_id' in m)).toMatchObject({ ok: false });
    expect(JSON.stringify(socket?.sent)).not.toContain(sentinel);
    expect(lines.some((line) => line.includes('device.reply'))).toBe(true);
    expect(lines.join('\n')).not.toContain(sentinel);
    kit.controller.shutdown();
  });
});
