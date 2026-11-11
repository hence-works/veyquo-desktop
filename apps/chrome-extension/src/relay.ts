// The extension's half of the relay to the desktop app (`@veyquo/local-executor`'s
// `extension-protocol.ts`), free of `chrome.*` so it can be unit-tested: `background.ts`
// gives it the browser (`BrowserApi`) and the native-messaging port, and feeds it Chrome's
// debugger and tab events.
//
// Every request names a tab, and the tab rules (`permissions.ts`) are checked here, before
// anything reaches `chrome.debugger`: a tab the agent did not open and the person did not
// approve is refused, whatever the app asks.
//
// Nothing from a page is logged, stored or shown: CDP results and events pass through.

import type { WindowVisibility } from '@veyquo/device-protocol';
import {
  executorCdpMethods,
  parseFrame,
  parseRequest,
  parseState,
  type AppActivity,
  type ExtensionEvent,
  type RelayError,
  type RelayFrame,
  type RelayReply,
  type RelayRequest,
} from '@veyquo/local-executor/extension-protocol';

import { TabPermissions } from './permissions.ts';

/** What the relay needs of Chrome. `background.ts` implements it with `chrome.*`. */
export interface BrowserApi {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send(tabId: number, method: string, params: object): Promise<unknown>;
  /** A new tab in the Veyquo window and tab group, never focused over the person's work. */
  openAgentTab(visibility: WindowVisibility): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  /** The tab's current URL, or null when it is gone. */
  tabUrl(tabId: number): Promise<string | null>;
  /** Marks the toolbar button while the agent asks the person for a tab. */
  setAttention(asking: boolean): void;
}

export interface ActiveTab {
  id: number;
  url: string;
}

/** What the popup shows. `tab` is about the person's active tab. */
export interface PopupStatus {
  connected: boolean;
  activity: AppActivity;
  browser_settings_url?: string;
  tab: 'agent' | 'granted' | 'grantable' | 'unavailable';
  /** The agent asked the person for a tab and is waiting. */
  asking: boolean;
}

type Post = (frame: RelayFrame) => void;

interface PendingAsk {
  id: string;
  timer: ReturnType<typeof setTimeout>;
}

const refusedTab: RelayError = {
  code: 'tab_not_permitted',
  message: 'Veyquo may not use this tab',
};

/** `chrome.debugger` rejects with Chrome's protocol error as JSON, or with its own text. */
export function relayErrorOf(error: unknown): RelayError {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === 'number') {
      const text = typeof parsed.message === 'string' ? parsed.message : '';
      return { code: 'cdp_error', message: text.slice(0, 200), cdp_code: parsed.code };
    }
  } catch {
    // Not JSON: one of chrome.debugger's own messages.
  }
  if (/no tab with|not attached|detached while|no target with/iu.test(message)) {
    return { code: 'tab_closed', message: 'the tab is gone' };
  }
  return { code: 'cdp_error', message: message.slice(0, 200) };
}

const ok = (result: unknown = {}): RelayReply => ({ ok: true, result });
const failed = (error: RelayError): RelayReply => ({ ok: false, error });

export class ExtensionRelay {
  private readonly browser: BrowserApi;
  private readonly version: string;
  private readonly onChange: () => void;
  private readonly permissions = new TabPermissions();
  private readonly attached = new Set<number>();
  private post: Post | null = null;
  /** The app has answered on this port: the native host reached it. */
  private appReady = false;
  private activity: AppActivity = 'idle';
  private browserSettingsUrl: string | null = null;
  private asking: PendingAsk | null = null;
  private nextEvent = 1;

  constructor(deps: { browser: BrowserApi; version: string; onChange?: () => void }) {
    this.browser = deps.browser;
    this.version = deps.version;
    this.onChange = deps.onChange ?? (() => undefined);
  }

  /** The app is on the other end: the port is open and the app has sent a frame. The
   * native host may start and then fail to reach the app, so an open port alone is not it. */
  get connected(): boolean {
    return this.post !== null && this.appReady;
  }

  /** The native-messaging port opened. */
  connect(post: Post): void {
    this.post = post;
    this.appReady = false;
    this.emit({ kind: 'hello', payload: { version: this.version } });
    this.onChange();
  }

  /** The port closed. Veyquo lets go of every tab; its grants end with the attempts. */
  disconnect(): void {
    this.post = null;
    this.appReady = false;
    for (const tabId of this.attached) void this.browser.detach(tabId).catch(() => undefined);
    this.attached.clear();
    this.permissions.clear();
    this.activity = 'idle';
    this.browserSettingsUrl = null;
    this.endAsking();
    this.onChange();
  }

