// Routes each `DeviceRequest` from the gateway (desktop plan §4.2, §5.4):
//
// - `session_open` goes to the `LocalExecutor` for the request's `chrome_mode`. The Veyquo
//   profile's Chrome is launched on first use and kept; if it closes, the next request
//   launches it again. The everyday profile runs over the Veyquo extension
//   (`native-host/extension-transport.ts`); while the extension is not connected it is
//   `chrome_unavailable`. One application runs at a time across both.
// - Every later request of a session goes to the executor that opened it, called at once:
//   a grant's lifetime counts from receipt (Task 7: `receivedAt` is taken in `handle`).
//   `cancel` goes to both executors: only the one running the target acts on it.
// - `profile_open_site` opens the site in the Veyquo profile with no application, for the
//   person to sign in. `profile_clear` wipes the Veyquo profile after the person confirms
//   on this computer, and never while an application runs.
// - `journal_ack` and `cancel` work without Chrome.
//
// It also gives the tray and window their view of the work: which application session is
// running, whether the person took it over, and where its window is.

import type {
  DeviceErrorType,
  DeviceEvent,
  DeviceProxy,
  DeviceReply,
  DeviceRequest,
  WindowVisibility,
} from '@veyquo/device-protocol';
import type { Journal } from '@veyquo/local-executor';

import { ChromeUnavailableError } from './chrome/launch.ts';

export interface ExecutorLike {
  handle(req: DeviceRequest): Promise<DeviceReply>;
  takeOver(sessionId: string): Promise<void>;
  handBack(sessionId: string): Promise<void>;
  connectionLost(): Promise<void>;
  /** Aborts every running operation synchronously. */
  abortRunning(): void;
  shutdown(): Promise<void>;
  readonly busySessionId: string | null;
}

/** The Veyquo-profile `CdpTabHost`, as far as the host uses it directly. */
export interface VeyquoTabs {
  openSite(url: string): Promise<void>;
  setVisibility(tabRef: string, visibility: WindowVisibility): Promise<boolean>;
}

export interface RunningChrome {
  executor: ExecutorLike;
  tabs: VeyquoTabs;
  onClosed(listener: () => void): void;
  /** Ends the executor's sessions and closes Chrome. */
  stop(): Promise<void>;
}

export type HostActivity =
  | { kind: 'idle' }
  | {
      kind: 'applying';
      sessionId: string;
      takenOver: boolean;
      visibility: WindowVisibility;
      chromeMode: 'veyquo_profile' | 'everyday_profile';
    };

export interface ExecutorHostDeps {
  journal: Journal;
  startChrome: (proxy: DeviceProxy | null) => Promise<RunningChrome>;
  /** The everyday profile's executor over the connected extension; null when the extension
   * is not connected. Called once per extension connection. */
  startEveryday?: () => RunningChrome | null;
  /** Asked on this computer: clear the sign-ins in Veyquo's Chrome profile? */
  confirmClearProfile: () => Promise<boolean>;
  /** Deletes the Veyquo Chrome profile (Chrome is closed first). */
  clearProfile: () => Promise<void>;
  onActivity: (activity: HostActivity) => void;
}

interface OpenSession {
  tabRef: string;
  applicationId: string | null;
  chrome: RunningChrome;
}

function refused(req: DeviceRequest, type: DeviceErrorType, detail: string): DeviceReply {
  return { request_id: req.request_id, ok: false, result: null, error: { type, detail } };
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function validProxy(proxy: DeviceProxy): boolean {
  try {
    const url = new URL(proxy.endpoint);
    return (
      url.protocol === `${proxy.protocol}:` &&
      url.hostname.length > 0 &&
      url.port.length > 0 &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      ((proxy.username === null && proxy.password === null) ||
        (proxy.username !== null && proxy.password !== null))
    );
  } catch {
    return false;
  }
}

function sameProxy(left: DeviceProxy | null, right: DeviceProxy | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.endpoint === right.endpoint &&
    left.protocol === right.protocol &&
    left.username === right.username &&
    left.password === right.password
  );
}

