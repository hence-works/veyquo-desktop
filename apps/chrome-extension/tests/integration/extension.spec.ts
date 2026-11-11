import type { DeviceEvent, DeviceOp, DeviceReply, DeviceRequest } from '@veyquo/device-protocol';
import { LocalExecutor } from '@veyquo/local-executor';
import { ExtensionTabHost, ExtensionTransport } from '@veyquo/local-executor/extension';
import { DirectoryTempFiles, MemoryJournal } from '@veyquo/local-executor/testing';
import { expect, test } from '@playwright/test';

import {
  fixtureServer,
  launch,
  openPopup,
  tabIdOf,
  type FixtureServer,
  type Harness,
} from '../support/browser.ts';

const appId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function request(op: DeviceOp, sessionId: string | null = null): DeviceRequest {
  return { request_id: crypto.randomUUID(), session_id: sessionId, op };
}

/** What the desktop app runs for the everyday profile: an executor over the extension. */
function everydayExecutor(harness: Harness) {
  const transport = new ExtensionTransport(harness.link);
  const tabs = new ExtensionTabHost(transport, harness.link);
  const events: DeviceEvent[] = [];
  const executor = new LocalExecutor({
    transport,
    tabs,
    journal: new MemoryJournal(),
    grantKeys: () => new Map(),
    tempFiles: new DirectoryTempFiles(),
    emit: (event) => events.push(event),
  });
  return { executor, events };
}

async function openSession(
  executor: LocalExecutor,
  hosts: string[],
  applicationId: string | null = appId,
): Promise<{ sessionId: string; tabId: number }> {
  const reply: DeviceReply = await executor.handle(
    request({
      name: 'session_open',
      application_id: applicationId,
      chrome_mode: 'everyday_profile',
      visibility: 'visible',
      allowed_hosts: hosts,
      proxy: null,
    }),
  );
  if (!reply.ok || reply.result?.kind !== 'opened') {
    throw new Error(`session_open failed: ${reply.error?.type ?? 'no result'}`);
  }
  return { sessionId: reply.result.session_id, tabId: Number(reply.result.tab_ref) };
}

async function waitForEvent(events: DeviceEvent[], match: (e: DeviceEvent) => boolean) {
  await expect.poll(() => events.some(match)).toBe(true);
  return events.find(match);
}

let fixtures: FixtureServer;
let harness: Harness;

test.beforeAll(async () => {
  fixtures = await fixtureServer();
});
test.afterAll(async () => {
  await fixtures.close();
});
test.beforeEach(async () => {
  harness = await launch();
});
test.afterEach(async () => {
  await harness.close();
});

test('attaches chrome.debugger only to agent tabs and granted tabs', async () => {
  const mine = await harness.context.newPage();
  const url = `${fixtures.origin}/form.html?person`;
  await mine.goto(url);
  const personTab = await tabIdOf(harness.worker, url);

  // The person's own tab, not approved: refused by the extension itself.
  const refused = await harness.link.request({
    kind: 'cdp.attach',
    payload: { tab_id: personTab },
  });
  expect(refused).toMatchObject({ ok: false, error: { code: 'tab_not_permitted' } });
  const command = await harness.link.request({
    kind: 'cdp.send',
    payload: { tab_id: personTab, method: 'Runtime.evaluate', params: { expression: '1' } },
  });
  expect(command).toMatchObject({ ok: false, error: { code: 'tab_not_permitted' } });

  // After the person approves it, it may be attached.
  await mine.bringToFront();
  const popup = await openPopup(harness);
  await popup.getByRole('button', { name: 'Let Veyquo use this tab' }).click();
  await harness.link.waitFor('permission.grant', (e) => e.payload.tab_id === personTab);
  const granted = await harness.link.request({
    kind: 'cdp.attach',
    payload: { tab_id: personTab },
  });
  expect(granted).toEqual({ ok: true, result: {} });

  // A tab the agent opened is its own.
  const opened = await harness.link.request({
    kind: 'tabs.open',
    payload: { visibility: 'background' },
  });
  expect(opened.ok).toBe(true);
  const agentTab = opened.ok ? (opened.result as { tab_id: number }).tab_id : -1;
  const attached = await harness.link.request({
    kind: 'cdp.attach',
    payload: { tab_id: agentTab },
  });
  expect(attached).toEqual({ ok: true, result: {} });

  // The approved tab leaves its site: the grant ends, and the debugger lets go.
  await harness.worker.evaluate(
    async ([tabId, target]) => {
      await chrome.tabs.update(tabId, { url: target });
    },
    [personTab, `${fixtures.otherOrigin}/other.html`] as const,
  );
  await harness.link.waitFor(
    'permission.revoke',
    (e) => e.payload.tab_id === personTab && e.payload.reason === 'navigated',
  );
  const after = await harness.link.request({
    kind: 'cdp.send',
    payload: { tab_id: personTab, method: 'Runtime.evaluate', params: { expression: '1' } },
  });
  expect(after).toMatchObject({ ok: false, error: { code: 'tab_not_permitted' } });
});

