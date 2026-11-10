// A stand-in for the API's device routes and gateway (services/api/src/api/devices) on
// 127.0.0.1, for the desktop app's lifecycle tests: pairing with a poll token, the
// challenge/token exchange with a real Ed25519 check, and a WebSocket that requires the
// subprotocols [DEVICE_SUBPROTOCOL, token], records every frame and can send requests,
// close with a gateway code or drop the connection.

import { createPublicKey, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DEVICE_SUBPROTOCOL, type DeviceOp, type DeviceReply } from '@veyquo/device-protocol';
import { WebSocketServer, type WebSocket } from 'ws';

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const pairingId = 'f2b0b8a4-55b5-4b8f-9a63-0b1c2d3e4f51';

export type Frame = Record<string, unknown>;

export class FakeGateway {
  readonly deviceId = crypto.randomUUID();
  readonly frames: Frame[] = [];
  approved = false;
  revoked = false;
  /** Set when the device revoked itself with a valid device token. */
  selfRevoked = false;
  publicKeyB64: string | null = null;
  connections = 0;
  socket: WebSocket | null = null;
  private readonly tokens = new Set<string>();
  private readonly nonces = new Set<string>();
  private readonly server: Server;
  private readonly wss: WebSocketServer;
  private waiters: (() => void)[] = [];

  constructor() {
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/v1/devices/connect',
      handleProtocols: (protocols) =>
        protocols.has(DEVICE_SUBPROTOCOL) ? DEVICE_SUBPROTOCOL : false,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        const offered = (req.headers['sec-websocket-protocol'] ?? '').split(/,\s*/u);
        return (
          offered.length === 2 &&
          offered[0] === DEVICE_SUBPROTOCOL &&
          this.tokens.has(offered[1] ?? '')
        );
      },
    });
    this.wss.on('connection', (ws) => {
      this.connections += 1;
      this.socket = ws;
      ws.on('message', (data: Buffer) => {
        this.frames.push(JSON.parse(data.toString('utf8')) as Frame);
        if (this.frames.at(-1)?.name === 'hello') {
          ws.send(
            JSON.stringify({ type: 'keys', keys: { k1: Buffer.alloc(32, 7).toString('base64') } }),
          );
        }
        for (const wake of this.waiters.splice(0)) wake();
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
    this.server.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  /** Drops every connection the way a network failure would (no close frame). */
  drop(): void {
    for (const client of this.wss.clients) client.terminate();
  }

  hellos(): Frame[] {
    return this.frames.filter((frame) => frame.name === 'hello');
  }

  /** Sends a request on the live socket and waits for its reply. */
  async request(op: DeviceOp, sessionId: string | null = null, ms = 60_000): Promise<DeviceReply> {
    const requestId = crypto.randomUUID();
    this.socket?.send(JSON.stringify({ request_id: requestId, session_id: sessionId, op }));
    return (await this.frame((f) => f.request_id === requestId, ms)) as unknown as DeviceReply;
  }

  /** The first recorded frame `match` accepts, waiting up to `ms`. */
  async frame(match: (frame: Frame) => boolean, ms = 30_000): Promise<Frame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.frames.find(match);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error('the device sent no such frame in time');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body =
      chunks.length > 0
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {};
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const path = req.url ?? '';
    if (req.method === 'POST' && path === '/v1/devices/pairings') {
      this.publicKeyB64 = String(body.public_key_b64);
      json(201, {
        pairing_id: pairingId,
        code: 'ABCD2345',
        approve_url: `http://127.0.0.1:3400/app/devices/pair?code=ABCD2345`,
        poll_token: 'poll',
        expires_at: '2100-01-01T00:00:00Z',
      });
    } else if (req.method === 'GET' && path === `/v1/devices/pairings/${pairingId}`) {
      if (req.headers['x-pairing-token'] !== 'poll') json(404, {});
      else
        json(
          200,
          this.approved
            ? { status: 'approved', device_id: this.deviceId }
            : { status: 'pending', device_id: null },
        );
    } else if (req.method === 'POST' && path === '/v1/devices/self/revoke') {
      const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!this.tokens.has(bearer)) {
        json(401, {});
        return;
      }
      this.selfRevoked = true;
      this.revoked = true;
      for (const client of this.wss.clients) client.close(4401);
      res.writeHead(204);
      res.end();
    } else if (req.method === 'POST' && path === `/v1/devices/${this.deviceId}/challenge`) {
      const nonce = crypto.randomUUID();
      this.nonces.add(nonce);
      json(200, { nonce, expires_at: '2100-01-01T00:00:00Z' });
    } else if (req.method === 'POST' && path === `/v1/devices/${this.deviceId}/token`) {
      if (this.revoked) {
        json(403, { type: 'https://veyquo.com/problems/device-revoked' });
        return;
      }
      const nonce = String(body.nonce);
      const spent = this.nonces.delete(nonce);
      const key = createPublicKey({
        key: Buffer.concat([spkiPrefix, Buffer.from(this.publicKeyB64 ?? '', 'base64')]),
        format: 'der',
        type: 'spki',
      });
      const ok =
        spent &&
        verify(
          null,
          Buffer.from(`veyquo-device-token:${nonce}`),
          key,
          Buffer.from(String(body.signature_b64), 'base64'),
        );
      if (!ok) {
        json(401, {});
        return;
      }
      const token = `device-token-${crypto.randomUUID()}`;
      this.tokens.add(token);
      json(200, { access_token: token, expires_in: 600 });
    } else {
      json(404, {});
    }
  }
}
