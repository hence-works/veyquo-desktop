import { describe, expect, it } from 'vitest';

import { TabPermissions } from '../../src/permissions.ts';
import { FakeBrowser, connectedRelay, replyTo } from '../support/fakes.ts';

describe('TabPermissions', () => {
  it('grant ends on close', () => {
    const permissions = new TabPermissions();
    expect(permissions.grant(7, 'https://jobs.ats.example/apply')).toBe(true);
    expect(permissions.allows(7)).toBe(true);
    expect(permissions.closed(7)).toBe('granted');
    expect(permissions.allows(7)).toBe(false);
    expect(permissions.closed(7)).toBeNull();
  });

  it('grant ends on cross-origin navigation', () => {
    const permissions = new TabPermissions();
    permissions.grant(7, 'https://jobs.ats.example/apply');
    expect(permissions.navigated(7, 'https://jobs.ats.example/apply/step-2')).toBe('kept');
    expect(permissions.allows(7)).toBe(true);
    expect(permissions.navigated(7, 'https://login.other.example/')).toBe('ended');
    expect(permissions.allows(7)).toBe(false);
    // Coming back does not bring the grant back: the person approves again.
    expect(permissions.navigated(7, 'https://jobs.ats.example/apply')).toBe('none');
    expect(permissions.allows(7)).toBe(false);
  });

  it.each([
    { case: 'another scheme on the same host', url: 'http://jobs.ats.example/apply' },
    { case: 'another port', url: 'https://jobs.ats.example:8443/apply' },
    { case: 'a sibling subdomain', url: 'https://www.ats.example/' },
    { case: 'a browser page', url: 'chrome://settings' },
  ])('a grant ends on $case', ({ url }) => {
    const permissions = new TabPermissions();
    permissions.grant(7, 'https://jobs.ats.example/apply');
    expect(permissions.navigated(7, url)).toBe('ended');
  });

  it.each([
    { case: 'a browser page', url: 'chrome://settings' },
    {
      case: 'another extension',
      url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html',
    },
    { case: 'a local file', url: 'file:///home/ana/cv.pdf' },
    { case: 'not a URL', url: 'nope' },
  ])('never grants $case', ({ url }) => {
    const permissions = new TabPermissions();
    expect(permissions.grant(7, url)).toBe(false);
    expect(permissions.allows(7)).toBe(false);
  });

  it('an agent tab is the agent’s wherever it goes, until it closes', () => {
    const permissions = new TabPermissions();
    permissions.addAgentTab(3);
    expect(permissions.navigated(3, 'https://anywhere.example/')).toBe('kept');
    expect(permissions.permit(3)).toBe('agent');
    expect(permissions.grant(3, 'https://anywhere.example/')).toBe(false);
    expect(permissions.closed(3)).toBe('agent');
    expect(permissions.allows(3)).toBe(false);
  });

  it('the person can take a grant back', () => {
    const permissions = new TabPermissions();
    permissions.grant(7, 'https://ats.example/');
    expect(permissions.revoke(7)).toBe(true);
    expect(permissions.allows(7)).toBe(false);
    expect(permissions.revoke(7)).toBe(false);
  });
});

describe('the relay enforces tab permission locally', () => {
  it('requests for ungranted tabs are refused', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://mail.example/inbox');
    const { relay, sent } = connectedRelay(browser);
    for (const [kind, payload] of [
      ['cdp.attach', { tab_id: 5 }],
      ['cdp.send', { tab_id: 5, method: 'Runtime.evaluate', params: { expression: '1' } }],
      ['tabs.close', { tab_id: 5 }],
    ] as const) {
      relay.receive({ id: kind, kind, payload });
      expect(await replyTo(sent, kind)).toEqual({
        ok: false,
        error: { code: 'tab_not_permitted', message: 'Veyquo may not use this tab' },
      });
    }
    expect(browser.calls).toEqual([]);
  });

  it('a granted tab that moved to another site before the attach is refused', async () => {
    const browser = new FakeBrowser();
    browser.tabs.set(5, 'https://ats.example/apply');
    const { relay, sent } = connectedRelay(browser);
    relay.grant({ id: 5, url: 'https://ats.example/apply' });
    browser.tabs.set(5, 'https://elsewhere.example/'); // onUpdated not delivered yet
    relay.receive({ id: 'a', kind: 'cdp.attach', payload: { tab_id: 5 } });
    expect((await replyTo(sent, 'a')).ok).toBe(false);
    expect(browser.calls).toEqual([]);
  });
});
