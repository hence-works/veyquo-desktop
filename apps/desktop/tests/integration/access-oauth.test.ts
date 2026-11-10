import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';
import { expect, it } from 'vitest';

import { AccessSession } from '../../src/main/access-session.ts';
import { fakeSafeStorage } from '../support/fakes.ts';

const origin = 'https://staging-api.veyquo.xyz';
const issuer = 'https://hence-labs.cloudflareaccess.com';
const endpoints = {
  issuer,
  authorization_endpoint: `${issuer}/cdn-cgi/access/oauth/authorization`,
  token_endpoint: `${issuer}/cdn-cgi/access/oauth/token`,
  registration_endpoint: `${issuer}/cdn-cgi/access/oauth/registration`,
  revocation_endpoint: `${issuer}/cdn-cgi/access/oauth/revoke`,
  code_challenge_methods_supported: ['S256'],
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'veyquo-oauth-integration-'));
  const requests: {
    path: string;
    authorization: string | undefined;
    deviceToken: string | string[] | undefined;
    body: string;
  }[] = [];
  let challenge = '';
  let redirect = '';
  let clientId = '';
  let now = Date.now();
  let refreshes = 0;
  let accessToken = 'oauth:first-access-token';
  let callbackUrl = '';
  let cancelOnOpen = false;
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const path = request.url ?? '/';
    requests.push({
      path,
      authorization: request.headers.authorization,
      deviceToken: request.headers['x-veyquo-device-token'],
      body,
    });
    response.setHeader('content-type', 'application/json');
    if (path === '/app/.well-known/oauth-authorization-server') {
      // App discovery intentionally omits registration, as the real staging edge does.
      response.end(JSON.stringify({ ...endpoints, registration_endpoint: undefined }));
    } else if (path === '/issuer/.well-known/oauth-authorization-server') {
      response.end(JSON.stringify(endpoints));
    } else if (path === '/issuer/cdn-cgi/access/oauth/registration') {
      const registration: unknown = JSON.parse(body);
      expect(registration).toMatchObject({
        client_name: 'Veyquo desktop',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      });
      clientId = 'registered-public-client';
      response.end(JSON.stringify({ client_id: clientId, token_endpoint_auth_method: 'none' }));
    } else if (path === '/issuer/cdn-cgi/access/oauth/token') {
      const form = new URLSearchParams(body);
      expect(form.get('resource')).toBe(origin);
      expect(form.get('client_id')).toBe(clientId);
      if (form.get('grant_type') === 'authorization_code') {
        expect(form.get('code')).toBe('once-only-code');
        expect(form.get('redirect_uri')).toBe(redirect);
        expect(
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url'),
        ).toBe(challenge);
      } else {
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('rotating-refresh-token');
        refreshes += 1;
        accessToken = 'oauth:refreshed-access-token';
      }
      response.end(
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'rotating-refresh-token',
        }),
      );
    } else if (path === '/issuer/cdn-cgi/access/oauth/revoke') {
      expect(new URLSearchParams(body).get('token')).toBe('rotating-refresh-token');
      response.end('{}');
    } else if (request.headers.authorization === `Bearer ${accessToken}`) {
      response.end(JSON.stringify({ ok: true }));
    } else {
      response.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      });
      response.end('{}');
    }
  };
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      errors.push(error);
      response.writeHead(500).end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture did not listen');
  const local = `http://127.0.0.1:${String(address.port)}`;
  const network = (url: string, init: RequestInit) => {
    const remote = new URL(url);
    const prefix = remote.origin === origin ? '/app' : remote.origin === issuer ? '/issuer' : null;
    if (prefix === null) throw new Error('untrusted fixture origin');
    return fetch(`${local}${prefix}${remote.pathname}`, init);
  };
  const file = join(dir, 'access-session.bin');
  const states: string[] = [];
  const session = new AccessSession({
    apiUrl: origin,
    file,
    storage: fakeSafeStorage(),
    platform: 'darwin',
    fetch: network,
    now: () => now,
    onState: (state) => {
      states.push(JSON.stringify(state));
    },
    openExternal: async (login) => {
      const url = new URL(login);
      expect(url.origin).toBe(issuer);
      expect(url.pathname).toBe('/cdn-cgi/access/oauth/authorization');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('resource')).toBe(origin);
      expect(url.searchParams.get('client_id')).toBe(clientId);
      challenge = url.searchParams.get('code_challenge') ?? '';
      expect(challenge).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{42}$/u);
      expect(url.searchParams.has('scope')).toBe(false);
      redirect = url.searchParams.get('redirect_uri') ?? '';
      const callback = new URL(redirect);
      expect(callback.hostname).toBe('127.0.0.1');
      expect(callback.port).not.toBe('');
      callback.search = new URLSearchParams({
        state: url.searchParams.get('state') ?? '',
        code: 'once-only-code',
      }).toString();
      callbackUrl = callback.href;
      if (cancelOnOpen) {
        session.cancel();
        return;
      }
      // An invalid absolute-form target must not throw out of the HTTP handler or
      // consume the valid callback that follows it.
      await new Promise<void>((resolve, reject) => {
        const invalid = httpRequest(
          {
            hostname: callback.hostname,
            port: callback.port,
            path: 'http://[',
            headers: { host: callback.host },
          },
          (response) => {
            expect(response.statusCode).toBe(400);
            response.resume();
            response.on('end', () => {
              resolve();
            });
          },
        );
        invalid.on('error', reject);
        invalid.end();
      });
      const badState = new URL(callback);
      badState.searchParams.set('state', 'different-state');
      const denied = await fetch(badState);
      expect(denied.status).toBe(400);
      expect(await denied.text()).not.toContain('once-only-code');
      const accepted = await fetch(callback);
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).not.toContain(url.searchParams.get('state'));
    },
  });
  const wsServer = new WebSocketServer({ server });
  const wsRequests: { authorization: string | undefined; protocol: string | undefined }[] = [];
  wsServer.on('connection', (socket, request) => {
    wsRequests.push({
      authorization: request.headers.authorization,
      protocol: request.headers['sec-websocket-protocol'],
    });
    socket.close();
  });
  return {
    session,
    file,
    states,
    errors,
    requests,
    wsRequests,
    get callbackUrl() {
      return callbackUrl;
    },
    set cancelOnOpen(value: boolean) {
      cancelOnOpen = value;
    },
    advance: () => {
      now += 901_000;
    },
    refreshes: () => refreshes,
    socket: async () => {
      await session.ensure();
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(
          local.replace('http:', 'ws:'),
          ['veyquo-device-v1', 'device-token'],
          { headers: session.socketHeaders('wss://staging-api.veyquo.xyz/v1/devices/connect') },
        );
        socket.on('error', reject);
        socket.on('close', () => {
          resolve();
        });
      });
    },
    close: async () => {
      session.close();
      wsServer.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it('signs in through browser PKCE, rejects a wrong state, refreshes and authenticates HTTP plus the device socket', async () => {
  const f = await fixture();
  try {
    await f.session.initialize();
    expect(f.session.state.status).toBe('required');
    await f.session.signIn();
    expect(f.session.state.status).toBe('connected');
    expect((await readFile(f.file)).toString()).not.toContain('rotating-refresh-token');
    const response = await f.session.fetch(`${origin}/v1/devices/self/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer veyquo-device-jwt' },
    });
    expect(response.status).toBe(200);
    expect(f.requests.at(-1)).toMatchObject({
      authorization: 'Bearer oauth:first-access-token',
      deviceToken: 'veyquo-device-jwt',
    });
    f.advance();
    await Promise.all([f.session.ensure(), f.session.ensure()]);
    expect(f.refreshes()).toBe(1);
    await f.socket();
    expect(f.wsRequests[0]).toEqual({
      authorization: 'Bearer oauth:refreshed-access-token',
      protocol: 'veyquo-device-v1,device-token',
    });
    expect(f.states.join('')).not.toContain('rotating-refresh-token');
    expect(f.states.join('')).not.toContain('oauth:');
    await f.session.signOut();
    await expect(readFile(f.file)).rejects.toThrow();
    expect(f.requests.at(-1)?.path).toBe('/issuer/cdn-cgi/access/oauth/revoke');
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});

it('cancels the browser callback listener and never persists an abandoned authorization', async () => {
  const f = await fixture();
  try {
    f.cancelOnOpen = true;
    await f.session.initialize();
    await f.session.signIn();
    expect(f.session.state.status).toBe('required');
    await expect(readFile(f.file)).rejects.toThrow();
    await expect(fetch(f.callbackUrl)).rejects.toThrow();
    expect(f.requests.some(({ path }) => path === '/issuer/cdn-cgi/access/oauth/token')).toBe(
      false,
    );
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
});
