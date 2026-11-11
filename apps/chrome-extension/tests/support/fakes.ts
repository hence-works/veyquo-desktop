// A scripted browser for the relay's unit tests: no Chrome. Tabs are a map of id -> URL;
// every debugger and tab call is recorded.

import type { RelayFrame } from '@veyquo/local-executor/extension-protocol';

import { ExtensionRelay, type BrowserApi } from '../../src/relay.ts';

export interface BrowserCall {
  name: string;
  tabId?: number;
  method?: string;
}

export class FakeBrowser implements BrowserApi {
  readonly calls: BrowserCall[] = [];
  readonly tabs = new Map<number, string>();
  attention = false;
  /** The answer to every `send`; a function may throw like chrome.debugger does. */
  answer: (method: string, params: object) => unknown = () => ({});
  private nextTab = 100;

  attach(tabId: number): Promise<void> {
    this.calls.push({ name: 'attach', tabId });
    return this.tabs.has(tabId)
      ? Promise.resolve()
      : Promise.reject(new Error(`No tab with given id ${String(tabId)}.`));
  }

  detach(tabId: number): Promise<void> {
    this.calls.push({ name: 'detach', tabId });
    return Promise.resolve();
  }

  send(tabId: number, method: string, params: object): Promise<unknown> {
    this.calls.push({ name: 'send', tabId, method });
    try {
      return Promise.resolve(this.answer(method, params));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  openAgentTab(): Promise<number> {
    const id = this.nextTab++;
    this.tabs.set(id, 'about:blank');
    this.calls.push({ name: 'open', tabId: id });
    return Promise.resolve(id);
  }

  closeTab(tabId: number): Promise<void> {
    this.calls.push({ name: 'close', tabId });
    this.tabs.delete(tabId);
    return Promise.resolve();
  }

  tabUrl(tabId: number): Promise<string | null> {
    return Promise.resolve(this.tabs.get(tabId) ?? null);
  }

  setAttention(asking: boolean): void {
    this.attention = asking;
  }
}

export function connectedRelay(browser: FakeBrowser = new FakeBrowser()) {
  const relay = new ExtensionRelay({ browser, version: '0.1.0' });
  const sent: RelayFrame[] = [];
  relay.connect((frame) => sent.push(frame));
  // The app speaks first once the host reached it (`state`), as the desktop app does.
  relay.receive({ id: 'ready', kind: 'state', payload: { activity: 'idle' } });
  return { relay, sent, browser };
}

/** The reply to request `id`, once it is sent. */
export async function replyTo(sent: RelayFrame[], id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i += 1) {
    const frame = sent.find((f) => f.kind === 'reply' && f.id === id);
    if (frame !== undefined) return frame.payload as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`no reply to ${id}`);
}

export function eventsOf(sent: RelayFrame[], kind: string): unknown[] {
  return sent.filter((f) => f.kind === kind).map((f) => f.payload);
}
