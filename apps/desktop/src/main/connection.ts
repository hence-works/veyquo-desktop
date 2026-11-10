// The device's outbound connection to the API gateway (desktop plan §4.4, §6.3; wire
// contract in services/api/src/api/devices/gateway.py):
//
// - a fresh device token per connection, offered as the subprotocols
//   `[DEVICE_SUBPROTOCOL, token]`;
// - `hello` first (within the gateway's 10 s), carrying the journal; with an unusable
//   journal no hello is said under this identity and the connection stops;
// - the `keys` frame, then requests, each handed over the moment it arrives (the grant's
//   lifetime counts from receipt) and answered only on the socket it came from;
// - a heartbeat every 15 s;
// - after a drop, reconnects with backoff from 1 s to 60 s with ±20% jitter, starting over
//   once connected; the OS waking (`resume`, `unlock-screen`) reconnects at once;
// - the OS going to sleep (`suspend`) ends every in-flight operation and drops the socket
//   first: a grant received before a sleep is never pressed after it;
// - close codes: 4401 revoked (stop; the app wipes), 4403 token expired (new token, now),
//   4409 replaced and 4400 protocol error (stop), anything else (back off and retry).
//
// Every close tells the executor the connection is gone, so nothing a dead connection asked
// for continues (§6.3).

import {
  DEVICE_SUBPROTOCOL,
  type DeviceEvent,
  type DeviceReply,
  type DeviceRequest,
  type HeartbeatEvent,
  type HelloEvent,
} from '@veyquo/device-protocol';
import { JournalUnusableError, gatewayClose, parseGatewayFrame } from '@veyquo/local-executor';

import { DeviceRevokedError } from './api.ts';

const socketOpen = 1;
export const heartbeatMs = 15_000;
const minBackoffMs = 1000;
const maxBackoffMs = 60_000;

/** The part of a `ws` WebSocket the connection uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  terminate(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

/** Electron's `powerMonitor`, as far as the connection cares. */
export interface PowerEvents {
  on(event: 'suspend' | 'resume' | 'unlock-screen', listener: () => void): unknown;
}

export type StopReason = 'revoked' | 'replaced' | 'protocol' | 'journal_unusable';

export type ConnectionStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'waiting'; retryInMs: number }
  | { state: 'stopped'; reason: StopReason };

export interface ConnectionDeps {
  url: string;
  token: () => Promise<string>;
  invalidateToken: () => void;
  openSocket: (url: string, protocols: string[]) => SocketLike;
  /** Throws `JournalUnusableError` when the journal cannot vouch for this device. */
  hello: () => Promise<HelloEvent>;
  heartbeat: () => HeartbeatEvent;
  onKeys: (keys: Map<string, Uint8Array>) => void;
  /** Called synchronously on receipt. `reply` sends only while that socket is current. */
  onRequest: (request: DeviceRequest, reply: (reply: DeviceReply) => void) => void;
  onConnectionLost: () => Promise<void>;
  onStatus: (status: ConnectionStatus) => void;
  power: PowerEvents;
  random?: () => number;
  heartbeatMs?: number;
}

