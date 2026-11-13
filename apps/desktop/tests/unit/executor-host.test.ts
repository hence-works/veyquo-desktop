import type { DeviceOp, DeviceReply, DeviceRequest, SessionOpenOp } from '@veyquo/device-protocol';
import { MemoryJournal } from '@veyquo/local-executor/testing';
import { describe, expect, it, vi } from 'vitest';

import { ChromeUnavailableError } from '../../src/main/chrome/launch.ts';
import {
  ExecutorHost,
  type ExecutorHostDeps,
  type ExecutorLike,
  type VeyquoTabs,
} from '../../src/main/executor-host.ts';

const appId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
let next = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;

function request(op: DeviceOp, sessionId: string | null = null): DeviceRequest {
  return { request_id: uuid(), session_id: sessionId, op };
}

const ok = (
  req: DeviceRequest,
  result: DeviceReply['result'] = { kind: 'empty' },
): DeviceReply => ({
  request_id: req.request_id,
  ok: true,
  result,
  error: null,
});

class FakeExecutor implements ExecutorLike {
  readonly handled: DeviceRequest[] = [];
  busySessionId: string | null = null;
  takeOver = vi.fn(() => Promise.resolve());
  handBack = vi.fn(() => Promise.resolve());
  connectionLost = vi.fn(() => Promise.resolve());
  abortRunning = vi.fn();
  shutdown = vi.fn(() => Promise.resolve());

  handle(req: DeviceRequest): Promise<DeviceReply> {
    this.handled.push(req);
    if (req.op.name === 'session_open') {
      const sessionId = uuid();
      if (req.op.application_id !== null) this.busySessionId = sessionId;
      return Promise.resolve(ok(req, { kind: 'opened', session_id: sessionId, tab_ref: 'tab-1' }));
    }
    if (req.op.name === 'session_close') this.busySessionId = null;
    return Promise.resolve(ok(req));
  }
}

function setup(overrides: Partial<ExecutorHostDeps> = {}) {
  const executor = new FakeExecutor();
  const openSite = vi.fn(() => Promise.resolve());
  const setVisibility = vi.fn(() => Promise.resolve(true));
  const tabs: VeyquoTabs = { openSite, setVisibility };
  const closed: (() => void)[] = [];
  const journal = new MemoryJournal();
  const stopChrome = vi.fn(() => Promise.resolve());
  const deps: ExecutorHostDeps = {
    journal,
    startChrome: vi.fn(() =>
      Promise.resolve({
        executor,
        tabs,
        onClosed: (listener: () => void) => {
          closed.push(listener);
        },
        stop: stopChrome,
      }),
    ),
    confirmClearProfile: vi.fn(() => Promise.resolve(true)),
    clearProfile: vi.fn(() => Promise.resolve()),
    onActivity: vi.fn(),
    ...overrides,
  };
  const host = new ExecutorHost(deps);
  const chromeClosed = () => {
    for (const listener of closed) listener();
  };
  return { host, deps, executor, openSite, setVisibility, journal, stopChrome, chromeClosed };
}

const open = (applicationId: string | null = appId): SessionOpenOp => ({
  name: 'session_open',
  application_id: applicationId,
  chrome_mode: 'veyquo_profile',
  visibility: 'background',
  allowed_hosts: ['jobs.example.com'],
  proxy: null,
});