test('relays a CDP command and event through the native host', async () => {
  const { executor, events } = everydayExecutor(harness);
  const { sessionId } = await openSession(executor, ['127.0.0.1']);
  const navigated = await executor.handle(
    request({ name: 'navigate', url: `${fixtures.origin}/form.html`, owner: false }, sessionId),
  );
  expect(navigated).toMatchObject({ ok: true, result: { kind: 'signals' } });
  // The event: Page.frameNavigated came back through the extension and the host.
  await waitForEvent(events, (e) => e.name === 'navigation' && e.session_id === sessionId);
  const inspected = await executor.handle(request({ name: 'inspect' }, sessionId));
  expect(inspected.ok).toBe(true);
  expect(inspected.result?.kind === 'inspect' ? inspected.result.document_json : '').toContain(
    'Full name',
  );
  // The agent's tab sits in the Veyquo tab group.
  const group = await harness.worker.evaluate(async () => {
    const groups = await chrome.tabGroups.query({});
    return groups.map((g) => g.title);
  });
  expect(group).toContain('Veyquo');
  await executor.shutdown();
});

test('Let Veyquo use this tab grants the active tab', async () => {
  const mine = await harness.context.newPage();
  const url = `${fixtures.origin}/form.html?apply`;
  await mine.goto(url);
  const tabId = await tabIdOf(harness.worker, url);
  // The app's executor exists from the moment the extension connects (apps/desktop).
  const { executor } = everydayExecutor(harness);
  await mine.bringToFront();
  const popup = await openPopup(harness);
  await expect(popup.getByTestId('connection')).toHaveText('Connected to the Veyquo app');
  await popup.getByRole('button', { name: 'Let Veyquo use this tab' }).click();
  const grant = await harness.link.waitFor('permission.grant');
  expect(grant.payload).toEqual({ tab_id: tabId, url });
  await expect(popup.getByTestId('tab')).toContainText('Veyquo may use this tab');
  await expect(
    popup.getByRole('button', { name: 'Stop letting Veyquo use this tab' }),
  ).toBeFocused();

  // The next session for this site works in that tab, and never closes it.
  const session = await openSession(executor, ['127.0.0.1']);
  expect(session.tabId).toBe(tabId);
  await executor.handle(request({ name: 'session_close' }, session.sessionId));
  expect(mine.isClosed()).toBe(false);
  // The attempt ended, and its grant with it.
  const again = await harness.link.request({ kind: 'cdp.attach', payload: { tab_id: tabId } });
  expect(again).toMatchObject({ ok: false, error: { code: 'tab_not_permitted' } });
});