function done(req: DeviceRequest): DeviceReply {
  return { request_id: req.request_id, ok: true, result: { kind: 'empty' }, error: null };
}

export class ExecutorHost {
  private readonly deps: ExecutorHostDeps;
  private chrome: RunningChrome | null = null;
  private starting: Promise<RunningChrome> | null = null;
  private stopping: Promise<void> | null = null;
  private activeProxy: DeviceProxy | null = null;
  private everyday: RunningChrome | null = null;
  private readonly sessions = new Map<string, OpenSession>();
  private activity: HostActivity = { kind: 'idle' };

  constructor(deps: ExecutorHostDeps) {
    this.deps = deps;
  }

  get busySessionId(): string | null {
    return this.chrome?.executor.busySessionId ?? this.everyday?.executor.busySessionId ?? null;
  }

  get currentActivity(): HostActivity {
    return this.activity;
  }

  handle(req: DeviceRequest): Promise<DeviceReply> {
    const op = req.op;
    if (op.name === 'session_open') {
      if (op.application_id !== null && this.busySessionId !== null) {
        return Promise.resolve(refused(req, 'busy', 'another application session is open'));
      }
      if (op.chrome_mode === 'everyday_profile') {
        if (op.proxy !== null) {
          return Promise.resolve(
            refused(req, 'chrome_unavailable', 'proxy needs the Veyquo profile'),
          );
        }
        return this.openEveryday(req, op.application_id, op.visibility);
      }
      return this.open(req, op.application_id, op.visibility);
    }
    if (op.name === 'profile_open_site') return this.openSite(req, op.url);
    if (op.name === 'profile_clear') return this.clearProfile(req);
    if (op.name === 'cancel') {
      const executors = [this.chrome?.executor, this.everyday?.executor].filter(
        (e): e is ExecutorLike => e !== undefined,
      );
      if (executors.length === 0) return Promise.resolve(done(req));
      return Promise.all(executors.map((e) => e.handle(req))).then(([first]) => first ?? done(req));
    }
    if (op.name === 'journal_ack') {
      const executor = this.chrome?.executor ?? this.everyday?.executor;
      if (executor !== undefined) return executor.handle(req);
      return this.deps.journal
        .acknowledge(op.grant_ids.map((id) => id.toLowerCase()))
        .then(() => done(req));
    }
    // A session's request: straight to its executor, with no await before `handle`.
    const known = req.session_id === null ? undefined : this.sessions.get(req.session_id);
    const executor = known?.chrome.executor ?? this.chrome?.executor;
    if (executor === undefined || req.session_id === null) {
      return Promise.resolve(refused(req, 'tab_closed', 'no such session on this device'));
    }
    const reply = executor.handle(req);
    if (op.name === 'session_close') {
      const sessionId = req.session_id;
      return reply.then(async (result) => {
        this.sessions.delete(sessionId);
        this.refreshActivity();
        if (this.activeProxy !== null && this.busySessionId === null) await this.stopChrome();
        return result;
      });
    }
    return reply;
  }

  /** Every executor event passes here on its way to the gateway. */
  observe(event: DeviceEvent): void {
    if (event.name === 'takeover' && this.activity.kind === 'applying') {
      if (event.session_id === this.activity.sessionId) {
        this.setActivity({ ...this.activity, takenOver: event.state === 'taken' });
      }
    } else if (event.name === 'tab_closed') {
      this.sessions.delete(event.session_id);
      this.refreshActivity();
      if (this.activeProxy !== null && this.busySessionId === null) void this.stopChrome();
    }
  }

