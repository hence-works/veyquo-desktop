// Fakes for the desktop app's unit tests: Electron's safeStorage, a WebSocket, and power
// events. No Electron, no network.

import { EventEmitter } from 'node:events';

import type { SecretStorage } from '../../src/main/keystore.ts';
import type { PowerEvents, SocketLike } from '../../src/main/connection.ts';
import type { EgressSocket } from '../../src/main/egress/tunnel.ts';

const marker = Buffer.from('fake-safe-storage:');

/** Reversible stand-in for `safeStorage`: the plaintext never appears in its output. */
export function fakeSafeStorage(
  options: { available?: boolean; backend?: string } = {},
): SecretStorage & { encrypted: Buffer[] } {
  const encrypted: Buffer[] = [];
  return {
    encrypted,
    isEncryptionAvailable: () => options.available ?? true,
    getSelectedStorageBackend: () => options.backend ?? 'gnome_libsecret',
    encryptString(plain: string): Buffer {
      const bytes = Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a);
      const out = Buffer.concat([marker, bytes]);
      encrypted.push(out);
      return out;
    },
    decryptString(data: Buffer): string {
      if (!data.subarray(0, marker.length).equals(marker)) throw new Error('not ours');
      return Buffer.from(data.subarray(marker.length).map((byte) => byte ^ 0x5a)).toString('utf8');
    },
  };
}

export class FakeSocket extends EventEmitter implements SocketLike {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;
  terminated = false;

  readonly url: string;
  readonly protocols: string[];

  constructor(url: string, protocols: string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  /** When set, `close()` only records the code; `finishClose()` delivers the event later,
   * as a real socket does after the closing handshake. */
  deferClose = false;

  close(code = 1000): void {
    this.closedWith = code;
    if (!this.deferClose) this.finish(code);
  }

  finishClose(): void {
    this.finish(this.closedWith ?? 1006);
  }

  terminate(): void {
    this.terminated = true;
    this.finish(1006);
  }

  // --- test controls -----------------------------------------------------------------

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit('open');
  }

  /** The gateway sends a frame. */
  receive(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }

  /** The gateway (or the network) closes the socket. */
  drop(code: number): void {
    this.finish(code);
  }

  names(): unknown[] {
    return this.sent.map((frame) => frame.name ?? frame.request_id);
  }

  private finish(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, Buffer.alloc(0));
  }
}

export class FakePower extends EventEmitter implements PowerEvents {
  override on(event: 'suspend' | 'resume' | 'unlock-screen', listener: () => void): this {
    return super.on(event, listener);
  }
}

export class FakeEgressSocket extends EventEmitter implements EgressSocket {
  readyState = 0;
  readonly sent: Buffer[] = [];
  readonly url: string;
  readonly protocols: string[];
  closedWith: number | null = null;

  constructor(url: string, protocols: string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
  }

  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = 3;
    this.emit('close');
  }

  ping(): void {
    this.emit('ping');
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
}