test('dismissing a tab request keeps keyboard focus on an available action', async () => {
  const mine = await harness.context.newPage();
  await mine.goto(`${fixtures.origin}/form.html?permission`);
  await mine.bringToFront();
  const requestReply = harness.link.request({
    kind: 'permission.request',
    payload: { timeout_ms: 60_000 },
  });
  const popup = await openPopup(harness);
  await popup.getByRole('button', { name: 'Not now' }).click();
  expect(await requestReply).toMatchObject({ ok: false, error: { code: 'declined' } });
  await expect(popup.getByRole('button', { name: 'Let Veyquo use this tab' })).toBeFocused();
});

test('popup gives proxy settings a visible path in a taller window', async () => {
  const settingsUrl = `${fixtures.origin}/app/settings/browser`;
  harness.link.tell('state', { activity: 'idle', browser_settings_url: settingsUrl });
  const popup = await openPopup(harness);
  await expect(popup.getByTestId('proxy')).toContainText('Veyquo profile only');
  await expect(popup.getByTestId('proxy')).toContainText('everyday Chrome keeps its own network');
  await expect(
    popup.getByRole('link', { name: 'Manage proxy settings (opens in a new tab)' }),
  ).toBeVisible();
  await expect(popup.getByTestId('proxy-settings')).toHaveAttribute('href', settingsUrl);
  expect(
    await popup.evaluate(() => document.body.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(540);
  expect(await popup.evaluate(() => document.body.getBoundingClientRect().width)).toBe(600);
  await harness.context.route(settingsUrl, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<title>Browser settings</title>',
    }),
  );
  const nextPage = harness.context.waitForEvent('page');
  await popup.getByTestId('proxy-settings').click();
  await expect(await nextPage).toHaveURL(settingsUrl);
});

test('closing the tab emits tab_closed', async () => {
  const { executor, events } = everydayExecutor(harness);
  const { sessionId, tabId } = await openSession(executor, ['127.0.0.1']);
  await executor.handle(
    request(
      { name: 'navigate', url: `${fixtures.origin}/form.html?close`, owner: false },
      sessionId,
    ),
  );
  const agentPage = harness.context.pages().find((p) => p.url().endsWith('form.html?close'));
  expect(agentPage).toBeDefined();
  await agentPage?.close(); // the person closes the agent's tab
  await harness.link.waitFor('tab_closed', (e) => e.payload.tab_id === tabId);
  await waitForEvent(events, (e) => e.name === 'tab_closed' && e.session_id === sessionId);
  const reply = await executor.handle(request({ name: 'signals' }, sessionId));
  expect(reply.error?.type).toBe('tab_closed');
});

test('takeover from the popup emits takeover/taken', async () => {
  const { executor, events } = everydayExecutor(harness);
  const { sessionId } = await openSession(executor, ['127.0.0.1']);
  // What the desktop app does with the popup's buttons (apps/desktop executor host).
  harness.link.onEvent((event) => {
    if (event.kind !== 'takeover') return;
    if (event.payload.action === 'take_over') {
      void executor.takeOver(sessionId).then(() => {
        harness.link.tell('state', { activity: 'taken_over' });
      });
    } else {
      void executor.handBack(sessionId).then(() => {
        harness.link.tell('state', { activity: 'applying' });
      });
    }
  });
  harness.link.tell('state', { activity: 'applying' });
  const popup = await openPopup(harness);
  await popup.getByRole('button', { name: 'Take over' }).click();
  const taken = await waitForEvent(events, (e) => e.name === 'takeover' && e.state === 'taken');
  expect(taken).toEqual({
    name: 'takeover',
    session_id: sessionId,
    state: 'taken',
    application_id: appId,
  });
  await expect(popup.getByRole('button', { name: 'Hand back' })).toBeFocused();
  await expect(popup.getByTestId('activity')).toContainText('You’ll submit it yourself.');
  await popup.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await expect(popup.locator('html')).toHaveClass('dark');
  await popup.setViewportSize({ width: 320, height: 600 });
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await popup.getByRole('button', { name: 'Hand back' }).click();
  await waitForEvent(events, (e) => e.name === 'takeover' && e.state === 'handed_back');
  await expect(popup.getByRole('button', { name: 'Take over' })).toBeFocused();
  await executor.shutdown();
});