  async connectionLost(): Promise<void> {
    // Every executor's operations stop before any session cleanup is awaited (§6.3).
    this.chrome?.executor.abortRunning();
    this.everyday?.executor.abortRunning();
    await this.chrome?.executor.connectionLost();
    await this.everyday?.executor.connectionLost();
    this.sessions.clear();
    this.refreshActivity();
    if (this.activeProxy !== null) await this.stopChrome();
  }

  /** The person takes the agent's window over (tray, window or banner). */
  /** The person takes the agent's window over (tray, window, banner or the extension's
   * popup), whichever profile it is in. */
  async takeOver(): Promise<void> {
    const session = this.applyingSession();
    if (session === null) return;
    await session.chrome.executor.takeOver(session.id);
    this.updateApplying(session.id, { takenOver: true });
  }

  async handBack(): Promise<void> {
    const session = this.applyingSession();
    if (session === null) return;
    await session.chrome.executor.handBack(session.id);
    this.updateApplying(session.id, { takenOver: false });
  }

  /** The per-session visibility toggle. */
  async setVisibility(visibility: WindowVisibility): Promise<void> {
    const session = this.applyingSession();
    if (session === null) return;
    const { id: sessionId } = session;
    if (await session.chrome.tabs.setVisibility(session.tabRef, visibility)) {
      this.updateApplying(sessionId, { visibility });
    }
  }

