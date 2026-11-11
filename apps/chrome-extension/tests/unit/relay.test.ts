import { describe, expect, it, vi } from 'vitest';

import { ExtensionRelay } from '../../src/relay.ts';
import { FakeBrowser, connectedRelay, eventsOf, replyTo } from '../support/fakes.ts';

describe('ExtensionRelay', () => {
  it('says hello when it connects', () => {
    const { sent } = connectedRelay();
    expect(sent[0]).toMatchObject({ kind: 'hello', payload: { version: '0.1.0' } });
  });

  it('opens an agent tab, attaches to it and relays its commands and events', async () => {
    const { relay, sent, browser } = connectedRelay();
    browser.answer = (method) => (method === 'Page.getFrameTree' ? { frameTree: {} } : {});
    relay.receive({ id: 'o', kind: 'tabs.open', payload: { visibility: 'background' } });
    const opened = await replyTo(sent, 'o');
    expect(opened).toEqual({ ok: true, result: { tab_id: 100 } });
    relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 100 } });
    expect(await replyTo(sent, 'a')).toEqual({ ok: true, result: {} });
    relay.receive({
      id: 's',
      kind: 'cdp.send',
      payload: { tab_id: 100, method: 'Page.getFrameTree', params: {} },
    });
    expect(await replyTo(sent, 's')).toEqual({ ok: true, result: { frameTree: {} } });
    await relay.debuggerEvent(100, 'Page.loadEventFired', { timestamp: 1 });
    await relay.debuggerEvent(555, 'Page.loadEventFired', { timestamp: 1 }); // not attached
    expect(eventsOf(sent, 'cdp.event')).toEqual([
      { tab_id: 100, method: 'Page.loadEventFired', params: { timestamp: 1 } },
    ]);
  });

  it('passes Chrome’s protocol error on with its code', async () => {
    const { relay, sent, browser } = connectedRelay();
    browser.answer = () => {
      throw new Error('{"code":-32000,"message":"Cannot not access browser-level commands"}');
    };
    relay.receive({ id: 'o', kind: 'tabs.open', payload: { visibility: 'visible' } });
    await replyTo(sent, 'o');
    relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 100 } });
    await replyTo(sent, 'a');
    relay.receive({
      id: 's',
      kind: 'cdp.send',
      payload: { tab_id: 100, method: 'Page.setDownloadBehavior', params: {} },
    });
    expect(await replyTo(sent, 's')).toEqual({
      ok: false,
      error: {
        code: 'cdp_error',
        message: 'Cannot not access browser-level commands',
        cdp_code: -32000,
      },
    });
  });

  it('a command for a tab the debugger is not attached to says so', async () => {
    const { relay, sent } = connectedRelay();
    relay.receive({ id: 'o', kind: 'tabs.open', payload: { visibility: 'visible' } });
    await replyTo(sent, 'o');
    relay.receive({
      id: 's',
      kind: 'cdp.send',
      payload: { tab_id: 100, method: 'Page.enable', params: {} },
    });
    expect(await replyTo(sent, 's')).toMatchObject({ ok: false, error: { code: 'tab_closed' } });
  });

  it.each([
    { case: 'an unknown kind', frame: { id: 'x', kind: 'shell.exec', payload: {} } },
    {
      case: 'a method that is not CDP',
      frame: { id: 'x', kind: 'cdp.send', payload: { tab_id: 1, method: 'rm -rf', params: {} } },
    },
    { case: 'no tab id', frame: { id: 'x', kind: 'cdp.attach', payload: {} } },
  ])('answers $case as invalid', async ({ frame }) => {
    const { relay, sent, browser } = connectedRelay();
    relay.receive(frame);
    expect(await replyTo(sent, 'x')).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(browser.calls).toEqual([]);
  });

  it('closing the tab emits tab_closed', async () => {
    const { relay, sent } = connectedRelay();
    relay.receive({ id: 'o', kind: 'tabs.open', payload: { visibility: 'visible' } });
    await replyTo(sent, 'o');
    relay.tabRemoved(100);
    relay.tabRemoved(999); // never Veyquo's
    expect(eventsOf(sent, 'tab_closed')).toEqual([{ tab_id: 100 }]);
  });

  it('a granted tab that leaves its site is detached and its grant ended', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://ats.example/apply');
    const { relay, sent } = connectedRelay(browser);
    relay.grant({ id: 5, url: 'https://ats.example/apply' });
    expect(eventsOf(sent, 'permission.grant')).toEqual([
      { tab_id: 5, url: 'https://ats.example/apply' },
    ]);
    relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 5 } });
    expect(await replyTo(sent, 'a')).toEqual({ ok: true, result: {} });
    browser.tabs.set(5, 'https://elsewhere.example/');
    await relay.tabNavigated(5, 'https://elsewhere.example/');
    expect(browser.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
    expect(eventsOf(sent, 'cdp.detached')).toEqual([{ tab_id: 5, reason: 'grant_ended' }]);
    expect(eventsOf(sent, 'permission.revoke')).toEqual([{ tab_id: 5, reason: 'navigated' }]);
    relay.receive({
      id: 's',
      kind: 'cdp.send',
      payload: { tab_id: 5, method: 'Page.enable', params: {} },
    });
    expect(await replyTo(sent, 's')).toMatchObject({
      ok: false,
      error: { code: 'tab_not_permitted' },
    });
  });

  it('closes an agent tab, and only lets go of a granted one', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://ats.example/apply');
    const { relay, sent } = connectedRelay(browser);
    relay.grant({ id: 5, url: 'https://ats.example/apply' });
    relay.receive({ id: 'c', kind: 'tabs.close', payload: { tab_id: 5 } });
    expect(await replyTo(sent, 'c')).toEqual({ ok: true, result: {} });
    expect(browser.calls.filter((c) => c.name === 'close')).toEqual([]);
    expect(relay.status({ id: 5, url: 'https://ats.example/apply' }).tab).toBe('grantable');
  });

  it('refuses a grant for the agent’s own tab or a page without a web origin', async () => {
    const { relay, sent } = connectedRelay();
    relay.receive({ id: 'o', kind: 'tabs.open', payload: { visibility: 'visible' } });
    await replyTo(sent, 'o');
    expect(relay.grant({ id: 100, url: 'https://ats.example/' })).toBe(false);
    expect(relay.grant({ id: 6, url: 'chrome://settings' })).toBe(false);
    expect(eventsOf(sent, 'permission.grant')).toEqual([]);
  });

  it('is not connected until the app itself answers through the host', () => {
    const relay = new ExtensionRelay({ browser: new FakeBrowser(), version: '0.1.0' });
    relay.connect(() => undefined);
    expect(relay.connected).toBe(false);
    relay.receive({ id: 's', kind: 'state', payload: { activity: 'idle' } });
    expect(relay.connected).toBe(true);
  });

  it('grants nothing while the app is not connected', () => {
    const relay = new ExtensionRelay({ browser: new FakeBrowser(), version: '0.1.0' });
    expect(relay.grant({ id: 6, url: 'https://ats.example/' })).toBe(false);
    expect(relay.status({ id: 6, url: 'https://ats.example/' })).toMatchObject({
      connected: false,
      tab: 'unavailable',
    });
  });

  it('answers the agent’s request for a tab with the one the person approves', async () => {
    const { relay, sent, browser } = connectedRelay();
    relay.receive({ id: 'p', kind: 'permission.request', payload: { timeout_ms: 60_000 } });
    expect(browser.attention).toBe(true);
    expect(relay.status(null).asking).toBe(true);
    relay.grant({ id: 8, url: 'https://ats.example/job' });
    expect(await replyTo(sent, 'p')).toEqual({
      ok: true,
      result: { tab_id: 8, url: 'https://ats.example/job' },
    });
    expect(browser.attention).toBe(false);
  });

  it('a request for a tab the person declines, or leaves unanswered, is declined', async () => {
    vi.useFakeTimers();
    try {
      const { relay, sent, browser } = connectedRelay();
      relay.receive({ id: 'p1', kind: 'permission.request', payload: { timeout_ms: 1000 } });
      relay.decline();
      relay.receive({ id: 'p2', kind: 'permission.request', payload: { timeout_ms: 1000 } });
      await vi.advanceTimersByTimeAsync(1001);
      for (const id of ['p1', 'p2']) {
        expect(sent.find((f) => f.id === id && f.kind === 'reply')?.payload).toMatchObject({
          ok: false,
          error: { code: 'declined' },
        });
      }
      expect(browser.attention).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takeover from the popup emits takeover, and the app’s state reaches the popup', () => {
    const { relay, sent } = connectedRelay();
    relay.receive({ id: 'st', kind: 'state', payload: { activity: 'applying' } });
    expect(relay.status(null).activity).toBe('applying');
    relay.takeover('take_over');
    relay.takeover('hand_back');
    expect(eventsOf(sent, 'takeover')).toEqual([{ action: 'take_over' }, { action: 'hand_back' }]);
  });

  it('shows the native app browser settings link only while connected', () => {
    const { relay } = connectedRelay();
    relay.receive({
      id: 'st',
      kind: 'state',
      payload: {
        activity: 'idle',
        browser_settings_url: 'http://localhost:3400/app/settings/browser',
      },
    });
    expect(relay.status(null).browser_settings_url).toBe(
      'http://localhost:3400/app/settings/browser',
    );
    relay.disconnect();
    expect(relay.status(null).browser_settings_url).toBeUndefined();
  });

  it('lets go of every tab when the app goes away, and answers nothing afterwards', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://ats.example/apply');
    const { relay, sent } = connectedRelay(browser);
    relay.grant({ id: 5, url: 'https://ats.example/apply' });
    relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 5 } });
    await replyTo(sent, 'a');
    relay.receive({ id: 'st', kind: 'state', payload: { activity: 'applying' } });
    relay.disconnect();
    expect(browser.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
    const before = sent.length;
    await relay.debuggerEvent(5, 'Page.loadEventFired', {});
    expect(sent.length).toBe(before);
    expect(relay.status({ id: 5, url: 'https://ats.example/apply' })).toMatchObject({
      connected: false,
      activity: 'idle',
      tab: 'unavailable',
    });
  });

  it('attach while pendingUrl is cross-origin emits permission.revoke', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://ats.example/apply');
    const { relay, sent } = connectedRelay(browser);
    relay.grant({ id: 5, url: 'https://ats.example/apply' });
    browser.tabs.set(5, 'https://elsewhere.example/'); // the load in flight, before onUpdated
    relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 5 } });
    expect(await replyTo(sent, 'a')).toMatchObject({
      ok: false,
      error: { code: 'tab_not_permitted' },
    });
    expect(eventsOf(sent, 'permission.revoke')).toEqual([{ tab_id: 5, reason: 'navigated' }]);
    expect(browser.calls).toEqual([]);
  });

  it('a second attach after the approved tab moved lets go of it and says so', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://ats.example/apply');
    const { relay, sent } = connectedRelay(browser);
    relay.grant({ id: 5, url: 'https://ats.example/apply' });
    relay.receive({ id: 'a1', kind: 'cdp.attach', payload: { tab_id: 5 } });
    await replyTo(sent, 'a1');
    browser.tabs.set(5, 'https://elsewhere.example/');
    relay.receive({ id: 'a2', kind: 'cdp.attach', payload: { tab_id: 5 } });
    expect((await replyTo(sent, 'a2')).ok).toBe(false);
    expect(browser.calls.at(-1)).toEqual({ name: 'detach', tabId: 5 });
    expect(eventsOf(sent, 'cdp.detached')).toEqual([{ tab_id: 5, reason: 'grant_ended' }]);
    expect(eventsOf(sent, 'permission.revoke')).toEqual([{ tab_id: 5, reason: 'navigated' }]);
  });

  it('a main-frame cross-origin Page.frameNavigated ends the grant before tabs.onUpdated', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://ats.example/apply');
    const { relay, sent } = connectedRelay(browser);
    relay.grant({ id: 5, url: 'https://ats.example/apply' });
    relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 5 } });
    await replyTo(sent, 'a');
    // A subframe elsewhere changes nothing.
    await relay.debuggerEvent(5, 'Page.frameNavigated', {
      frame: { id: 'ad', parentId: 'main', url: 'https://ads.example/' },
    });
    expect(eventsOf(sent, 'permission.revoke')).toEqual([]);
    await relay.debuggerEvent(5, 'Page.frameNavigated', {
      frame: { id: 'main', url: 'https://elsewhere.example/' },
    });
    expect(eventsOf(sent, 'permission.revoke')).toEqual([{ tab_id: 5, reason: 'navigated' }]);
    expect(eventsOf(sent, 'cdp.detached')).toEqual([{ tab_id: 5, reason: 'grant_ended' }]);
    relay.receive({
      id: 's',
      kind: 'cdp.send',
      payload: { tab_id: 5, method: 'Page.enable', params: {} },
    });
    expect(await replyTo(sent, 's')).toMatchObject({
      ok: false,
      error: { code: 'tab_not_permitted' },
    });
  });

  it.each([
    'Runtime.compileScript',
    'Network.getCookies',
    'Storage.getCookies',
    'Target.createTarget',
  ])(
    'refuses %s, which the executor never sends, without reaching the debugger',
    async (method) => {
      const { relay, sent, browser } = connectedRelay();
      relay.receive({ id: 'o', kind: 'tabs.open', payload: { visibility: 'visible' } });
      await replyTo(sent, 'o');
      relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 100 } });
      await replyTo(sent, 'a');
      relay.receive({ id: 's', kind: 'cdp.send', payload: { tab_id: 100, method, params: {} } });
      expect(await replyTo(sent, 's')).toMatchObject({ ok: false, error: { code: 'invalid' } });
      expect(browser.calls.filter((c) => c.name === 'send')).toEqual([]);
    },
  );
});
