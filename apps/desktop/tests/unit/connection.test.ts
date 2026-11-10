import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEVICE_SUBPROTOCOL, type DeviceReply, type HelloEvent } from '@veyquo/device-protocol';
import { JournalUnusableError } from '@veyquo/local-executor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceRevokedError } from '../../src/main/api.ts';
import {
  DeviceConnection,
  backoffDelay,
  type ConnectionDeps,
  type ConnectionStatus,
} from '../../src/main/connection.ts';
import { appPaths } from '../../src/main/paths.ts';
import { wipeRevokedDevice } from '../../src/main/remove.ts';
import { FakePower, FakeSocket } from '../support/fakes.ts';

const hello: HelloEvent = {
  name: 'hello',
  device_id: '6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f',
  protocol_version: 1,
  app_version: '0.1.0',
  os: 'linux',
  chrome_version: '152.0.7977.75',
  modes: ['veyquo_profile'],
  journal_id: '7a1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f',
  journal: [],
};
const requestId = '9b1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f';

function setup(overrides: Partial<ConnectionDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const power = new FakePower();
  const deps: ConnectionDeps = {
    url: 'ws://gateway.test/v1/devices/connect',
    token: vi.fn(() => Promise.resolve('device-token')),
    invalidateToken: vi.fn(),
    openSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    hello: vi.fn(() => Promise.resolve(hello)),
    heartbeat: () => ({ name: 'heartbeat', busy_session_id: null }),
    onKeys: vi.fn(),
    onRequest: vi.fn(),
    onConnectionLost: vi.fn(() => Promise.resolve()),
    onStatus: (status) => statuses.push(status),
    power,
    random: () => 0.5,
    ...overrides,
  };
  const connection = new DeviceConnection(deps);
  return { connection, deps, sockets, statuses, power };
}