/** The wait before reconnect attempt `attempt` (0 = the first retry). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(minBackoffMs * 2 ** Math.min(attempt, 16), maxBackoffMs);
  const jittered = Math.round(base * (0.8 + 0.4 * random()));
  return Math.min(jittered, maxBackoffMs);
}

const stopCodes: Partial<Record<number, StopReason>> = {
  [gatewayClose.revoked]: 'revoked',
  [gatewayClose.replaced]: 'replaced',
  [gatewayClose.protocol]: 'protocol',
};

export class DeviceConnection {
  private readonly deps: ConnectionDeps;
  private readonly random: () => number;
  private socket: SocketLike | null = null;
  private running = false;
  private attempt = 0;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Set when the socket is being replaced on purpose (the OS woke up). */
  private reconnectAtOnce = false;
  private pendingStop: StopReason | null = null;
  /** Sockets `stop()` already let go of: their late close events are not this connection's. */
  private readonly retired = new WeakSet<SocketLike>();
  private refreshedToken = false;

  constructor(deps: ConnectionDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
    deps.power.on('suspend', () => {
      this.suspend();
    });
    deps.power.on('resume', () => {
      this.wake();
    });
    deps.power.on('unlock-screen', () => {
      this.wake();
    });
  }

  get online(): boolean {
    return this.socket?.readyState === socketOpen;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pendingStop = null;
    this.attempt = 0;
    void this.connect();
  }

  /** Closes the connection and does not reconnect (pause, quit, removal). */
  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearRetry();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      // Its requests end now, not when its close event lands, which may be after a
      // restart has opened the next connection (pause, then unpause).
      this.retired.add(socket);
      void this.deps.onConnectionLost();
      socket.close(1000);
    }
    this.deps.onStatus({ state: 'idle' });
  }

  /** Sends an executor event on the live connection; dropped when there is none. */
  send(event: DeviceEvent): void {
    const socket = this.socket;
    if (socket?.readyState === socketOpen) socket.send(JSON.stringify(event));
  }

  /** The OS is about to sleep: nothing asked for before it may continue after it (§6.3). */
  private suspend(): void {
    void this.deps.onConnectionLost();
    if (!this.running || this.socket === null) return;
    this.socket.terminate();
  }

  /** The OS woke up: a socket that looks open may be dead, and a backoff wait is stale. */
  private wake(): void {
    if (!this.running) return;
    this.attempt = 0;
    if (this.socket !== null) {
      this.reconnectAtOnce = true;
      this.socket.terminate();
      return;
    }
    if (this.retryTimer !== null) {
      this.clearRetry();
      void this.connect();
    }
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.deps.onStatus({ state: 'connecting' });
    let token: string;
    try {
      token = await this.deps.token();
    } catch (error) {
      if (!this.running || generation !== this.generation) return;
      if (error instanceof DeviceRevokedError) {
        this.stopWith('revoked');
      } else {
        this.retryAfter(backoffDelay(this.attempt++, this.random));
      }
      return;
    }
    if (!this.running || generation !== this.generation) return;
    const socket = this.deps.openSocket(this.deps.url, [DEVICE_SUBPROTOCOL, token]);
    this.socket = socket;
    socket.on('open', () => {
      void this.opened(socket);
    });
    socket.on('message', (data, isBinary) => {
      this.message(socket, data, isBinary);
    });
    socket.on('close', (code) => {
      void this.closed(socket, code);
    });
    socket.on('error', () => {
      // `close` follows with the code.
    });
  }

  private async opened(socket: SocketLike): Promise<void> {
    let hello: HelloEvent;
    try {
      hello = await this.deps.hello();
    } catch (error) {
      if (this.socket !== socket) return;
      if (error instanceof JournalUnusableError) this.pendingStop = 'journal_unusable';
      socket.close(1000);
      return;
    }
    if (this.socket !== socket || socket.readyState !== socketOpen) return;
    socket.send(JSON.stringify(hello));
    this.attempt = 0;
    this.refreshedToken = false;
    this.deps.onStatus({ state: 'online' });
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.socket === socket && socket.readyState === socketOpen) {
        socket.send(JSON.stringify(this.deps.heartbeat()));
      }
    }, this.deps.heartbeatMs ?? heartbeatMs);
  }

  private message(socket: SocketLike, data: Buffer, isBinary: boolean): void {
    if (isBinary || this.socket !== socket) return;
    const frame = parseGatewayFrame(data.toString('utf8'));
    switch (frame.kind) {
      case 'keys':
        this.deps.onKeys(frame.keys);
        return;
      case 'refused':
        if (frame.reply !== null) socket.send(JSON.stringify(frame.reply));
        return;
      case 'request':
        this.deps.onRequest(frame.request, (reply) => {
          // Only on the connection the request came from (§6.3).
          if (this.socket === socket && socket.readyState === socketOpen) {
            socket.send(JSON.stringify(reply));
          }
        });
        return;
      default: {
        const unreachable: never = frame;
        return unreachable;
      }
    }
  }

  private async closed(socket: SocketLike, code: number): Promise<void> {
    if (this.retired.has(socket)) return; // stop() already ended its work
    if (this.socket === socket) {
      this.socket = null;
      this.stopHeartbeat();
    }
    await this.deps.onConnectionLost();
    if (!this.running || this.socket !== null || this.retryTimer !== null) return;
    const stop = this.pendingStop ?? stopCodes[code];
    if (stop !== undefined) {
      this.stopWith(stop);
      return;
    }
    if (this.reconnectAtOnce) {
      this.reconnectAtOnce = false;
      void this.connect();
      return;
    }
    if (code === gatewayClose.unauthorized && !this.refreshedToken) {
      // The token expired: a new one, at once. A second 4403 in a row backs off.
      this.refreshedToken = true;
      this.deps.invalidateToken();
      this.retryAfter(0);
      return;
    }
    if (code === gatewayClose.unauthorized) this.deps.invalidateToken();
    this.retryAfter(backoffDelay(this.attempt++, this.random));
  }

  private retryAfter(ms: number): void {
    this.clearRetry();
    this.deps.onStatus({ state: 'waiting', retryInMs: ms });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) void this.connect();
    }, ms);
  }

  private stopWith(reason: StopReason): void {
    this.running = false;
    this.clearRetry();
    this.stopHeartbeat();
    this.deps.onStatus({ state: 'stopped', reason });
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
