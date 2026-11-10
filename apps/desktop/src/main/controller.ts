// The app's state machine, free of Electron so it can be tested: start-up checks, pairing,
// the connection, the executor host, pause, takeover, revocation and removal. `index.ts`
// gives it Electron's pieces (safeStorage, powerMonitor, dialogs, shell) and shows its
// `UiState` in the tray and the status window.

import type {
  DeviceEvent,
  DeviceProxy,
  DeviceReply,
  DeviceRequest,
  WindowVisibility,
} from '@veyquo/device-protocol';
import { helloEvent } from '@veyquo/local-executor';

import { ApiError, DeviceRevokedError, type DevicesApi } from './api.ts';
import { DeviceAuth } from './auth.ts';
import { AccessRequiredError, type AccessSession } from './access-session.ts';
import type { Autostart } from './autostart.ts';
import type { ChromeLocation } from './chrome/locate.ts';
import {
  DeviceConnection,
  type ConnectionStatus,
  type PowerEvents,
  type SocketLike,
} from './connection.ts';
import { ExecutorHost, type HostActivity, type RunningChrome } from './executor-host.ts';
import { DurableJournal } from './journal.ts';
import { SecureStorageUnavailableError, type DeviceKey, type Keystore } from './keystore.ts';
import { silentLogger, type Logger } from './log.ts';
import { PairingCancelledError, PairingExpiredError, pairDevice } from './pairing.ts';
import type { AppPaths } from './paths.ts';
import { removeFromComputer, wipeRevokedDevice } from './remove.ts';
import { AppTempFiles } from './temp-files.ts';
import { initialUiState, type AccessState, type Notice, type UiState } from '../shared/ui-state.ts';
import { rm } from 'node:fs/promises';

export type Confirmation = 'clear_profile' | 'revoked_profile' | 'remove';
/** Something the person is told, with nothing to decide. */
export type Information = 'removed_locally';

export interface ChromeContext {
  journal: DurableJournal;
  tempFiles: AppTempFiles;
  grantKeys: () => Map<string, Uint8Array>;
  emit: (event: DeviceEvent) => void;
}

export interface ControllerDeps {
  paths: AppPaths;
  access?: Pick<AccessSession, 'initialize' | 'ensure' | 'signIn' | 'signOut' | 'cancel' | 'close'>;
  appVersion: string;
  os: 'macos' | 'windows' | 'linux';
  /** Offered as the device's name when pairing (the person names it in the web app). */
  deviceName: string;
  keystore: Keystore;
  api: Pick<
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
  locateChrome: () => Promise<ChromeLocation>;
  /** Launches the Veyquo-profile Chrome and its `LocalExecutor`. */
  startChrome: (context: ChromeContext, proxy: DeviceProxy | null) => Promise<RunningChrome>;
  /** The everyday profile's executor over the connected Veyquo extension; null while it is
   * not connected. */
  startEveryday?: (context: ChromeContext) => RunningChrome | null;
  /** Ends a Chrome an earlier run left on the profile. */
  stopStaleChrome: () => Promise<void>;
  openSocket: (url: string, protocols: string[]) => SocketLike;
  power: PowerEvents;
  openExternal: (url: string) => Promise<void>;
  confirm: (question: Confirmation) => Promise<boolean>;
  inform: (message: Information) => Promise<void>;
  autostart: Autostart;
  /** Packaged builds start with the computer once paired; development opts in. */
  registerAutostart: boolean;
  unregisterNativeHost?: () => Promise<void>;
  onState: (state: UiState) => void;
  quit: () => void;
  /** After a removal: stop writing anything under the app's data folder. */
  onRemoved?: () => void;
  log?: Logger;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const notices = {
  pairAgain: {
    tone: 'warning',
    text:
      "This computer's record of submit presses is missing or unreadable, so Veyquo cannot " +
      'vouch for it. Pair this computer again to keep applying here.',
  },
  revoked: {
    tone: 'info',
    text: 'This computer was removed from your Veyquo account. Pair it again to use it.',
  },
  replaced: {
    tone: 'warning',
    text: 'Another copy of Veyquo connected as this computer, so this one stopped.',
  },
  protocol: {
    tone: 'error',
    text: 'Veyquo and this app no longer understand each other. Update the app to continue.',
  },
  expired: { tone: 'warning', text: 'The pairing code expired. Start again to get a new one.' },
  unreachable: {
    tone: 'error',
    text: 'Veyquo could not be reached. Check your connection and try again.',
  },
  ipcTaken: {
    tone: 'error',
    text:
      'Another program is using the channel the Veyquo extension talks to this app on, so ' +
      'Veyquo can’t work in your everyday Chrome right now. Restart your computer, then open ' +
      'Veyquo again. If this keeps happening, remove programs you don’t recognise.',
  },
} as const satisfies Record<string, Notice>;

export class DeviceController {
  private readonly deps: ControllerDeps;
  private readonly log: Logger;
  private readonly tempFiles: AppTempFiles;
  private state: UiState;
  private connection: DeviceConnection | null = null;
  private host: ExecutorHost | null = null;
  private chromeVersion: string | null = null;
  private pairing: AbortController | null = null;
  private grantKeys = new Map<string, Uint8Array>();
  private online = false;
  private extensionConnected = false;
  private ipcFailed = false;
  private settingsSync: Promise<void> | null = null;
  private settingsMutation: Promise<void> | null = null;
  private auth: DeviceAuth | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.log = deps.log ?? silentLogger;
    this.tempFiles = new AppTempFiles(deps.paths.tmp);
    this.state = { ...initialUiState, deviceName: deps.deviceName };
  }

