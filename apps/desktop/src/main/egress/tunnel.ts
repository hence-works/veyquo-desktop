import { createConnection, type Socket } from 'node:net';

import { resolvePublicDestination, sameAddress, type Lookup } from './destination-policy.ts';
import {
  decodeEgressFrame,
  egressSubprotocol,
  encodeEgressFrame,
  maxEgressFrameBytes,
  type EgressFrame,
} from './protocol.ts';

const socketOpen = 1;
const initialCredit = 256 * 1024;
const maxStreams = 32;
const maxQueuedBytes = 4 * 1024 * 1024;
const heartbeatMs = 15_000;
const deadAfterMs = 45_000;
const maxSessionMs = 30 * 60_000;
const openTimeoutMs = 15_000;

const resetCode = {
  refused: 1,
  destination: 2,
  connect: 3,
  flowControl: 4,
  limit: 5,
} as const;

export interface EgressSocket {
  readonly readyState: number;
  send(data: Buffer): void;
  close(code?: number): void;
  terminate(): void;
  ping(): void;
  on(event: 'open' | 'close' | 'error' | 'pong', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
}

interface TcpSocketEvents {
  connect: () => void;
  error: (error: Error) => void;
  data: (data: Buffer) => void;
  end: () => void;
  close: () => void;
}

export interface TcpSocket {
  readonly remoteAddress?: string;
  write(data: Buffer, callback?: (error?: Error | null) => void): boolean;
  end(): this;
  destroy(error?: Error): this;
  pause(): this;
  resume(): this;
  setNoDelay(noDelay?: boolean): this;
  once<Event extends keyof TcpSocketEvents>(event: Event, listener: TcpSocketEvents[Event]): this;
  on<Event extends keyof TcpSocketEvents>(event: Event, listener: TcpSocketEvents[Event]): this;
}

interface Stream {
  socket: TcpSocket;
  sendCredit: number;
  receiveCredit: number;
  queued: Buffer[];
  queuedBytes: number;
  localEnded: boolean;
  remoteEnded: boolean;
}

export interface EgressTunnelDeps {
  url: string;
  ticket: string;
  expiresAt: Date;
  openSocket: (url: string, protocols: string[]) => EgressSocket;
  lookup?: Lookup;
  connectTcp?: (options: { host: string; port: 443; family: 4 | 6 }) => TcpSocket;
  onActive: (active: boolean) => void;
  now?: () => number;
}

function nodeTcp(options: { host: string; port: 443; family: 4 | 6 }): Socket {
  return createConnection(options);
}

export class EgressTunnel {
  private readonly deps: EgressTunnelDeps;
  private readonly now: () => number;
  private readonly streams = new Map<number, Stream>();
  private socket: EgressSocket | null = null;
  private stopped = false;
  private active = false;
  private lastPong = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lifetime: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: EgressTunnelDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): Promise<void> {
    if (this.socket !== null || this.stopped)
      return Promise.reject(new Error('tunnel is not startable'));
    if (this.deps.expiresAt.getTime() <= this.now()) {
      return Promise.reject(new Error('egress ticket expired'));
    }
    const socket = this.deps.openSocket(this.deps.url, [egressSubprotocol, this.deps.ticket]);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (): void => {
        if (!settled) {
          settled = true;
          reject(new Error('egress relay connection failed'));
        }
        this.stop();
      };
      socket.on('open', () => {
        if (this.socket !== socket || this.stopped) return;
        settled = true;
        this.active = true;
        this.lastPong = this.now();
        this.deps.onActive(true);
        this.startTimers(socket);
        resolve();
      });
      socket.on('message', (data, isBinary) => {
        if (this.socket !== socket || !isBinary) {
          fail();
          return;
        }
        this.message(data);
      });
      socket.on('pong', () => {
        if (this.socket === socket) this.lastPong = this.now();
      });
      socket.on('close', fail);
      socket.on('error', fail);
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopTimers();
    const socket = this.socket;
    this.socket = null;
    for (const stream of this.streams.values()) stream.socket.destroy();
    this.streams.clear();
    if (socket !== null && socket.readyState === socketOpen) socket.close(1000);
    if (this.active) {
      this.active = false;
      this.deps.onActive(false);
    }
  }