/** Lets the connection's awaited promises (token, hello) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('backoff', () => {
  it('backoff schedule', () => {
    const schedule = Array.from({ length: 9 }, (_, attempt) => backoffDelay(attempt, () => 0.5));
    expect(schedule).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it.each([0, 0.25, 0.999])('jitter stays within ±20%% and never above 60 s (random %s)', (r) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const base = Math.min(1000 * 2 ** attempt, 60_000);
      const delay = backoffDelay(attempt, () => r);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.min(base * 1.2, 60_000));
    }
  });

  it('waits longer after each failed attempt and starts over once connected', async () => {
    const { connection, sockets, statuses } = setup();
    connection.start();
    await settle();
    sockets[0]?.drop(1006);
    await settle();
    expect(statuses.at(-1)).toEqual({ state: 'waiting', retryInMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]?.drop(1006);
    await settle();
    expect(statuses.at(-1)).toEqual({ state: 'waiting', retryInMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    sockets[2]?.open();
    await settle();
    sockets[2]?.drop(1011);
    await settle();
    expect(statuses.at(-1)).toEqual({ state: 'waiting', retryInMs: 1000 });
    connection.stop();
  });
});

describe('DeviceConnection', () => {
  it('offers the device subprotocol and token, says hello first, then heartbeats every 15 s', async () => {
    const { connection, sockets, statuses } = setup();
    connection.start();
    await settle();
    const socket = sockets[0];
    expect(socket?.url).toBe('ws://gateway.test/v1/devices/connect');
    expect(socket?.protocols).toEqual([DEVICE_SUBPROTOCOL, 'device-token']);
    socket?.open();
    await settle();
    expect(socket?.names()).toEqual(['hello']);
    expect(statuses.at(-1)).toEqual({ state: 'online' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket?.names()).toEqual(['hello', 'heartbeat']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socket?.names()).toEqual(['hello', 'heartbeat', 'heartbeat']);
    connection.stop();
  });

  it('passes the keys frame on and refuses a request outside the protocol', async () => {
    const { connection, deps, sockets } = setup();
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.receive({ type: 'keys', keys: { k1: btoa('key') } });
    expect(deps.onKeys).toHaveBeenCalledTimes(1);
    sockets[0]?.receive({ request_id: requestId, session_id: null, op: { name: 'eval' } });
    expect(deps.onRequest).not.toHaveBeenCalled();
    expect(sockets[0]?.sent.at(-1)).toMatchObject({ request_id: requestId, ok: false });
    connection.stop();
  });

  it('hands a request over the moment it arrives, and answers only on its own socket', async () => {
    const replies: ((reply: DeviceReply) => void)[] = [];
    const { connection, sockets } = setup({
      onRequest: (_request, reply) => {
        replies.push(reply);
      },
    });
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.receive({ request_id: requestId, session_id: null, op: { name: 'profile_clear' } });
    expect(replies).toHaveLength(1); // synchronously: the grant clock starts at receipt

    sockets[0]?.drop(1006);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]?.open();
    await settle();
    replies[0]?.({ request_id: requestId, ok: true, result: { kind: 'empty' }, error: null });
    expect(sockets[0]?.sent.map((f) => f.request_id).filter(Boolean)).toEqual([]);
    expect(sockets[1]?.sent.map((f) => f.request_id).filter(Boolean)).toEqual([]);
    connection.stop();
  });

  it('tells the executor on every close that the connection is gone', async () => {
    const { connection, deps, sockets } = setup();
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.drop(1006);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]?.drop(1006);
    await settle();
    expect(deps.onConnectionLost).toHaveBeenCalledTimes(2);
    connection.stop();
  });

  it('resume triggers reconnect', async () => {
    const { connection, sockets, power } = setup();
    connection.start();
    await settle();
    sockets[0]?.drop(1006);
    await settle();
    expect(sockets).toHaveLength(1);
    // Asleep in a 1 s backoff: waking reconnects at once, without waiting it out.
    power.emit('resume');
    await settle();
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    await settle();
    // A socket that looks open after sleep may be dead: unlocking replaces it now.
    power.emit('unlock-screen');
    await settle();
    expect(sockets[1]?.terminated).toBe(true);
    expect(sockets).toHaveLength(3);
    connection.stop();
  });

  it('suspend ends in-flight work before sleep and drops the socket; resume reconnects', async () => {
    const { connection, deps, sockets, power } = setup();
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    expect(deps.onConnectionLost).not.toHaveBeenCalled();
    // A grant received before the lid closes must not be pressed after it opens (§6.3).
    power.emit('suspend');
    expect(deps.onConnectionLost).toHaveBeenCalled();
    await settle();
    expect(sockets[0]?.terminated).toBe(true);
    power.emit('resume');
    await settle();
    expect(sockets).toHaveLength(2);
    connection.stop();
  });

  it('4403 gets a fresh token and reconnects at once', async () => {
    const { connection, deps, sockets } = setup();
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.drop(4403);
    await settle();
    expect(deps.invalidateToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(sockets).toHaveLength(2);
    expect(deps.token).toHaveBeenCalledTimes(2);
    connection.stop();
  });

  it.each([
    { code: 4401, reason: 'revoked' },
    { code: 4409, reason: 'replaced' },
    { code: 4400, reason: 'protocol' },
  ])('close $code stops reconnecting ($reason)', async ({ code, reason }) => {
    const { connection, sockets, statuses } = setup();
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.drop(code);
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ state: 'stopped', reason });
  });

  it('a token refused because the device was removed stops as revoked', async () => {
    const { connection, sockets, statuses } = setup({
      token: () => Promise.reject(new DeviceRevokedError()),
    });
    connection.start();
    await settle();
    expect(sockets).toHaveLength(0);
    expect(statuses.at(-1)).toEqual({ state: 'stopped', reason: 'revoked' });
  });

  it("a socket closed by pause never ends the next connection's work when its close lands late", async () => {
    const { connection, deps, sockets, statuses } = setup();
    connection.start();
    await settle();
    const old = sockets[0];
    if (old === undefined) throw new Error('no socket');
    old.deferClose = true;
    old.open();
    await settle();
    connection.stop(); // pause: the old connection's requests end now
    expect(deps.onConnectionLost).toHaveBeenCalledTimes(1);
    connection.start(); // unpause before the old close event arrives
    await settle();
    sockets[1]?.open();
    await settle();
    expect(statuses.at(-1)).toEqual({ state: 'online' });
    old.finishClose(); // the old socket's close finally lands
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.onConnectionLost).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.readyState).toBe(FakeSocket.OPEN);
    expect(statuses.at(-1)).toEqual({ state: 'online' });
    connection.stop();
  });

  it('says no hello with an unusable journal, and stops', async () => {
    const { connection, sockets, statuses } = setup({
      hello: () => Promise.reject(new JournalUnusableError('corrupt')),
    });
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    expect(sockets[0]?.sent).toEqual([]);
    expect(sockets[0]?.closedWith).toBe(1000);
    expect(statuses.at(-1)).toEqual({ state: 'stopped', reason: 'journal_unusable' });
  });
});

describe('revocation', () => {
  let userData: string;
  beforeEach(async () => {
    vi.useRealTimers();
    userData = await mkdtemp(join(tmpdir(), 'veyquo-revoked-'));
    const paths = appPaths(userData);
    await mkdir(join(paths.chromeProfile, 'Default'), { recursive: true });
    await writeFile(join(paths.chromeProfile, 'Default', 'Cookies'), 'sign-ins');
    await writeFile(paths.deviceKey, 'encrypted key');
    await writeFile(paths.device, '{}');
    await writeFile(paths.journal, '{}\n');
    await mkdir(join(paths.tmp, 'session'), { recursive: true });
  });
  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  async function revokedBy4401(confirm: () => Promise<boolean>): Promise<string[]> {
    vi.useFakeTimers();
    const wiped: Promise<void>[] = [];
    const { connection, sockets } = setup({
      onStatus: (status) => {
        if (status.state === 'stopped' && status.reason === 'revoked') {
          wiped.push(
            wipeRevokedDevice({
              paths: appPaths(userData),
              confirmDeleteProfile: confirm,
              stopChrome: () => Promise.resolve(),
            }),
          );
        }
      },
    });
    connection.start();
    await settle();
    sockets[0]?.open();
    await settle();
    sockets[0]?.drop(4401);
    await settle();
    vi.useRealTimers();
    await Promise.all(wiped);
    return (await readdir(userData)).sort();
  }

  it('close 4401 wipes credentials and profile after confirm', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    expect(await revokedBy4401(confirm)).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('close 4401 keeps the profile when the person says no, and wipes credentials anyway', async () => {
    expect(await revokedBy4401(() => Promise.resolve(false))).toEqual(['chrome-profile']);
  });
});