  /** Closes Chrome (pause, removal, quit). */
  async stopChrome(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.stopping = (async () => {
      const chrome = this.chrome ?? (await this.starting?.catch(() => null)) ?? null;
      this.chrome = null;
      this.starting = null;
      this.activeProxy = null;
      this.dropSessionsOf(chrome);
      await chrome?.stop();
      this.refreshActivity();
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  // --- internals ---------------------------------------------------------------------

  private async ensureChrome(proxy: DeviceProxy | null = null): Promise<RunningChrome> {
    if (this.stopping !== null) await this.stopping;
    if (this.starting !== null) await this.starting;
    if (this.chrome !== null && !sameProxy(this.activeProxy, proxy)) {
      if (this.busySessionId !== null) {
        throw new ChromeUnavailableError('failed_to_start');
      }
      await this.stopChrome();
    }
    if (this.chrome !== null) return this.chrome;
    this.starting ??= this.deps.startChrome(proxy).then(
      (chrome) => {
        this.chrome = chrome;
        this.activeProxy = proxy;
        this.starting = null;
        chrome.onClosed(() => {
          if (this.chrome !== chrome) return;
          this.chrome = null;
          this.activeProxy = null;
          this.dropSessionsOf(chrome);
          void chrome.executor.shutdown();
          this.refreshActivity();
        });
        return chrome;
      },
      (error: unknown) => {
        this.starting = null;
        throw error;
      },
    );
    return this.starting;
  }

  private async withChrome(
    req: DeviceRequest,
    work: (chrome: RunningChrome) => Promise<DeviceReply>,
    proxy: DeviceProxy | null = null,
  ): Promise<DeviceReply> {
    let chrome: RunningChrome;
    try {
      chrome = await this.ensureChrome(proxy);
    } catch (error) {
      const detail =
        error instanceof ChromeUnavailableError ? error.message : 'Chrome could not be started';
      return refused(req, 'chrome_unavailable', detail);
    }
    return work(chrome);
  }

  private open(
    req: DeviceRequest,
    applicationId: string | null,
    visibility: WindowVisibility,
  ): Promise<DeviceReply> {
    const proxy = req.op.name === 'session_open' ? req.op.proxy : null;
    if (proxy !== null && !validProxy(proxy)) {
      return Promise.resolve(refused(req, 'chrome_unavailable', 'the account proxy is invalid'));
    }
    return this.withChrome(
      req,
      (chrome) => this.openIn(chrome, req, applicationId, visibility, 'veyquo_profile'),
      proxy,
    );
  }

  private openEveryday(
    req: DeviceRequest,
    applicationId: string | null,
    visibility: WindowVisibility,
  ): Promise<DeviceReply> {
    const everyday = this.ensureEveryday();
    if (everyday === null) {
      return Promise.resolve(
        refused(req, 'chrome_unavailable', 'the Veyquo extension is not connected'),
      );
    }
    return this.openIn(everyday, req, applicationId, visibility, 'everyday_profile');
  }

  private async openIn(
    chrome: RunningChrome,
    req: DeviceRequest,
    applicationId: string | null,
    visibility: WindowVisibility,
    chromeMode: 'veyquo_profile' | 'everyday_profile',
  ): Promise<DeviceReply> {
    const reply = await chrome.executor.handle(req);
    if (reply.ok && reply.result?.kind === 'opened') {
      const { session_id: sessionId, tab_ref: tabRef } = reply.result;
      this.sessions.set(sessionId, { tabRef, applicationId, chrome });
      if (applicationId !== null) {
        this.setActivity({
          kind: 'applying',
          sessionId,
          takenOver: false,
          visibility,
          chromeMode,
        });
      }
    }
    return reply;
  }

  /** The everyday profile's executor for the extension connected now, made once per
   * connection and dropped when the extension goes away. */
  private ensureEveryday(): RunningChrome | null {
    if (this.everyday !== null) return this.everyday;
    const everyday = this.deps.startEveryday?.() ?? null;
    if (everyday === null) return null;
    this.everyday = everyday;
    everyday.onClosed(() => {
      if (this.everyday !== everyday) return;
      this.everyday = null;
      this.dropSessionsOf(everyday);
      void everyday.executor.shutdown();
      this.refreshActivity();
    });
    return everyday;
  }

  private applyingSession(): (OpenSession & { id: string }) | null {
    if (this.activity.kind !== 'applying') return null;
    const session = this.sessions.get(this.activity.sessionId);
    return session === undefined ? null : { ...session, id: this.activity.sessionId };
  }

  private dropSessionsOf(chrome: RunningChrome | null): void {
    if (chrome === null) return;
    for (const [id, session] of this.sessions) {
      if (session.chrome === chrome) this.sessions.delete(id);
    }
  }

  private openSite(req: DeviceRequest, url: string): Promise<DeviceReply> {
    // Only a web page, checked here as well as in the cloud: never a file or browser page.
    if (!isWebUrl(url)) {
      return Promise.resolve(refused(req, 'tab_not_permitted', 'only a web page can be opened'));
    }
    return this.withChrome(req, async (chrome) => {
      try {
        await chrome.tabs.openSite(url);
      } catch {
        return refused(req, 'chrome_unavailable', 'Chrome would not open the site');
      }
      return done(req);
    });
  }

  private async clearProfile(req: DeviceRequest): Promise<DeviceReply> {
    if (this.busySessionId !== null) {
      return refused(req, 'busy', 'an application is running on this computer');
    }
    if (!(await this.deps.confirmClearProfile())) {
      return refused(req, 'cancelled', 'the person kept the sign-ins on this computer');
    }
    await this.stopChrome();
    try {
      await this.deps.clearProfile();
    } catch {
      return refused(req, 'internal', 'the profile could not be deleted');
    }
    return done(req);
  }

  private refreshActivity(): void {
    if (this.activity.kind === 'applying') {
      const busy = this.busySessionId;
      if (busy !== this.activity.sessionId || !this.sessions.has(busy)) {
        this.setActivity({ kind: 'idle' });
      }
    }
  }

  /** Changes the application activity, if that session is still the one running. */
  private updateApplying(
    sessionId: string,
    patch: Partial<{ takenOver: boolean; visibility: WindowVisibility }>,
  ): void {
    const current = this.activity;
    if (current.kind === 'applying' && current.sessionId === sessionId) {
      this.setActivity({ ...current, ...patch });
    }
  }

  private setActivity(activity: HostActivity): void {
    this.activity = activity;
    this.deps.onActivity(activity);
  }
}
