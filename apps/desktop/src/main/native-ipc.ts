// The local IPC endpoint the native-messaging host connects to: a Unix socket at
// `<userData>/native.sock` (mode 0600, in the app's private 0700 data folder), or the named
// pipe `\\.\pipe\veyquo-desktop-<username>` on Windows. It carries length-prefixed JSON
// frames, the same shape Chrome's native messaging uses: a 4-byte little-endian length, then
// UTF-8 JSON `{id, kind, payload}`. A frame that is not that shape is skipped; one longer than
// `maxFrameBytes` closes the connection before it is buffered.
//
// Who may connect, and who the host is talking to (mutual, Task 10 carry 1): both ends know
// this run's random key from `<userData>/native-ipc.key` (0600; on Windows, inside the user's
// own %APPDATA%, which other users cannot read). The key never crosses the connection:
//
//   host -> app  {kind: "hello",   payload: {nonce: N1}}
//   app  -> host {kind: "welcome", payload: {proof: HMAC(key, "app" N1), nonce: N2}}
//   host -> app  {kind: "auth",    payload: {proof: HMAC(key, "host" N2)}}
//   app  -> host {kind: "admitted"}
//
// The host checks the welcome before it relays anything, so a process that took the pipe
// name first (Windows pipe squatting) learns nothing and gets nothing. The app hangs up on
// anything else, a wrong proof, or a client not admitted within `helloTimeoutMs` (5 s).
// Node cannot set a named pipe's security descriptor, flag PIPE_REJECT_REMOTE_CLIENTS or read
// a pipe client's identity, so the key is the control on Windows.
//
// After admission the frames are the extension relay's (`@veyquo/local-executor`'s
// `extension-protocol.ts`), handled by `native-host/extension-transport.ts`.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { writeFileDurably } from './durable-file.ts';

export interface IpcFrame {
  id: string;
  kind: string;
  payload: unknown;
}

/** Chrome's own limit for a message to a native host. */
export const maxFrameBytes = 64 * 1024 * 1024;
/** Before admission only handshake frames are expected: anything longer is refused before it
 * is buffered, so an unauthenticated client cannot make the app hold 64 MiB. */
export const maxPreAdmissionBytes = 16 * 1024;
const maxNameLength = 128;

export class FrameTooLargeError extends Error {
  constructor(length: number) {
    super(`an IPC frame of ${String(length)} bytes is over the limit`);
    this.name = 'FrameTooLargeError';
  }
}

export function encodeFrame(frame: IpcFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  if (body.length > maxFrameBytes) throw new FrameTooLargeError(body.length);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function asFrame(text: string): IpcFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { id, kind } = record;
  if (typeof id !== 'string' || id.length === 0 || id.length > maxNameLength) return null;
  if (typeof kind !== 'string' || kind.length === 0 || kind.length > maxNameLength) return null;
  return { id, kind, payload: record.payload ?? null };
}

/** Reassembles frames from a byte stream. */
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  /** The longest frame accepted now; raised once a connection is admitted. */
  limit: number;

  constructor(limit: number = maxFrameBytes) {
    this.limit = limit;
  }

  /** The complete, well-formed frames now available. Throws `FrameTooLargeError`. */
  push(chunk: Buffer): IpcFrame[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    const frames: IpcFrame[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > this.limit) throw new FrameTooLargeError(length);
      if (this.buffered.length < 4 + length) break;
      const frame = asFrame(this.buffered.subarray(4, 4 + length).toString('utf8'));
      this.buffered = this.buffered.subarray(4 + length);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }
}

/** Unix socket paths are limited to 104 bytes on macOS and 108 on Linux, NUL included. */
export const maxSocketPathBytes = 103;

export function nativeEndpoint(options: {
  platform: NodeJS.Platform;
  userData: string;
  username: string;
}): string {
  if (options.platform === 'win32') return `\\\\.\\pipe\\veyquo-desktop-${options.username}`;
  return join(options.userData, 'native.sock');
}

