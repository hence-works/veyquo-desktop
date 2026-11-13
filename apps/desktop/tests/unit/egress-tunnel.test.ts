import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { decodeEgressFrame, encodeEgressFrame } from '../../src/main/egress/protocol.ts';
import { EgressTunnel, type EgressSocket, type TcpSocket } from '../../src/main/egress/tunnel.ts';

class FakeRelay extends EventEmitter implements EgressSocket {
  readyState = 1;
  readonly sent: Buffer[] = [];
  readonly protocols: string[];

  constructor(protocols: string[]) {
    super();
    this.protocols = protocols;
  }

  send(data: Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.readyState = 3;
  }

  ping(): void {
    this.emit('ping');
  }
}

class FakeTcp extends EventEmitter implements TcpSocket {
  remoteAddress = '93.184.216.34';
  readonly writes: Buffer[] = [];
  paused = false;
  destroyed = false;

  write(data: Buffer, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(data));
    callback?.();
    return true;
  }

  end(): this {
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setNoDelay(): this {
    return this;
  }
}

async function started(overrides: { lookupAddress?: string } = {}) {
  const relay = new FakeRelay([]);
  const tcp = new FakeTcp();
  let tcpCreated = false;
  const active = vi.fn();
  const tunnel = new EgressTunnel({
    url: 'wss://staging.veyquo.xyz/v1/device-egress/connect',
    ticket: 'base64url-ticket-with-more-than-32-characters',
    expiresAt: new Date(Date.now() + 30_000),
    openSocket: (_url, protocols) => {
      relay.protocols.push(...protocols);
      return relay;
    },
    lookup: () =>
      Promise.resolve([{ address: overrides.lookupAddress ?? '93.184.216.34', family: 4 }]),
    connectTcp: () => {
      tcpCreated = true;
      return tcp;
    },
    onActive: active,
  });
  const opening = tunnel.start();
  relay.emit('open');
  await opening;
  return {
    tunnel,
    relay,
    active,
    get tcp(): FakeTcp | null {
      return tcpCreated ? tcp : null;
    },
  };
}

describe('device egress tunnel', () => {
  it('uses the versioned protocol and never puts the ticket in the URL', async () => {
    const { tunnel, relay, active } = await started();
    expect(relay.protocols).toEqual([
      'veyquo.egress.v1',
      'base64url-ticket-with-more-than-32-characters',
    ]);
    expect(active).toHaveBeenCalledWith(true);
    tunnel.stop();
    expect(active).toHaveBeenLastCalledWith(false);
  });

  it('opens only a validated port-443 stream and relays bytes with credit', async () => {
    const running = await started();
    running.relay.emit(
      'message',
      encodeEgressFrame({ kind: 'open', streamId: 7, hostname: 'jobs.example.com', port: 443 }),
      true,
    );
    await vi.waitFor(() => {
      expect(running.tcp).not.toBeNull();
    });
    const tcp = running.tcp;
    if (tcp === null) throw new Error('TCP socket was not created');
    tcp.emit('connect');
    expect(running.relay.sent.map(decodeEgressFrame)).toEqual([
      { kind: 'opened', streamId: 7 },
      { kind: 'window_update', streamId: 7, credit: 262_144 },
    ]);

    running.relay.emit(
      'message',
      encodeEgressFrame({ kind: 'window_update', streamId: 7, credit: 10 }),
      true,
    );
    tcp.emit('data', Buffer.from('server tls'));
    expect(decodeEgressFrame(running.relay.sent.at(-1) ?? Buffer.alloc(0))).toEqual({
      kind: 'data',
      streamId: 7,
      data: Buffer.from('server tls'),
    });

    running.relay.emit(
      'message',
      encodeEgressFrame({ kind: 'data', streamId: 7, data: Buffer.from('client tls') }),
      true,
    );
    expect(tcp.writes).toEqual([Buffer.from('client tls')]);
    expect(decodeEgressFrame(running.relay.sent.at(-1) ?? Buffer.alloc(0))).toEqual({
      kind: 'window_update',
      streamId: 7,
      credit: 10,
    });
    running.tunnel.stop();
  });

  it('rejects private DNS answers before opening a TCP socket', async () => {
    const running = await started({ lookupAddress: '169.254.169.254' });
    running.relay.emit(
      'message',
      encodeEgressFrame({ kind: 'open', streamId: 3, hostname: 'metadata.example', port: 443 }),
      true,
    );
    await vi.waitFor(() => {
      expect(running.relay.sent).toHaveLength(1);
    });
    expect(running.tcp).toBeNull();
    expect(decodeEgressFrame(running.relay.sent[0] ?? Buffer.alloc(0))).toEqual({
      kind: 'reset',
      streamId: 3,
      code: 2,
    });
    running.tunnel.stop();
  });

  it('rejects non-binary relay messages and tears down active streams', async () => {
    const running = await started();
    running.relay.emit('message', Buffer.from('not binary'), false);
    expect(running.active).toHaveBeenLastCalledWith(false);
    expect(running.relay.readyState).toBe(3);
  });
});