  /** A frame from the app. */
  receive(raw: unknown): void {
    const post = this.post;
    const frame = parseFrame(raw);
    if (post === null || frame === null) return;
    if (!this.appReady) {
      this.appReady = true;
      this.onChange();
    }
    const state = parseState(frame);
    if (state !== null) {
      this.activity = state.activity;
      this.browserSettingsUrl = state.browser_settings_url ?? null;
      this.onChange();
      return;
    }
    const request = parseRequest(frame);
    if (request === null) {
      this.reply(post, frame.id, failed({ code: 'invalid', message: 'not a relay request' }));
      return;
    }
    if (request.kind === 'permission.request') {
      this.ask(frame.id, request.payload.timeout_ms);
      return;
    }
    void this.handle(request).then(
      (reply) => {
        this.reply(post, frame.id, reply);
      },
      (error: unknown) => {
        this.reply(post, frame.id, failed(relayErrorOf(error)));
      },
    );
  }

  // --- Chrome's events (background.ts) ---------------------------------------------

  /** A debugger event of an attached tab. A main-frame navigation is also where a grant's
   * page changes first (before `tabs.onUpdated`), so an approved tab that left its origin is
   * let go of here. */
  async debuggerEvent(tabId: number, method: string, params: unknown): Promise<void> {
    if (!this.attached.has(tabId)) return;
    this.emit({ kind: 'cdp.event', payload: { tab_id: tabId, method, params: params ?? {} } });
    if (method !== 'Page.frameNavigated') return;
    const frame = (params as { frame?: { parentId?: unknown; url?: unknown } } | null)?.frame;
    if (frame === undefined || frame.parentId !== undefined || typeof frame.url !== 'string') {
      return; // a subframe, or not a navigation the relay can read
    }
    await this.tabNavigated(tabId, frame.url);
  }

  debuggerDetached(tabId: number, reason: string): void {
    if (!this.attached.delete(tabId)) return;
    this.emit({ kind: 'cdp.detached', payload: { tab_id: tabId, reason } });
    // The person cancelled Chrome's debugging bar: an approved tab is theirs again.
    if (reason === 'canceled_by_user' && this.permissions.permit(tabId) === 'granted') {
      this.permissions.revoke(tabId);
      this.emit({ kind: 'permission.revoke', payload: { tab_id: tabId, reason: 'person' } });
    }
    this.onChange();
  }

  tabRemoved(tabId: number): void {
    const wasAttached = this.attached.delete(tabId);
    const permit = this.permissions.closed(tabId);
    if (wasAttached || permit !== null)
      this.emit({ kind: 'tab_closed', payload: { tab_id: tabId } });
  }

  /** The tab's main page changed to `url` (`chrome.tabs.onUpdated`). */
  async tabNavigated(tabId: number, url: string): Promise<void> {
    if (this.permissions.navigated(tabId, url) !== 'ended') return;
    await this.letGo(tabId);
    this.emit({ kind: 'permission.revoke', payload: { tab_id: tabId, reason: 'navigated' } });
    this.onChange();
  }

  // --- The popup ---------------------------------------------------------------------