/** One admitted connection: the native host for one extension port. */
export interface IpcConnection {
  send(frame: IpcFrame): void;
  onFrame(handler: (frame: IpcFrame) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export type ConnectionHandler = (connection: IpcConnection) => void;

/** How long a client has to complete the handshake. */
export const helloTimeoutMs = 5000;

const noncePattern = /^[0-9a-f]{64}$/u;

/** The handshake's proof that `role` knows the key, bound to the other side's nonce. */
export function ipcProof(key: string, role: 'app' | 'host', nonce: string): string {
  return createHmac('sha256', key).update(`veyquo-native-ipc/${role}\n${nonce}`).digest('hex');
}

export function newNonce(): string {
  return randomBytes(32).toString('hex');
}

function field(frame: IpcFrame, kind: string, name: string): string | null {
  if (frame.kind !== kind || typeof frame.payload !== 'object' || frame.payload === null) {
    return null;
  }
  const value = (frame.payload as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/** Constant-time equality of two hex strings. */
export function sameHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A new random key for this run, written where only this user can read it. */
export async function createIpcKey(path: string): Promise<string> {
  const key = randomBytes(32).toString('hex');
  await writeFileDurably(path, `${key}\n`);
  await chmod(path, 0o600);
  return key;
}

export interface NativeIpcServer {
  close(): Promise<void>;
}

export async function startNativeIpc(
  endpoint: string,
  onConnection: ConnectionHandler,
  options: { key: string; helloTimeoutMs?: number },
): Promise<NativeIpcServer> {
  const pipe = endpoint.startsWith('\\\\.\\pipe\\');
  if (!pipe && Buffer.byteLength(endpoint) > maxSocketPathBytes) {
    throw new Error('the IPC socket path is longer than the OS allows');
  }
  // A socket file left by a crashed run would make listen fail with EADDRINUSE; only this
  // app writes in its private data folder, so the file is its own.
  if (!pipe) await rm(endpoint, { force: true });
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new FrameDecoder(maxPreAdmissionBytes);
    const appNonce = newNonce();
    let stage: 'hello' | 'auth' | 'admitted' = 'hello';
    const frameHandlers: ((frame: IpcFrame) => void)[] = [];
    const closeHandlers: (() => void)[] = [];
    const send = (frame: IpcFrame): void => {
      if (!socket.destroyed) socket.write(encodeFrame(frame));
    };
    const deadline = setTimeout(() => {
      if (stage !== 'admitted') socket.destroy(); // too slow to be the native host
    }, options.helloTimeoutMs ?? helloTimeoutMs);
    const handshake = (frame: IpcFrame): boolean => {
      if (stage === 'hello') {
        const nonce = field(frame, 'hello', 'nonce');
        if (nonce === null || !noncePattern.test(nonce)) return false;
        stage = 'auth';
        send({
          id: frame.id,
          kind: 'welcome',
          payload: { proof: ipcProof(options.key, 'app', nonce), nonce: appNonce },
        });
        return true;
      }
      const proof = field(frame, 'auth', 'proof');
      if (proof === null || !sameHex(proof, ipcProof(options.key, 'host', appNonce))) return false;
      stage = 'admitted';
      decoder.limit = maxFrameBytes;
      clearTimeout(deadline);
      send({ id: frame.id, kind: 'admitted', payload: null });
      onConnection({
        send,
        onFrame: (handler) => frameHandlers.push(handler),
        onClose: (handler) => closeHandlers.push(handler),
        close: () => socket.destroy(),
      });
      return true;
    };
    socket.on('data', (chunk: Buffer) => {
      let frames: IpcFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy(); // over the limit: the peer is broken or hostile
        return;
      }
      for (const frame of frames) {
        if (socket.destroyed) return;
        if (stage === 'admitted') {
          for (const handler of frameHandlers) handler(frame);
        } else if (!handshake(frame)) {
          socket.destroy(); // not this user's native host
          return;
        }
      }
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      clearTimeout(deadline);
      sockets.delete(socket);
      if (stage === 'admitted') for (const handler of closeHandlers) handler();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (!pipe) await chmod(endpoint, 0o600);
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      if (!pipe) await rm(endpoint, { force: true });
    },
  };
}