  get uiState(): UiState {
    return this.state;
  }

  /** Start-up checks (desktop plan §8), then the connection when this computer is paired. */
  async start(): Promise<void> {
    await this.tempFiles.sweep();
    await this.deps.stopStaleChrome().catch((error: unknown) => {
      this.log.error('chrome.stale_stop_failed', error);
    });
    await this.checkChrome();
    await this.deps.access?.initialize();
    let paired: { deviceId: string; key: DeviceKey } | null = null;
    try {
      const deviceId = await this.deps.keystore.deviceId();
      const key = deviceId === null ? null : await this.deps.keystore.load();
      if (deviceId !== null && key !== null) paired = { deviceId, key };
    } catch (error) {
      this.log.error('keystore.load_failed', error);
      this.update({
        notice: {
          tone: 'error',
          text:
            error instanceof SecureStorageUnavailableError
              ? error.message
              : "Veyquo could not read this computer's device key. Pair this computer again.",
        },
      });
    }
    if (paired === null) {
      this.update({ status: 'signed_out' });
      return;
    }
    await this.connect(paired.deviceId, paired.key, null);
  }

  async pair(): Promise<void> {
    if (this.pairing !== null || this.connection !== null) return;
    const signal = (this.pairing = new AbortController()).signal;
    this.update({ status: 'pairing', notice: null, pairing: null });
    try {
      const { deviceId, key } = await pairDevice({
        api: this.deps.api,
        keystore: this.deps.keystore,
        openExternal: this.deps.openExternal,
        onCode: (pairing) => {
          this.update({
            pairing: {
              code: pairing.code,
              approveUrl: pairing.approve_url,
              expiresAt: pairing.expires_at,
            },
          });
        },
        os: this.deps.os,
        appVersion: this.deps.appVersion,
        nameHint: this.deps.deviceName.slice(0, 64) || null,
        signal,
        ...(this.deps.sleep === undefined ? {} : { sleep: this.deps.sleep }),
      });
      this.log.info('pairing.approved', { device_id: deviceId });
      // A new device gets a new journal with a fresh id (Task 9 carry 2).
      const journal = await DurableJournal.create(this.deps.paths.journal, { deviceId });
      if (this.deps.registerAutostart) {
        await this.deps.autostart.enable().catch((error: unknown) => {
          this.log.error('autostart.enable_failed', error);
        });
      }
      this.update({ pairing: null });
      await this.connect(deviceId, key, journal);
    } catch (error) {
      this.log.error('pairing.failed', error);
      this.update({ status: 'signed_out', pairing: null, notice: this.pairingNotice(error) });
    } finally {
      this.pairing = null;
    }
  }

  setAccessState(access: AccessState): void {
    this.update({ access });
    if (
      access.status === 'required' ||
      access.status === 'signing_in' ||
      access.status === 'error'
    ) {
      this.cancelPairing();
      this.connection?.stop();
      if (this.state.status !== 'signed_out' && this.state.status !== 'pairing') {
        this.update({ status: this.state.paused ? 'paused' : 'offline' });
      }
      void this.host?.stopChrome();
    }
  }

  async signInAccess(): Promise<void> {
    await this.deps.access?.signIn();
    if (this.state.access.status === 'connected' && !this.state.paused) this.connection?.start();
  }