  status(tab: ActiveTab | null): PopupStatus {
    const base = {
      connected: this.connected,
      activity: this.activity,
      asking: this.asking !== null,
      ...(this.connected && this.browserSettingsUrl !== null
        ? { browser_settings_url: this.browserSettingsUrl }
        : {}),
    };
    if (!this.connected || tab === null) return { ...base, tab: 'unavailable' };
    const permit = this.permissions.permit(tab.id);
    if (permit !== null) return { ...base, tab: permit };
    return { ...base, tab: /^https?:\/\//u.test(tab.url) ? 'grantable' : 'unavailable' };
  }

  /** "Let Veyquo use this tab". False when it cannot be approved. */
  grant(tab: ActiveTab): boolean {
    if (!this.connected || !this.permissions.grant(tab.id, tab.url)) return false;
    this.emit({ kind: 'permission.grant', payload: { tab_id: tab.id, url: tab.url } });
    const asking = this.asking;
    if (asking !== null && this.post !== null) {
      this.reply(this.post, asking.id, ok({ tab_id: tab.id, url: tab.url }));
    }
    this.endAsking();
    this.onChange();
    return true;
  }

  /** "Stop letting Veyquo use this tab". */
  async revoke(tabId: number): Promise<void> {
    if (!this.permissions.revoke(tabId)) return;
    await this.letGo(tabId);
    this.emit({ kind: 'permission.revoke', payload: { tab_id: tabId, reason: 'person' } });
    this.onChange();
  }

  /** "Not now" to the agent's request for a tab. */
  decline(): void {
    const asking = this.asking;
    if (asking !== null && this.post !== null) {
      this.reply(this.post, asking.id, failed({ code: 'declined', message: 'the person said no' }));
    }
    this.endAsking();
    this.onChange();
  }

  takeover(action: 'take_over' | 'hand_back'): void {
    this.emit({ kind: 'takeover', payload: { action } });
  }

  // --- internals ---------------------------------------------------------------------

  private async handle(request: Exclude<RelayRequest, { kind: 'permission.request' }>) {
    switch (request.kind) {
      case 'tabs.open': {
        const tabId = await this.browser.openAgentTab(request.payload.visibility);
        this.permissions.addAgentTab(tabId);
        return ok({ tab_id: tabId });
      }
      case 'tabs.close': {
        const tabId = request.payload.tab_id;
        const permit = this.permissions.permit(tabId);
        if (permit === null) return failed(refusedTab);
        if (permit === 'granted') {
          // Never the person's own tab: Veyquo only lets go of it.
          this.permissions.revoke(tabId);
          await this.letGo(tabId);
          return ok();
        }
        this.attached.delete(tabId);
        this.permissions.closed(tabId);
        await this.browser.closeTab(tabId);
        return ok();
      }
      case 'cdp.attach':
        return this.attach(request.payload.tab_id);
      case 'cdp.detach':
        if (this.attached.delete(request.payload.tab_id)) {
          await this.browser.detach(request.payload.tab_id);
        }
        return ok();
      case 'cdp.send': {
        const { tab_id: tabId, method, params } = request.payload;
        // Only what the executor sends: anything else is refused here, whatever the tab.
        if (!executorCdpMethods.has(method)) {
          return failed({ code: 'invalid', message: 'Veyquo does not send this command' });
        }
        if (!this.permissions.allows(tabId)) return failed(refusedTab);
        if (!this.attached.has(tabId)) {
          return failed({ code: 'tab_closed', message: 'the debugger is not attached' });
        }
        return ok(await this.browser.send(tabId, method, params));
      }
      case 'permission.revoke':
        if (this.permissions.revoke(request.payload.tab_id)) {
          await this.letGo(request.payload.tab_id);
          this.onChange();
        }
        return ok();
    }
  }

  private async attach(tabId: number): Promise<RelayReply> {
    const permit = this.permissions.permit(tabId);
    if (permit === null) return failed(refusedTab);
    if (permit === 'granted') {
      // The tab may have moved on before Chrome told us: check its page now.
      const url = await this.browser.tabUrl(tabId);
      if (url === null) {
        this.tabRemoved(tabId);
        return failed(refusedTab);
      }
      if (this.permissions.navigated(tabId, url) !== 'kept') {
        // A load to another site is under way: the grant ends now, and the app is told, as
        // `tabs.onUpdated` would have.
        this.permissions.revoke(tabId);
        await this.letGo(tabId);
        this.emit({ kind: 'permission.revoke', payload: { tab_id: tabId, reason: 'navigated' } });
        this.onChange();
        return failed(refusedTab);
      }
    }
    if (this.attached.has(tabId)) return ok();
    await this.browser.attach(tabId);
    if (!this.permissions.allows(tabId)) {
      // The grant ended while Chrome attached.
      await this.browser.detach(tabId).catch(() => undefined);
      return failed(refusedTab);
    }
    this.attached.add(tabId);
    return ok();
  }

  /** Detaches from a tab Veyquo no longer has, and says so. */
  private async letGo(tabId: number): Promise<void> {
    if (!this.attached.delete(tabId)) return;
    await this.browser.detach(tabId).catch(() => undefined);
    this.emit({ kind: 'cdp.detached', payload: { tab_id: tabId, reason: 'grant_ended' } });
  }

  private ask(id: string, timeoutMs: number): void {
    if (this.asking !== null) this.decline(); // one question at a time: the newest wins
    const timer = setTimeout(() => {
      if (this.asking?.id === id) this.decline();
    }, timeoutMs);
    this.asking = { id, timer };
    this.browser.setAttention(true);
    this.onChange();
  }

  private endAsking(): void {
    if (this.asking === null) return;
    clearTimeout(this.asking.timer);
    this.asking = null;
    this.browser.setAttention(false);
  }

  private emit(event: ExtensionEvent): void {
    this.post?.({ id: `e-${String(this.nextEvent++)}`, kind: event.kind, payload: event.payload });
  }

  private reply(post: Post, id: string, reply: RelayReply): void {
    // A reply for a connection that has gone is dropped: it would reach the next one.
    if (this.post !== post) return;
    post({ id, kind: 'reply', payload: reply });
  }
}
