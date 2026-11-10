import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AccessRequiredError,
  AccessSession,
  type AccessSessionOptions,
} from '../../src/main/access-session.ts';
import type { AccessState } from '../../src/shared/ui-state.ts';
import { fakeSafeStorage } from '../support/fakes.ts';

const origin = 'https://staging-api.veyquo.xyz';
const issuer = 'https://hence-labs.cloudflareaccess.com';
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/cdn-cgi/access/oauth/authorization`,
  token_endpoint: `${issuer}/cdn-cgi/access/oauth/token`,
  registration_endpoint: `${issuer}/cdn-cgi/access/oauth/registration`,
  revocation_endpoint: `${issuer}/cdn-cgi/access/oauth/revoke`,
  code_challenge_methods_supported: ['S256'],
};
const token = {
  access_token: 'oauth:private-access-credential',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'private-refresh-credential',
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'veyquo-access-unit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(options: Partial<AccessSessionOptions> = {}) {
  const file = join(dir, 'access-session.bin');
  const storage = fakeSafeStorage();
  const states: AccessState[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const network = vi.fn((url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return Promise.resolve(Response.json(metadata));
    if (url === metadata.token_endpoint) return Promise.resolve(Response.json(token));
    if (url === metadata.revocation_endpoint)
      return Promise.resolve(new Response(null, { status: 200 }));
    return Promise.resolve(Response.json({ detail: 'Method Not Allowed' }, { status: 405 }));
  });
  const session = new AccessSession({
    apiUrl: origin,
    file,
    storage,
    platform: 'darwin',
    openExternal: () => Promise.resolve(),
    onState: (state) => {
      states.push(state);
    },
    fetch: network,
    ...options,
  });
  const save = async (patch: Record<string, unknown> = {}) => {
    await writeFile(
      file,
      storage.encryptString(
        JSON.stringify({
          origin,
          issuer,
          clientId: 'desktop-public-client',
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + 900_000,
          ...patch,
        }),
      ),
    );
  };
  return { session, file, storage, states, network, requests, save };
}

describe('staging Access transport', () => {
  it('does not discover or authenticate ordinary production/dev servers', async () => {
    const { session, network } = setup({ apiUrl: 'https://api.veyquo.xyz' });
    await session.initialize();
    expect(session.state.status).toBe('not_required');
    expect(network).not.toHaveBeenCalled();
    await expect(session.headers('https://api.veyquo.xyz/v1/devices/pairings')).resolves.toEqual(
      {},
    );
  });

  it('keeps a WARP-authorized connection free of OAuth credentials', async () => {
    const { session } = setup();
    await session.initialize();
    expect(session.state.status).toBe('not_required');
    const headers = await session.headers(`${origin}/v1/devices/self/revoke`, {
      authorization: 'Bearer device-token',
    });
    expect(headers).toEqual({ authorization: 'Bearer device-token' });
  });

  it('distinguishes Cloudflare challenge from a Veyquo bearer rejection', () => {
    const { session } = setup();
    expect(
      session.isChallenge(
        new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
      ),
    ).toBe(false);
    expect(
      session.isChallenge(
        new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
        }),
      ),
    ).toBe(true);
    expect(
      session.isChallenge(
        new Response(null, {
          status: 302,
          headers: { location: `${issuer}/cdn-cgi/access/login/test` },
        }),
      ),
    ).toBe(true);
    expect(
      session.isChallenge(
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.test/cdn-cgi/access/login' },
        }),
      ),
    ).toBe(false);
  });

  it('reports sign-in required when staging redirects to its pinned Access issuer', async () => {
    const { session, network } = setup();
    network.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: `${issuer}/cdn-cgi/access/login/test` },
      }),
    );
    await session.initialize();
    expect(session.state.status).toBe('required');
    await expect(
      session.fetch(`${origin}/v1/devices/pairings`, { method: 'POST' }),
    ).rejects.toBeInstanceOf(AccessRequiredError);
  });

  it('restores encrypted per-origin credentials and attaches OAuth separately from the Veyquo token', async () => {
    const { session, save, file } = setup();
    await save();
    expect((await readFile(file)).toString()).not.toContain(token.access_token);
    expect((await readFile(file)).toString()).not.toContain(token.refresh_token);
    await session.initialize();
    expect(
      await session.headers(`${origin}/v1/devices/pairings`, { 'X-Pairing-Token': 'poll' }),
    ).toEqual({ authorization: `Bearer ${token.access_token}`, 'x-pairing-token': 'poll' });
    expect(
      await session.headers(`${origin}/v1/devices/self/revoke`, {
        authorization: 'Bearer device-token',
      }),
    ).toEqual({
      authorization: `Bearer ${token.access_token}`,
      'x-veyquo-device-token': 'device-token',
    });
    expect(session.socketHeaders('wss://staging-api.veyquo.xyz/v1/devices/connect')).toEqual({
      authorization: `Bearer ${token.access_token}`,
    });
  });

  it('never forwards the credential to a different origin or lets an unknown bearer be overwritten', async () => {
    const { session, save } = setup();
    await save();
    await session.initialize();
    await expect(session.headers('https://attacker.test/v1/devices/pairings')).rejects.toThrow(
      'sign-in',
    );
    expect(() => session.socketHeaders('wss://attacker.test/v1/devices/connect')).toThrow(
      'sign-in',
    );
    await expect(
      session.headers(`${origin}/v1/other`, { authorization: 'Bearer keep-me' }),
    ).rejects.toThrow('sign-in');
  });

  it('does not send a stored credential with a mismatched API origin', async () => {
    const { session, save, requests } = setup();
    await save({ origin: 'https://attacker.test' });
    await session.initialize();
    expect(
      requests.every(({ init }) => new Headers(init.headers).get('authorization') === null),
    ).toBe(true);
  });

  it('does not treat the API device-token 401 as an expired Access session', async () => {
    const { session, save, network } = setup();
    await save();
    await session.initialize();
    network.mockResolvedValue(Response.json({ type: 'device-token-invalid' }, { status: 401 }));
    const response = await session.fetch(`${origin}/v1/devices/self/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer device-token' },
    });
    expect(response.status).toBe(401);
    expect(session.state.status).toBe('connected');
  });

  it('single-flights refresh and rotates stored credentials without exposing them to UI state', async () => {
    const { session, save, requests, states } = setup();
    await save({ expiresAt: Date.now() - 1000 });
    await session.initialize();
    await Promise.all([
      session.ensure(),
      session.ensure(),
      session.headers(`${origin}/v1/devices/pairings`),
    ]);
    expect(requests.filter(({ url }) => url === metadata.token_endpoint)).toHaveLength(1);
    const refresh = requests.find(({ url }) => url === metadata.token_endpoint);
    expect(
      new URLSearchParams(typeof refresh?.init.body === 'string' ? refresh.init.body : '').get(
        'grant_type',
      ),
    ).toBe('refresh_token');
    expect(JSON.stringify(states)).not.toContain(token.access_token);
    expect(JSON.stringify(states)).not.toContain(token.refresh_token);
  });

  it('refuses an untrusted issuer before posting any refresh token', async () => {
    const { session, save, network, requests } = setup();
    await save({ expiresAt: Date.now() - 1000 });
    network.mockImplementation((url) =>
      Promise.resolve(
        Response.json({
          ...metadata,
          issuer: 'https://attacker.test',
          token_endpoint: 'https://attacker.test/token',
          url,
        }),
      ),
    );
    await session.initialize();
    expect(session.state.status).toBe('error');
    expect(requests).toHaveLength(0);
    expect(network.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('clears credentials on rejected refresh and requires a new sign-in', async () => {
    const { session, save, network, file } = setup();
    await save({ expiresAt: Date.now() - 1000 });
    network.mockImplementation((url) =>
      Promise.resolve(
        url === metadata.token_endpoint
          ? Response.json({ error: 'invalid_grant' }, { status: 400 })
          : Response.json(metadata),
      ),
    );
    await session.initialize();
    expect(['required', 'error']).toContain(session.state.status);
    await expect(readFile(file)).rejects.toThrow();
  });

  it('removes local credentials and revokes remotely when the issuer advertises revocation', async () => {
    const { session, save, file, requests } = setup();
    await save({ expiresAt: Date.now() - 1000 });
    await session.initialize();
    await session.signOut();
    await expect(readFile(file)).rejects.toThrow();
    expect(session.state.status).toBe('required');
    expect(requests.some(({ url }) => url === metadata.revocation_endpoint)).toBe(true);
  });

  it('does not let a late refresh restore credentials after sign-out', async () => {
    let now = Date.now();
    const { session, save, network, file } = setup({ now: () => now });
    await save({ expiresAt: now + 900_000 });
    await session.initialize();
    let respond: (response: Response) => void = () => undefined;
    const refreshResponse = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    let refreshing = false;
    network.mockImplementation((url) => {
      if (url === metadata.token_endpoint) {
        refreshing = true;
        return refreshResponse;
      }
      return Promise.resolve(
        Response.json(url.endsWith('/.well-known/oauth-authorization-server') ? metadata : {}),
      );
    });
    now += 901_000;
    const pending = session.ensure();
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await vi.waitFor(() => {
      expect(refreshing).toBe(true);
    });
    await session.signOut();
    respond(Response.json(token));
    await rejected;
    expect(session.state.status).toBe('required');
    await expect(readFile(file)).rejects.toThrow();
    await expect(session.headers(`${origin}/v1/devices/pairings`)).rejects.toBeInstanceOf(
      AccessRequiredError,
    );
  });

  it('refuses browser sign-in when OS-backed storage is unavailable', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const { session, network, file } = setup({
      storage: fakeSafeStorage({ available: false }),
      openExternal,
    });
    await session.signIn();
    expect(session.state.status).toBe('error');
    expect(openExternal).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    await expect(readFile(file)).rejects.toThrow();
  });
});
