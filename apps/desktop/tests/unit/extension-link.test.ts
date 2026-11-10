import { MemoryJournal } from '@veyquo/local-executor/testing';
import { RelayClosedError } from '@veyquo/local-executor/extension';
import { describe, expect, it, vi } from 'vitest';

import {
  ExtensionHub,
  IpcRelayLink,
  everydayChrome,
} from '../../src/main/native-host/extension-transport.ts';
import type { IpcConnection, IpcFrame } from '../../src/main/native-ipc.ts';
import { AppTempFiles } from '../../src/main/temp-files.ts';

class FakeConnection implements IpcConnection {
  readonly sent: IpcFrame[] = [];
  closed = false;
  private frameHandlers: ((frame: IpcFrame) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  send(frame: IpcFrame): void {
    this.sent.push(frame);
  }
  onFrame(handler: (frame: IpcFrame) => void): void {
    this.frameHandlers.push(handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
  /** A frame from the extension. */
  deliver(frame: IpcFrame): void {
    for (const handler of this.frameHandlers) handler(frame);
  }
}

describe('IpcRelayLink', () => {
  it('answers a request with the reply of the same id', async () => {
    const connection = new FakeConnection();
    const link = new IpcRelayLink(connection);
    const reply = link.request({ kind: 'cdp.attach', payload: { tab_id: 3 } });
    const sent = connection.sent.at(-1);
    expect(sent).toMatchObject({ kind: 'cdp.attach', payload: { tab_id: 3 } });
    connection.deliver({ id: 'other', kind: 'reply', payload: { ok: true, result: 1 } });
    connection.deliver({ id: sent?.id ?? '', kind: 'reply', payload: { ok: true, result: {} } });
    await expect(reply).resolves.toEqual({ ok: true, result: {} });
  });

  it('fails what is waiting when the connection closes, and refuses new requests', async () => {
    const connection = new FakeConnection();
    const link = new IpcRelayLink(connection);
    const waiting = link.request({ kind: 'tabs.open', payload: { visibility: 'visible' } });
    connection.close();
    await expect(waiting).rejects.toThrow(RelayClosedError);
    await expect(link.request({ kind: 'cdp.detach', payload: { tab_id: 1 } })).rejects.toThrow(
      RelayClosedError,
    );
    expect(link.closed).toBe(true);
  });

  it('passes on well-formed events only', () => {
    const connection = new FakeConnection();
    const link = new IpcRelayLink(connection);
    const events: unknown[] = [];
    link.onEvent((event) => events.push(event));
    connection.deliver({ id: 'e1', kind: 'tab_closed', payload: { tab_id: 4 } });
    connection.deliver({ id: 'e2', kind: 'tab_closed', payload: { tab_id: 'four' } });
    connection.deliver({ id: 'e3', kind: 'shell', payload: {} });
    expect(events).toEqual([{ kind: 'tab_closed', payload: { tab_id: 4 } }]);
  });
});

function hub() {
  const onTakeover = vi.fn();
  const onConnected = vi.fn();
  return {
    hub: new ExtensionHub({
      onTakeover,
      onConnected,
      browserSettingsUrl: 'http://localhost:3400/app/settings/browser',
    }),
    onTakeover,
    onConnected,
  };
}

describe('ExtensionHub', () => {
  it('uses the first extension that connects and refuses another while it lasts', () => {
    const { hub: extensions, onConnected } = hub();
    const first = new FakeConnection();
    const second = new FakeConnection();
    extensions.accept(first);
    extensions.accept(second);
    expect(second.closed).toBe(true);
    expect(first.closed).toBe(false);
    expect(extensions.current?.link.closed).toBe(false);
    expect(onConnected).toHaveBeenLastCalledWith(true);
    first.close();
    expect(extensions.current).toBeNull();
    expect(onConnected).toHaveBeenLastCalledWith(false);
    const third = new FakeConnection();
    extensions.accept(third);
    expect(third.closed).toBe(false);
  });

  it('tells the extension what the app is doing, at once and on every change', () => {
    const { hub: extensions } = hub();
    extensions.setActivity('applying');
    const connection = new FakeConnection();
    extensions.accept(connection);
    expect(connection.sent[0]).toMatchObject({
      kind: 'state',
      payload: {
        activity: 'applying',
        browser_settings_url: 'http://localhost:3400/app/settings/browser',
      },
    });
    extensions.setActivity('taken_over');
    expect(connection.sent.at(-1)).toMatchObject({
      kind: 'state',
      payload: {
        activity: 'taken_over',
        browser_settings_url: 'http://localhost:3400/app/settings/browser',
      },
    });
  });

  it('refuses a settings link outside the Veyquo browser settings page', () => {
    for (const browserSettingsUrl of [
      'https://evil.example/app/settings/browser?token=secret',
      'http://evil.example/app/settings/browser',
      'https://veyquo.example/app/settings/browser/other',
    ]) {
      expect(
        () =>
          new ExtensionHub({
            onTakeover: () => undefined,
            onConnected: () => undefined,
            browserSettingsUrl,
          }),
      ).toThrow();
    }
  });

  it('a popup Take over or Hand back reaches the app', () => {
    const { hub: extensions, onTakeover } = hub();
    const connection = new FakeConnection();
    extensions.accept(connection);
    connection.deliver({ id: 'e1', kind: 'takeover', payload: { action: 'take_over' } });
    connection.deliver({ id: 'e2', kind: 'takeover', payload: { action: 'hand_back' } });
    expect(onTakeover.mock.calls).toEqual([['take_over'], ['hand_back']]);
  });

  it('builds the everyday executor over the connected extension, closed when it goes', async () => {
    const { hub: extensions } = hub();
    const connection = new FakeConnection();
    extensions.accept(connection);
    const current = extensions.current;
    if (current === null) throw new Error('not connected');
    const chrome = everydayChrome(current, {
      journal: new MemoryJournal(),
      tempFiles: new AppTempFiles('/nonexistent/veyquo-test-tmp'),
      grantKeys: () => new Map(),
      emit: () => undefined,
    });
    const closed = vi.fn();
    chrome.onClosed(closed);
    expect(await chrome.tabs.setVisibility('1', 'visible')).toBe(false);
    await expect(chrome.tabs.openSite('https://a.example/')).rejects.toThrow();
    connection.close();
    expect(closed).toHaveBeenCalledTimes(1);
    // Built after the extension went: closed at once.
    const late = vi.fn();
    chrome.onClosed(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