  private startTimers(socket: EgressSocket): void {
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket) return;
      if (this.now() - this.lastPong > deadAfterMs) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, heartbeatMs);
    this.lifetime = setTimeout(() => {
      this.stop();
    }, maxSessionMs);
  }

  private stopTimers(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.lifetime !== null) clearTimeout(this.lifetime);
    this.heartbeat = null;
    this.lifetime = null;
  }

  private message(raw: Buffer): void {
    let frame: EgressFrame;
    try {
      frame = decodeEgressFrame(raw);
    } catch {
      this.stop();
      return;
    }
    switch (frame.kind) {
      case 'open':
        void this.open(frame);
        return;
      case 'data':
        this.data(frame.streamId, frame.data);
        return;
      case 'window_update':
        this.addCredit(frame.streamId, frame.credit);
        return;
      case 'fin':
        this.remoteFin(frame.streamId);
        return;
      case 'reset':
        this.reset(frame.streamId, false, frame.code);
        return;
      case 'goaway':
        this.stop();
        return;
      case 'opened':
        this.stop();
        return;
      default: {
        const unreachable: never = frame;
        return unreachable;
      }
    }
  }

  private async open(frame: Extract<EgressFrame, { kind: 'open' }>): Promise<void> {
    if (frame.port !== 443 || this.streams.has(frame.streamId) || this.streams.size >= maxStreams) {
      this.send({ kind: 'reset', streamId: frame.streamId, code: resetCode.refused });
      return;
    }
    let destination;
    try {
      destination = await resolvePublicDestination(frame.hostname, this.deps.lookup);
    } catch {
      this.send({ kind: 'reset', streamId: frame.streamId, code: resetCode.destination });
      return;
    }
    if (this.stopped || this.streams.has(frame.streamId)) return;
    const socket = (this.deps.connectTcp ?? nodeTcp)({
      host: destination.address,
      port: 443,
      family: destination.family,
    });
    let opened = false;
    const timeout = setTimeout(() => {
      if (!opened) socket.destroy(new Error('egress destination connect timed out'));
    }, openTimeoutMs);
    socket.once('connect', () => {
      clearTimeout(timeout);
      if (this.stopped || !sameAddress(destination.address, socket.remoteAddress)) {
        socket.destroy();
        this.send({ kind: 'reset', streamId: frame.streamId, code: resetCode.destination });
        return;
      }
      opened = true;
      socket.setNoDelay(true);
      const stream: Stream = {
        socket,
        sendCredit: 0,
        receiveCredit: initialCredit,
        queued: [],
        queuedBytes: 0,
        localEnded: false,
        remoteEnded: false,
      };
      this.streams.set(frame.streamId, stream);
      this.bindTcp(frame.streamId, stream);
      this.send({ kind: 'opened', streamId: frame.streamId });
      this.send({ kind: 'window_update', streamId: frame.streamId, credit: initialCredit });
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      if (!opened) this.send({ kind: 'reset', streamId: frame.streamId, code: resetCode.connect });
    });
  }

  private bindTcp(streamId: number, stream: Stream): void {
    stream.socket.on('data', (data) => {
      this.tcpData(streamId, data);
    });
    stream.socket.on('end', () => {
      if (!stream.localEnded) {
        stream.localEnded = true;
        this.send({ kind: 'fin', streamId });
      }
    });
    stream.socket.on('close', () => {
      if (this.streams.get(streamId) === stream) this.streams.delete(streamId);
    });
    stream.socket.on('error', () => {
      this.reset(streamId, true, resetCode.connect);
    });
  }

  private data(streamId: number, data: Buffer): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.remoteEnded || data.byteLength > stream.receiveCredit) {
      this.reset(streamId, true, resetCode.flowControl);
      return;
    }
    stream.receiveCredit -= data.byteLength;
    stream.socket.write(data, (error) => {
      if (error !== undefined && error !== null) {
        this.reset(streamId, true, resetCode.connect);
        return;
      }
      if (this.streams.get(streamId) !== stream) return;
      stream.receiveCredit += data.byteLength;
      this.send({ kind: 'window_update', streamId, credit: data.byteLength });
    });
  }

  private tcpData(streamId: number, data: Buffer): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    let offset = 0;
    while (offset < data.byteLength && stream.sendCredit > 0) {
      const length = Math.min(stream.sendCredit, maxEgressFrameBytes, data.byteLength - offset);
      this.send({
        kind: 'data',
        streamId,
        data: Buffer.from(data.subarray(offset, offset + length)),
      });
      stream.sendCredit -= length;
      offset += length;
    }
    if (offset === data.byteLength) return;
    const remainder = Buffer.from(data.subarray(offset));
    if (stream.queuedBytes + remainder.byteLength > maxQueuedBytes) {
      this.reset(streamId, true, resetCode.limit);
      return;
    }
    stream.queued.push(remainder);
    stream.queuedBytes += remainder.byteLength;
    stream.socket.pause();
  }

  private addCredit(streamId: number, credit: number): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.sendCredit > 0xffff_ffff - credit) {
      this.reset(streamId, true, resetCode.flowControl);
      return;
    }
    stream.sendCredit += credit;
    while (stream.queued.length > 0 && stream.sendCredit > 0) {
      const next = stream.queued.shift();
      if (next === undefined) break;
      stream.queuedBytes -= next.byteLength;
      this.tcpData(streamId, next);
    }
    if (stream.queued.length === 0) stream.socket.resume();
  }

  private remoteFin(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.remoteEnded) return;
    stream.remoteEnded = true;
    stream.socket.end();
  }

  private reset(streamId: number, notify: boolean, code: number): void {
    const stream = this.streams.get(streamId);
    if (stream !== undefined) {
      this.streams.delete(streamId);
      stream.socket.destroy();
    }
    if (notify) this.send({ kind: 'reset', streamId, code });
  }

  private send(frame: EgressFrame): void {
    const socket = this.socket;
    if (socket?.readyState === socketOpen) socket.send(encodeEgressFrame(frame));
  }
}