  cancelAccess(): void {
    this.deps.access?.cancel();
  }

  async signOutAccess(): Promise<void> {
    this.connection?.stop();
    await this.host?.stopChrome();
    await this.deps.access?.signOut();
  }

  cancelPairing(): void {
    this.pairing?.abort();
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this.connection === null || paused === this.state.paused) return;
    this.update({ paused });
    if (paused) {
      this.connection.stop();
      await this.host?.stopChrome();
    } else {
      this.connection.start();
    }
  }

  /** The Veyquo extension connected to, or left, the app's IPC endpoint. */
  setExtensionConnected(connected: boolean): void {
    this.extensionConnected = connected;
    this.update({ modes: { ...this.state.modes, everydayProfile: this.everydayAvailable } });
  }

  /** The IPC endpoint could not be opened (Task 10 carry 2): something else may hold its
   * name, so the everyday profile is off for this run and the person is told. */
  nativeIpcFailed(): void {
    this.ipcFailed = true;
    this.update({
      security: notices.ipcTaken,
      modes: { ...this.state.modes, everydayProfile: false },
    });
  }

  private get everydayAvailable(): boolean {
    return this.extensionConnected && !this.ipcFailed;
  }

  async takeOver(): Promise<void> {
    await this.host?.takeOver();
  }

  async handBack(): Promise<void> {
    await this.host?.handBack();
  }

  async setVisibility(visibility: WindowVisibility): Promise<void> {
    await this.host?.setVisibility(visibility);
  }

  /** "Remove Veyquo from this computer" (desktop plan §8). */
  async remove(): Promise<void> {
    const revokeRemote = await this.remoteRevocation();
    const outcome = await removeFromComputer({
      paths: this.deps.paths,
      confirm: () => this.deps.confirm('remove'),
      stopConnection: () => {
        this.cancelPairing();
        this.deps.access?.cancel();
        this.connection?.stop();
        this.connection = null;
        this.auth = null;
      },
      stopChrome: async () => {
        await this.host?.stopChrome();
        await this.deps.stopStaleChrome().catch(() => undefined);
      },
      disableAutostart: () => this.deps.autostart.disable(),
      ...(this.deps.unregisterNativeHost === undefined
        ? {}
        : { unregisterNativeHost: this.deps.unregisterNativeHost }),
      ...(revokeRemote === null ? {} : { revokeRemote }),
    });
    if (outcome === 'cancelled') return;
    await this.deps.access?.signOut();
    // Nothing more is written under the data folder: the log went with it.
    this.deps.onRemoved?.();
    if (outcome === 'removed_locally') await this.deps.inform('removed_locally');
    this.deps.quit();
  }

  /** How this computer revokes itself, while it still holds its key; null when unpaired. */
  private async remoteRevocation(): Promise<(() => Promise<void>) | null> {
    let paired: { deviceId: string; key: DeviceKey } | null = null;
    try {
      const deviceId = await this.deps.keystore.deviceId();
      const key = deviceId === null ? null : await this.deps.keystore.load();
      if (deviceId !== null && key !== null) paired = { deviceId, key };
    } catch (error) {
      this.log.error('remove.key_unreadable', error);
      return () => Promise.reject(new Error('the device key is unreadable'));
    }
    if (paired === null) return null;
    const auth = new DeviceAuth({ api: this.deps.api, deviceId: paired.deviceId, key: paired.key });
    return async () => {
      try {
        await this.deps.api.revokeSelf(await auth.token());
      } catch (error) {
        if (error instanceof DeviceRevokedError) return; // already removed from the account
        this.log.error('remove.revoke_failed', error);
        throw error;
      }
    };
  }

  /** Quit: close the connection; Chrome is closed by the caller. */
  shutdown(): void {
    this.cancelPairing();
    this.deps.access?.close();
    this.connection?.stop();
    this.connection = null;
    this.auth = null;
  }

  async stopChrome(): Promise<void> {
    await this.host?.stopChrome();
  }

  // --- internals ---------------------------------------------------------------------

  private async checkChrome(): Promise<void> {
    const location = await this.deps
      .locateChrome()
      .catch((): ChromeLocation => ({ ok: false, error: 'chrome_unavailable', reason: 'missing' }));
    if (location.ok) {
      this.chromeVersion = location.version;
      this.update({
        chrome: { available: true, version: location.version },
        modes: { ...this.state.modes, veyquoProfile: true },
      });
      return;
    }
    const messages = {
      missing: 'Google Chrome is not installed on this computer.',
      too_old: `Google Chrome ${location.version ?? ''} is too old: Veyquo needs version 136 or newer.`,
      unknown_version: "Veyquo could not read this Chrome's version.",
    } as const;
    this.update({
      chrome: { available: false, message: messages[location.reason].replace('  ', ' ') },
      modes: { ...this.state.modes, veyquoProfile: false },
    });
  }

  private async connect(
    deviceId: string,
    key: DeviceKey,
    created: DurableJournal | null,
  ): Promise<void> {
    const journal = created ?? (await DurableJournal.open(this.deps.paths.journal, { deviceId }));
    const integrity = await journal.check();
    if (!integrity.ok) {
      // No hello under this identity: the journal cannot vouch for it (carry 2).
      this.log.warn('journal.unusable', { device_id: deviceId, reason: integrity.reason });
      this.update({ status: 'signed_out', notice: notices.pairAgain });
      return;
    }
    const auth = new DeviceAuth({ api: this.deps.api, deviceId, key });
    this.auth = auth;
    const context: ChromeContext = {
      journal,
      tempFiles: this.tempFiles,
      grantKeys: () => this.grantKeys,
      emit: (event) => {
        host.observe(event);
        this.connection?.send(event);
      },
    };
    const host = new ExecutorHost({
      journal,
      startChrome: (proxy) => this.deps.startChrome(context, proxy),
      startEveryday: () =>
        this.everydayAvailable ? (this.deps.startEveryday?.(context) ?? null) : null,
      confirmClearProfile: () => this.deps.confirm('clear_profile'),
      clearProfile: () =>
        rm(this.deps.paths.chromeProfile, { recursive: true, force: true, maxRetries: 3 }),
      onActivity: (activity) => {
        this.showActivity(activity);
      },
    });
    this.host = host;
    const connection = new DeviceConnection({
      url: this.deps.api.connectUrl,
      token: async () => {
        await this.deps.access?.ensure();
        return auth.token();
      },
      invalidateToken: () => {
        auth.invalidate();
      },
      openSocket: this.deps.openSocket,
      hello: () =>
        helloEvent(journal, {
          deviceId,
          appVersion: this.deps.appVersion,
          os: this.deps.os,
          chromeVersion: this.chromeVersion,
          modes: this.everydayAvailable
            ? ['veyquo_profile', 'everyday_profile']
            : ['veyquo_profile'],
        }),
      heartbeat: () => {
        void this.syncBrowserSettings(auth);
        return { name: 'heartbeat', busy_session_id: host.busySessionId };
      },
      onKeys: (keys) => {
        this.grantKeys = keys;
        this.log.info('gateway.keys', { count: keys.size });
      },
      onRequest: (request, reply) => {
        this.handleRequest(host, request, reply);
      },
      onConnectionLost: () => host.connectionLost(),
      onStatus: (status) => {
        if (status.state === 'online') void this.syncBrowserSettings(auth);
        void this.connectionStatus(deviceId, status);
      },
      power: this.deps.power,
    });
    this.connection = connection;
    this.update({ status: 'offline', notice: null });
    connection.start();
  }

  private syncBrowserSettings(auth: DeviceAuth): Promise<void> {
    if (this.settingsMutation !== null) return this.settingsMutation;
    if (this.settingsSync !== null) return this.settingsSync;
    const running = auth
      .token()
      .then((token) => this.deps.api.browserSettings(token))
      .then((settings) => {
        this.showBrowserSettings(settings);
      })
      .catch((error: unknown) => {
        this.log.warn('browser_settings.sync_failed', {
          error: error instanceof Error ? error.name : 'UnknownError',
        });
      })
      .finally(() => {
        if (this.settingsSync === running) this.settingsSync = null;
      });
    this.settingsSync = running;
    return running;
  }

  private showBrowserSettings(settings: Awaited<ReturnType<DevicesApi['browserSettings']>>): void {
    this.update({
      selectedModes: {
        veyquoProfile: settings.selected_modes.includes('veyquo_profile'),
        everydayProfile: settings.selected_modes.includes('everyday_profile'),
      },
      browserProfiles: settings.profiles.map((profile) => ({
        viewId: profile.view_id,
        name: profile.name,
        chromeMode: profile.chrome_mode,
        hasProxy: profile.has_proxy,
      })),
    });
  }

  async setBrowserMode(viewId: string, mode: 'veyquo_profile' | 'everyday_profile'): Promise<void> {
    const auth = this.auth;
    if (auth === null) return;
    if (this.settingsMutation !== null) return;
    const profile = this.state.browserProfiles.find((item) => item.viewId === viewId);
    this.update({ browserModePending: viewId, notice: null });
    const running = (async () => {
      if (this.settingsSync !== null) await this.settingsSync;
      try {
        await this.deps.access?.ensure();
        const settings = await this.deps.api.updateBrowserMode(await auth.token(), viewId, mode);
        this.showBrowserSettings(settings);
        this.update({ notice: null });
      } catch (error) {
        this.update({
          notice: {
            tone: 'error',
            text:
              error instanceof ApiError &&
              error.status === 409 &&
              profile?.hasProxy === true &&
              mode === 'everyday_profile'
                ? 'This job profile cannot use everyday Chrome while its proxy is saved. Remove the proxy in Veyquo settings first.'
                : 'Could not change this job profile’s browser. Check your connection and try again.',
          },
        });
      }
    })().finally(() => {
      this.update({ browserModePending: null });
      if (this.settingsMutation === running) this.settingsMutation = null;
    });
    this.settingsMutation = running;
    await running;
  }

  private handleRequest(
    host: ExecutorHost,
    request: DeviceRequest,
    reply: (reply: DeviceReply) => void,
  ): void {
    // Called on receipt; `host.handle` reaches the executor before any await.
    const answer = host.handle(request);
    this.log.info('device.request', { request_id: request.request_id, op: request.op.name });
    void answer.then(
      (result) => {
        reply(result);
        this.log.info('device.reply', {
          request_id: result.request_id,
          ok: result.ok,
          error: result.error?.type ?? null,
        });
      },
      (error: unknown) => {
        this.log.error('device.request_failed', error, { request_id: request.request_id });
        reply({
          request_id: request.request_id,
          ok: false,
          result: null,
          error: { type: 'internal', detail: null },
        });
      },
    );
  }

  private async connectionStatus(deviceId: string, status: ConnectionStatus): Promise<void> {
    this.log.info('gateway.status', {
      state: status.state,
      reason: status.state === 'stopped' ? status.reason : null,
    });
    switch (status.state) {
      case 'online':
        this.online = true;
        this.update({ status: this.workingOr('online') });
        return;
      case 'connecting':
      case 'waiting':
        this.online = false;
        if (!this.state.paused) this.update({ status: 'offline' });
        return;
      case 'idle':
        this.online = false;
        if (this.state.paused) this.update({ status: 'paused' });
        return;
      case 'stopped':
        this.online = false;
        this.connection = null;
        if (status.reason === 'revoked') {
          await this.revoked(deviceId);
        } else if (status.reason === 'journal_unusable') {
          this.update({ status: 'signed_out', notice: notices.pairAgain });
        } else {
          this.update({ status: 'offline', notice: notices[status.reason] });
        }
        return;
      default: {
        const unreachable: never = status;
        return unreachable;
      }
    }
  }

  private async revoked(deviceId: string): Promise<void> {
    this.log.info('device.revoked', { device_id: deviceId });
    const host = this.host;
    this.host = null;
    await this.deps.access?.signOut();
    await wipeRevokedDevice({
      paths: this.deps.paths,
      confirmDeleteProfile: () => this.deps.confirm('revoked_profile'),
      stopChrome: async () => {
        await host?.stopChrome();
      },
    });
    this.update({
      status: 'signed_out',
      notice: notices.revoked,
      activity: { kind: 'idle' },
      paused: false,
    });
  }

  private showActivity(activity: HostActivity): void {
    this.update({
      activity:
        activity.kind === 'applying'
          ? { kind: 'applying', takenOver: activity.takenOver, visibility: activity.visibility }
          : { kind: 'idle' },
    });
    if (this.online) this.update({ status: this.workingOr('online') });
  }

  private workingOr(status: 'online'): 'online' | 'working' {
    return this.state.activity.kind === 'applying' ? 'working' : status;
  }

  private pairingNotice(error: unknown): Notice | null {
    if (error instanceof PairingCancelledError) return null;
    if (error instanceof AccessRequiredError) return { tone: 'warning', text: error.message };
    if (error instanceof PairingExpiredError) return notices.expired;
    if (error instanceof SecureStorageUnavailableError) {
      return { tone: 'error', text: error.message };
    }
    if (error instanceof ApiError || error instanceof DeviceRevokedError)
      return notices.unreachable;
    return notices.unreachable;
  }

  private update(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }
}