describe('ExecutorHost', () => {
  it('session_open launches Chrome once and routes the session to its executor', async () => {
    const { host, deps, executor } = setup();
    const opened = await host.handle(request(open()));
    expect(opened.result).toMatchObject({ kind: 'opened' });
    const sessionId = opened.result?.kind === 'opened' ? opened.result.session_id : '';
    await host.handle(request({ name: 'inspect' }, sessionId));
    expect(deps.startChrome).toHaveBeenCalledTimes(1);
    expect(executor.handled.map((r) => r.op.name)).toEqual(['session_open', 'inspect']);
  });

  it('launches the managed profile with the account proxy', async () => {
    const { host, deps } = setup();
    const proxy = {
      endpoint: 'http://proxy.example:8080',
      protocol: 'http' as const,
      username: 'owner',
      password: 'secret',
    };
    const reply = await host.handle(request({ ...open(), proxy }));
    expect(reply.ok).toBe(true);
    expect(deps.startChrome).toHaveBeenCalledWith(proxy);
  });

  it('ends a proxied Chrome session before reopening the normal managed profile', async () => {
    const { host, deps, stopChrome } = setup();
    const opened = await host.handle(
      request({
        ...open(),
        proxy: {
          endpoint: 'http://proxy.example:8080',
          protocol: 'http',
          username: null,
          password: null,
        },
      }),
    );
    const sessionId = opened.result?.kind === 'opened' ? opened.result.session_id : '';
    await host.handle(request({ name: 'session_close' }, sessionId));
    expect(stopChrome).toHaveBeenCalledTimes(1);
    await host.handle(request({ name: 'profile_open_site', url: 'https://jobs.example.com/' }));
    expect(deps.startChrome).toHaveBeenNthCalledWith(2, null);
  });

  it('closes the proxy browser when the device connection ends', async () => {
    const { host, stopChrome } = setup();
    await host.handle(
      request({
        ...open(),
        proxy: {
          endpoint: 'http://proxy.example:8080',
          protocol: 'http',
          username: null,
          password: null,
        },
      }),
    );
    await host.connectionLost();
    expect(stopChrome).toHaveBeenCalledTimes(1);
  });

  it('refuses to route everyday Chrome through an account proxy', async () => {
    const { host, deps } = setup();
    const reply = await host.handle(
      request({
        ...open(),
        chrome_mode: 'everyday_profile',
        proxy: {
          endpoint: 'http://proxy.example:8080',
          protocol: 'http',
          username: null,
          password: null,
        },
      }),
    );
    expect(reply).toMatchObject({ ok: false, error: { type: 'chrome_unavailable' } });
    expect(deps.startChrome).not.toHaveBeenCalled();
  });

  it('refuses a malformed account proxy before starting Chrome', async () => {
    const { host, deps } = setup();
    const reply = await host.handle(
      request({
        ...open(),
        proxy: {
          endpoint: 'http://owner:secret@proxy.example:8080',
          protocol: 'http',
          username: null,
          password: null,
        },
      }),
    );
    expect(reply).toMatchObject({ ok: false, error: { type: 'chrome_unavailable' } });
    expect(deps.startChrome).not.toHaveBeenCalled();
  });

  it('hands a session request to the executor the moment it arrives', async () => {
    const { host, executor } = setup();
    const opened = await host.handle(request(open()));
    const sessionId = opened.result?.kind === 'opened' ? opened.result.session_id : '';
    const click = request(
      { name: 'click', control: { index: 0, kind: 'next', label: 'Next', ref: '42' }, grant: null },
      sessionId,
    );
    void host.handle(click);
    // Synchronously, before any await: the grant's lifetime counts from receipt.
    expect(executor.handled.at(-1)).toBe(click);
  });

  it('missing Chrome answers chrome_unavailable', async () => {
    const { host } = setup({
      startChrome: () => Promise.reject(new ChromeUnavailableError('missing')),
    });
    const reply = await host.handle(request(open()));
    expect(reply).toMatchObject({ ok: false, error: { type: 'chrome_unavailable' } });
  });

  it('a request for a session Chrome no longer has is tab_closed', async () => {
    const { host } = setup();
    const reply = await host.handle(request({ name: 'inspect' }, uuid()));
    expect(reply).toMatchObject({ ok: false, error: { type: 'tab_closed' } });
  });

  it('profile_open_site opens the site in the Veyquo profile with no application', async () => {
    const { host, openSite, executor } = setup();
    const reply = await host.handle(
      request({ name: 'profile_open_site', url: 'https://jobs.example.com/login' }),
    );
    expect(reply).toMatchObject({ ok: true, result: { kind: 'empty' } });
    expect(openSite).toHaveBeenCalledWith('https://jobs.example.com/login');
    expect(executor.handled).toEqual([]);
  });

  it.each(['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'not a url'])(
    'profile_open_site never opens %s',
    async (url) => {
      const { host, openSite } = setup();
      const reply = await host.handle(request({ name: 'profile_open_site', url }));
      expect(reply).toMatchObject({ ok: false, error: { type: 'tab_not_permitted' } });
      expect(openSite).not.toHaveBeenCalled();
    },
  );

  it('profile_clear wipes the Veyquo profile after the person confirms', async () => {
    const { host, deps, stopChrome } = setup();
    await host.handle(request({ name: 'profile_open_site', url: 'https://jobs.example.com/' }));
    const reply = await host.handle(request({ name: 'profile_clear' }));
    expect(reply.ok).toBe(true);
    expect(deps.confirmClearProfile).toHaveBeenCalledTimes(1);
    expect(stopChrome).toHaveBeenCalled();
    expect(deps.clearProfile).toHaveBeenCalledTimes(1);
  });

  it('profile_clear keeps the sign-ins when the person says no', async () => {
    const { host, deps } = setup({ confirmClearProfile: () => Promise.resolve(false) });
    const reply = await host.handle(request({ name: 'profile_clear' }));
    expect(reply).toMatchObject({ ok: false, error: { type: 'cancelled' } });
    expect(deps.clearProfile).not.toHaveBeenCalled();
  });

  it('profile_clear is busy while an application runs', async () => {
    const { host, deps } = setup();
    await host.handle(request(open()));
    const reply = await host.handle(request({ name: 'profile_clear' }));
    expect(reply).toMatchObject({ ok: false, error: { type: 'busy' } });
    expect(deps.confirmClearProfile).not.toHaveBeenCalled();
  });

  it('journal_ack without Chrome acknowledges in the journal', async () => {
    const { host, journal, deps } = setup();
    const grant = uuid();
    await journal.record({
      grant_id: grant,
      application_id: appId,
      state: 'clicked',
      signals_after: null,
    });
    const reply = await host.handle(
      request({ name: 'journal_ack', grant_ids: [grant.toUpperCase()] }),
    );
    expect(reply.ok).toBe(true);
    expect(await journal.unacknowledged()).toEqual([]);
    expect(deps.startChrome).not.toHaveBeenCalled();
  });

  it('a lost connection reaches the executor', async () => {
    const { host, executor } = setup();
    await host.handle(request(open()));
    await host.connectionLost();
    expect(executor.connectionLost).toHaveBeenCalledTimes(1);
  });

  it('take over, hand back and the visibility toggle act on the application session', async () => {
    const { host, executor, setVisibility, deps } = setup();
    await host.handle(request(open()));
    const sessionId = executor.busySessionId ?? '';
    await host.takeOver();
    await host.handBack();
    await host.setVisibility('visible');
    expect(executor.takeOver).toHaveBeenCalledWith(sessionId);
    expect(executor.handBack).toHaveBeenCalledWith(sessionId);
    expect(setVisibility).toHaveBeenCalledWith('tab-1', 'visible');
    expect(deps.onActivity).toHaveBeenLastCalledWith({
      kind: 'applying',
      sessionId,
      takenOver: false,
      visibility: 'visible',
      chromeMode: 'veyquo_profile',
    });
  });

  it('Chrome closing drops its executor; the next request starts Chrome again', async () => {
    const { host, deps, chromeClosed, executor } = setup();
    await host.handle(request(open()));
    chromeClosed();
    expect(executor.shutdown).toHaveBeenCalled();
    await host.handle(request(open(null)));
    expect(deps.startChrome).toHaveBeenCalledTimes(2);
  });
});

/** The everyday profile's executor over the extension (native-host/extension-transport.ts). */
function everydayChrome() {
  const executor = new FakeExecutor();
  const closed: (() => void)[] = [];
  const stop = vi.fn(() => Promise.resolve());
  const chrome = {
    executor,
    tabs: {
      openSite: vi.fn(() => Promise.reject(new Error('not in the everyday profile'))),
      setVisibility: vi.fn(() => Promise.resolve(false)),
    },
    onClosed: (listener: () => void) => {
      closed.push(listener);
    },
    stop,
  };
  return {
    chrome,
    executor,
    stop,
    extensionGone: () => {
      for (const listener of closed) listener();
    },
  };
}

const everydayOpen = (applicationId: string | null = appId): SessionOpenOp => ({
  ...open(applicationId),
  chrome_mode: 'everyday_profile',
});

describe('ExecutorHost in the everyday profile', () => {
  it('routes an everyday-profile session to the extension’s executor, never launching Chrome', async () => {
    const everyday = everydayChrome();
    const { host, deps, executor } = setup({ startEveryday: () => everyday.chrome });
    const opened = await host.handle(request(everydayOpen()));
    expect(opened.result).toMatchObject({ kind: 'opened' });
    const sessionId = opened.result?.kind === 'opened' ? opened.result.session_id : '';
    const inspect = request({ name: 'inspect' }, sessionId);
    void host.handle(inspect);
    expect(everyday.executor.handled.at(-1)).toBe(inspect); // on receipt, no await
    expect(deps.startChrome).not.toHaveBeenCalled();
    expect(executor.handled).toEqual([]);
    expect(host.busySessionId).toBe(everyday.executor.busySessionId);
  });

  it('answers chrome_unavailable while the extension is not connected', async () => {
    const { host, deps } = setup({ startEveryday: () => null });
    const reply = await host.handle(request(everydayOpen()));
    expect(reply).toMatchObject({ ok: false, error: { type: 'chrome_unavailable' } });
    expect(reply.error?.detail).toMatch(/extension/u);
    expect(deps.startChrome).not.toHaveBeenCalled();
  });

  it('runs one application at a time across both profiles', async () => {
    const everyday = everydayChrome();
    const { host } = setup({ startEveryday: () => everyday.chrome });
    await host.handle(request(open()));
    const second = await host.handle(request(everydayOpen()));
    expect(second).toMatchObject({ ok: false, error: { type: 'busy' } });
    expect(everyday.executor.handled).toEqual([]);
  });

  it('takeover from the extension reaches the executor running the session', async () => {
    const everyday = everydayChrome();
    const { host, deps } = setup({ startEveryday: () => everyday.chrome });
    await host.handle(request(everydayOpen()));
    const sessionId = everyday.executor.busySessionId ?? '';
    await host.takeOver();
    expect(everyday.executor.takeOver).toHaveBeenCalledWith(sessionId);
    expect(deps.onActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'applying', sessionId, takenOver: true }),
    );
    await host.handBack();
    expect(everyday.executor.handBack).toHaveBeenCalledWith(sessionId);
  });

  it('a cancel reaches whichever executor runs the request', async () => {
    const everyday = everydayChrome();
    const { host } = setup({ startEveryday: () => everyday.chrome });
    await host.handle(request(everydayOpen()));
    const cancel = request({ name: 'cancel', target_request_id: uuid() });
    expect((await host.handle(cancel)).ok).toBe(true);
    expect(everyday.executor.handled.at(-1)).toBe(cancel);
  });

  it('the extension going away drops its executor and ends the activity', async () => {
    const everyday = everydayChrome();
    let connected = true;
    const { host, deps } = setup({ startEveryday: () => (connected ? everyday.chrome : null) });
    const opened = await host.handle(request(everydayOpen()));
    const sessionId = opened.result?.kind === 'opened' ? opened.result.session_id : '';
    everyday.executor.busySessionId = null;
    connected = false;
    everyday.extensionGone();
    expect(everyday.executor.shutdown).toHaveBeenCalled();
    expect(deps.onActivity).toHaveBeenLastCalledWith({ kind: 'idle' });
    const reply = await host.handle(request({ name: 'inspect' }, sessionId));
    expect(reply).toMatchObject({ ok: false, error: { type: 'tab_closed' } });
    const again = await host.handle(request(everydayOpen()));
    expect(again).toMatchObject({ ok: false, error: { type: 'chrome_unavailable' } });
  });

  it('a lost gateway connection reaches both executors', async () => {
    const everyday = everydayChrome();
    const { host, executor } = setup({ startEveryday: () => everyday.chrome });
    await host.handle(request(open(null)));
    await host.handle(request(everydayOpen()));
    await host.connectionLost();
    expect(executor.connectionLost).toHaveBeenCalledTimes(1);
    expect(everyday.executor.connectionLost).toHaveBeenCalledTimes(1);
  });

  it('a lost connection aborts every executor before ending any session', async () => {
    const everyday = everydayChrome();
    const { host, executor } = setup({ startEveryday: () => everyday.chrome });
    await host.handle(request(open(null)));
    await host.handle(request(everydayOpen()));
    const ending = host.connectionLost();
    // Synchronously, before the first await: nothing either asked for runs on.
    expect(executor.abortRunning).toHaveBeenCalledTimes(1);
    expect(everyday.executor.abortRunning).toHaveBeenCalledTimes(1);
    await ending;
    const [abortedLast] = everyday.executor.abortRunning.mock.invocationCallOrder;
    const [endedFirst] = executor.connectionLost.mock.invocationCallOrder;
    expect(abortedLast).toBeLessThan(endedFirst ?? 0);
  });
});
