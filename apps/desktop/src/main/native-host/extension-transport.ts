// The everyday profile in the app (desktop plan §4.2, §4.3): the Veyquo extension, reached
// through its native-messaging host over the app's IPC endpoint, as a `CdpTransport` and
// `TabHost` for a `LocalExecutor`.
//
// - `IpcRelayLink`: one admitted IPC connection as the relay's `RelayLink` (requests with
//   ids and their replies, the extension's events).
// - `ExtensionHub`: the one extension the app works with. The first to connect is used;
//   another (a second Chrome profile with the extension) is refused while it lasts. Its
//   transport and tab host exist from the moment it connects, so a tab the person approves
//   before any session starts is known. It tells the extension what the app is doing (for
//   the popup) and passes the popup's Take over / Hand back to the app.
// - `everydayChrome`: the executor for the `ExecutorHost`, in the same shape as the
//   Veyquo-profile Chrome.
//
// Nothing here logs: frames hold page content.

import type { DeviceEvent } from '@veyquo/device-protocol';
import {
  LocalExecutor,
  TRANSPORT_CLOSED,
  type Journal,
  type TempFiles,
} from '@veyquo/local-executor';
import {
  ExtensionTabHost,
  ExtensionTransport,
  RelayClosedError,
  parseEvent,
  parseReply,
  type AppActivity,
  type ExtensionEvent,
  type RelayLink,
  type RelayReply,
  type RelayRequest,
} from '@veyquo/local-executor/extension';

import type { RunningChrome } from '../executor-host.ts';
import type { IpcConnection, IpcFrame } from '../native-ipc.ts';

export class IpcRelayLink implements RelayLink {
  private readonly connection: IpcConnection;
  private readonly pending = new Map<
    string,
    { resolve: (reply: RelayReply) => void; reject: (error: Error) => void }
  >();
  private readonly eventHandlers = new Set<(event: ExtensionEvent) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private isClosed = false;
  private next = 1;

  constructor(connection: IpcConnection) {
    this.connection = connection;
    connection.onFrame((frame) => {
      this.receive(frame);
    });
    connection.onClose(() => {
      this.shutDown();
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  request(request: RelayRequest): Promise<RelayReply> {
    if (this.isClosed) return Promise.reject(new RelayClosedError());
    const id = `a-${String(this.next++)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.connection.send({ id, kind: request.kind, payload: request.payload });
    });
  }

  /** A frame the extension does not answer (`state`). */
  tell(kind: string, payload: unknown): void {
    if (!this.isClosed) this.connection.send({ id: `a-${String(this.next++)}`, kind, payload });
  }

  onEvent(handler: (event: ExtensionEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClosed(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.connection.close();
    this.shutDown();
  }

  private receive(frame: IpcFrame): void {
    if (this.isClosed) return;
    if (frame.kind === 'reply') {
      const reply = parseReply(frame);
      const waiting = this.pending.get(frame.id);
      if (reply === null || waiting === undefined) return;
      this.pending.delete(frame.id);
      waiting.resolve(reply);
      return;
    }
    const event = parseEvent(frame);
    if (event === null) return;
    for (const handler of [...this.eventHandlers]) {
      try {
        handler(event);
      } catch {
        // One handler's failure must not stop the others.
      }
    }
  }

  private shutDown(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const [, waiting] of this.pending) waiting.reject(new RelayClosedError());
    this.pending.clear();
    for (const handler of [...this.closeHandlers]) handler();
  }
}

export interface ConnectedExtension {
  link: IpcRelayLink;
  transport: ExtensionTransport;
  tabs: ExtensionTabHost;
}

export class ExtensionHub {
  private readonly deps: {
    onTakeover: (action: 'take_over' | 'hand_back') => void;
    onConnected: (connected: boolean) => void;
    browserSettingsUrl: string;
  };
  private connected: ConnectedExtension | null = null;
  private activity: AppActivity = 'idle';

  constructor(deps: ExtensionHub['deps']) {
    const settings = new URL(deps.browserSettingsUrl);
    if (
      !['http:', 'https:'].includes(settings.protocol) ||
      (settings.protocol === 'http:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(settings.hostname)) ||
      settings.username ||
      settings.password ||
      settings.search ||
      settings.hash ||
      settings.pathname !== '/app/settings/browser'
    ) {
      throw new Error('browser settings URL must be an http(s) Veyquo settings page');
    }
    this.deps = deps;
  }

  get current(): ConnectedExtension | null {
    return this.connected;
  }

  /** An admitted IPC connection (`native-ipc.ts`): one native host, one extension port. */
  accept(connection: IpcConnection): void {
    if (this.connected !== null && !this.connected.link.closed) {
      connection.close(); // another profile's extension: one at a time
      return;
    }
    const link = new IpcRelayLink(connection);
    const transport = new ExtensionTransport(link);
    const tabs = new ExtensionTabHost(transport, link);
    const entry = { link, transport, tabs };
    this.connected = entry;
    link.onEvent((event) => {
      if (event.kind === 'takeover') this.deps.onTakeover(event.payload.action);
    });
    link.onClosed(() => {
      if (this.connected !== entry) return;
      this.connected = null;
      this.deps.onConnected(false);
    });
    // The extension counts the app as there once it hears from it.
    link.tell('state', {
      activity: this.activity,
      browser_settings_url: this.deps.browserSettingsUrl,
    });
    this.deps.onConnected(true);
  }

  /** What the popup shows: idle, applying, or taken over by the person. */
  setActivity(activity: AppActivity): void {
    if (activity === this.activity) return;
    this.activity = activity;
    this.connected?.link.tell('state', {
      activity,
      browser_settings_url: this.deps.browserSettingsUrl,
    });
  }

  close(): void {
    this.connected?.link.close();
  }
}

export interface EverydayContext {
  journal: Journal;
  tempFiles: TempFiles;
  grantKeys: () => Map<string, Uint8Array>;
  emit: (event: DeviceEvent) => void;
}

/** The everyday profile's executor over `extension`, for the `ExecutorHost`. */
export function everydayChrome(
  extension: ConnectedExtension,
  context: EverydayContext,
): RunningChrome {
  const executor = new LocalExecutor({
    transport: extension.transport,
    tabs: extension.tabs,
    journal: context.journal,
    grantKeys: context.grantKeys,
    tempFiles: context.tempFiles,
    emit: context.emit,
  });
  return {
    executor,
    tabs: {
      // Sign-ins happen in the Veyquo profile (desktop plan §5.4); everyday tabs are the
      // person's own, and the extension cannot move its window off-screen.
      openSite: () => Promise.reject(new Error('sites open in the Veyquo profile')),
      setVisibility: () => Promise.resolve(false),
    },
    onClosed: (listener) => {
      if (extension.transport.isClosed) listener();
      else extension.transport.on(TRANSPORT_CLOSED, listener);
    },
    stop: async () => {
      await executor.shutdown();
    },
  };
}
