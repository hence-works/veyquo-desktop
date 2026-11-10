// Cloudflare Access is an outer, per-person staging gate. Device pairing and signed
// device tokens remain independent. OAuth credentials never cross the preload bridge.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';

import { z } from 'zod';

import { writeFileDurably } from './durable-file.ts';
import type { SecretStorage } from './keystore.ts';
import type { Fetch } from './api.ts';
import type { AccessState } from '../shared/ui-state.ts';

const stagingOrigin = 'https://staging-api.veyquo.xyz';
const stagingIssuer = 'https://hence-labs.cloudflareaccess.com';
const allowedEndpointPaths = new Set([
  '/cdn-cgi/access/oauth/authorization',
  '/cdn-cgi/access/oauth/token',
  '/cdn-cgi/access/oauth/registration',
  '/cdn-cgi/access/oauth/revoke',
]);
const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()),
});
type Metadata = z.infer<typeof metadataSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  token_type: z.string().regex(/^bearer$/iu),
  expires_in: z.number().int().positive().max(86400),
  refresh_token: z.string().min(1).max(16384).optional(),
  resource: z.string().max(4096).optional(),
});
const savedSchema = z.object({
  origin: z.literal(stagingOrigin),
  issuer: z.literal(stagingIssuer),
  clientId: z.string().min(1).max(4096),
  accessToken: z.string().min(1).max(16384),
  refreshToken: z.string().min(1).max(16384).nullable(),
  expiresAt: z.number().positive(),
});
type SavedSession = z.infer<typeof savedSchema>;

export class AccessRequiredError extends Error {
  constructor() {
    super('Sign in to staging in your browser before connecting this computer.');
    this.name = 'AccessRequiredError';
  }
}
export class AccessSignInError extends Error {
  constructor() {
    super('Staging sign-in could not finish. Try again in your browser.');
    this.name = 'AccessSignInError';
  }
}
class AccessCancelledError extends Error {
  constructor() {
    super('Staging sign-in was cancelled.');
    this.name = 'AccessCancelledError';
  }
}

interface Callback {
  redirectUri: string;
  code: Promise<string>;
  close(): void;
}
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only one random loopback path can complete the flow; unrelated/invalid requests cannot
 * consume it. The callback page contains no code, state or other request content. */
export async function oauthCallback(state: string, signal: AbortSignal): Promise<Callback> {
  const path = `/oauth/${randomBytes(24).toString('hex')}`;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  let settled = false;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Sign-in may fail before it starts awaiting the callback (for example registration).
  void code.catch(() => undefined);
  let redirectUri = '';
  const finish = (): void => {
    signal.removeEventListener('abort', abort);
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectCode(error);
    finish();
  };
  const abort = (): void => {
    fail(new AccessCancelledError());
  };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    let url: URL;
    try {
      url = new URL(request.url ?? '/', redirectUri);
    } catch {
      response.writeHead(400).end('This sign-in response is not valid. Return to Veyquo.');
      return;
    }
    if (
      request.method !== 'GET' ||
      url.pathname !== path ||
      request.headers.host !== new URL(redirectUri).host ||
      url.origin !== new URL(redirectUri).origin ||
      url.searchParams.getAll('state').length !== 1 ||
      !sameSecret(url.searchParams.get('state') ?? '', state)
    ) {
      response.writeHead(400).end('This sign-in response is not valid. Return to Veyquo.');
      return;
    }
    const codes = url.searchParams.getAll('code');
    if (
      url.searchParams.has('error') ||
      codes.length !== 1 ||
      !codes[0] ||
      codes[0].length > 8192
    ) {
      response.writeHead(400).end('Sign-in was not completed. Return to Veyquo.');
      fail(new AccessSignInError());
      return;
    }
    if (settled) {
      response.writeHead(410).end('This sign-in has finished.');
      return;
    }
    settled = true;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Sign-in received. You can close this tab and return to Veyquo.');
    resolveCode(codes[0]);
    // Closing after `finish` lets the small response finish writing first.
    response.on('finish', finish);
  });
  const timer = setTimeout(() => {
    fail(new AccessSignInError());
  }, 5 * 60_000);
  timer.unref();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    server.closeAllConnections();
    throw new AccessSignInError();
  }
  server.on('error', () => {
    fail(new AccessSignInError());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new AccessSignInError();
  redirectUri = `http://127.0.0.1:${String(address.port)}${path}`;
  if (signal.aborted) abort();
  return {
    redirectUri,
    code,
    close: () => {
      fail(new AccessCancelledError());
    },
  };
}

export interface AccessSessionOptions {
  apiUrl: string;
  file: string;
  storage: SecretStorage;
  platform: NodeJS.Platform;
  openExternal: (url: string) => Promise<void>;
  onState: (state: AccessState) => void;
  fetch?: Fetch;
  now?: () => number;
}

export class AccessSession {
  private readonly options: AccessSessionOptions;
  private readonly network: Fetch;
  private readonly origin: string;
  private metadata: Metadata | null = null;
  private session: SavedSession | null = null;
  private pending: AbortController | null = null;
  private refreshing: Promise<void> | null = null;
  private current: AccessState = { status: 'unknown', message: null };
  private generation = 0;
  private fileMutation: Promise<void> = Promise.resolve();

  constructor(options: AccessSessionOptions) {
    this.options = options;
    this.origin = new URL(options.apiUrl).origin;
    this.network = options.fetch ?? ((url, init) => fetch(url, init));
  }

  get state(): AccessState {
    return this.current;
  }

  private publish(status: AccessState['status'], message: string | null = null): void {
    this.current = { status, message };
    this.options.onState(this.current);
  }

  private mutateFile(operation: () => Promise<void>): Promise<void> {
    const result = this.fileMutation.then(operation);
    this.fileMutation = result.catch(() => undefined);
    return result;
  }

  private available(): boolean {
    if (!this.options.storage.isEncryptionAvailable()) return false;
    return (
      this.options.platform !== 'linux' ||
      !new Set(['basic_text', 'unknown']).has(
        this.options.storage.getSelectedStorageBackend?.() ?? 'unknown',
      )
    );
  }

  private endpoint(value: string): string {
    const url = new URL(value);
    if (
      url.origin !== stagingIssuer ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !allowedEndpointPaths.has(url.pathname)
    )
      throw new AccessSignInError();
    return url.href;
  }

  private async json(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length > 65536) throw new AccessSignInError();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AccessSignInError();
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    return this.network(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  }

  private async discover(): Promise<Metadata | null> {
    if (this.metadata !== null) return this.metadata;
    if (this.origin !== stagingOrigin) return null;
    const response = await this.request(`${this.origin}/.well-known/oauth-authorization-server`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const appMetadata = metadataSchema
      .partial({ registration_endpoint: true })
      .safeParse(await this.json(response));
    if (!appMetadata.success || appMetadata.data.issuer.replace(/\/$/u, '') !== stagingIssuer) {
      throw new AccessSignInError();
    }
    // The application's discovery can omit DCR. Its pinned issuer publishes the complete
    // authorization-server metadata, including the registration endpoint.
    const complete =
      appMetadata.data.registration_endpoint === undefined
        ? await this.request(`${stagingIssuer}/.well-known/oauth-authorization-server`, {
            method: 'GET',
            headers: { accept: 'application/json' },
          })
        : null;
    if (complete !== null && !complete.ok) throw new AccessSignInError();
    const parsed = metadataSchema.safeParse(
      complete === null ? appMetadata.data : await this.json(complete),
    );
    if (
      !parsed.success ||
      parsed.data.issuer.replace(/\/$/u, '') !== stagingIssuer ||
      !parsed.data.code_challenge_methods_supported.includes('S256')
    )
      throw new AccessSignInError();
    for (const endpoint of [
      parsed.data.authorization_endpoint,
      parsed.data.token_endpoint,
      parsed.data.registration_endpoint,
      parsed.data.revocation_endpoint,
    ]) {
      if (endpoint !== undefined) this.endpoint(endpoint);
    }
    this.metadata = parsed.data;
    return this.metadata;
  }

  async initialize(): Promise<void> {
    if (this.origin !== stagingOrigin) {
      this.publish('not_required');
      return;
    }
    const generation = this.generation;
    try {
      if (this.available()) {
        const encrypted = await readFile(this.options.file).catch(() => null);
        if (encrypted !== null) {
          const parsed = savedSchema.safeParse(
            JSON.parse(this.options.storage.decryptString(encrypted)),
          );
          if (generation !== this.generation) return;
          if (parsed.success) this.session = parsed.data;
        }
      }
      if (this.session !== null) await this.ensure();
      if (generation !== this.generation) return;
      const response = await this.network(`${this.origin}/v1/devices/pairings`, {
        method: 'GET',
        headers: await this.headers(`${this.origin}/v1/devices/pairings`),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if (generation !== this.generation) return;
      if (this.isChallenge(response)) await this.required();
      else this.publish(this.session === null ? 'not_required' : 'connected');
    } catch {
      if (generation !== this.generation) return;
      this.publish(
        'error',
        'Staging access could not be checked. Check your connection and try signing in.',
      );
    }
  }

  /** Access challenges are distinguished from Veyquo's device 401 responses. */
  isChallenge(response: Response): boolean {
    if (this.origin !== stagingOrigin) return false;
    const challenge = response.headers.get('www-authenticate') ?? '';
    if (response.status === 401 && /resource_metadata|cloudflare/iu.test(challenge)) return true;
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location !== null) {
      try {
        const url = new URL(location, this.origin);
        return url.origin === stagingIssuer && url.pathname.startsWith('/cdn-cgi/access/login');
      } catch {
        return false;
      }
    }
    return false;
  }

  async required(): Promise<void> {
    this.session = null;
    this.generation += 1;
    this.publish(
      'required',
      'Sign in to staging in your browser. Your current VPN can stay connected.',
    );
    await this.mutateFile(() => rm(this.options.file, { force: true }));
  }

  async ensure(): Promise<void> {
    if (this.origin !== stagingOrigin) return;
    if (this.current.status === 'required' || this.current.status === 'signing_in')
      throw new AccessRequiredError();
    if (this.session === null) return;
    if (this.session.expiresAt > (this.options.now?.() ?? Date.now()) + 60_000) return;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  private async persist(session: SavedSession, generation: number): Promise<void> {
    await this.mutateFile(async () => {
      if (generation !== this.generation) throw new AccessCancelledError();
      if (!this.available()) throw new AccessSignInError();
      await writeFileDurably(
        this.options.file,
        this.options.storage.encryptString(JSON.stringify(session)),
      );
      if (generation !== this.generation) {
        // File mutations are serialized: this can remove only this generation's write,
        // never a newer sign-in's session queued behind it.
        await rm(this.options.file, { force: true });
        throw new AccessCancelledError();
      }
      this.session = session;
      this.publish('connected', 'This computer is signed in to staging.');
    });
  }

  private async parseToken(response: Response): Promise<z.infer<typeof tokenSchema>> {
    const parsed = tokenSchema.safeParse(await this.json(response));
    if (!parsed.success) throw new AccessSignInError();
    if (parsed.data.resource !== undefined) {
      const resource = new URL(parsed.data.resource);
      if (
        resource.origin !== this.origin ||
        resource.pathname !== '/' ||
        resource.search ||
        resource.hash ||
        resource.username ||
        resource.password
      )
        throw new AccessSignInError();
    }
    return parsed.data;
  }

  private async exchange(metadata: Metadata, body: URLSearchParams): Promise<Response> {
    return this.request(this.endpoint(metadata.token_endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
  }

  private async refresh(): Promise<void> {
    const saved = this.session;
    if (saved?.refreshToken === null || saved === null) {
      await this.required();
      throw new AccessRequiredError();
    }
    const generation = this.generation;
    const metadata = await this.discover();
    if (metadata === null) throw new AccessSignInError();
    const response = await this.exchange(
      metadata,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: saved.refreshToken,
        client_id: saved.clientId,
        resource: this.origin,
      }),
    );
    if (generation !== this.generation) throw new AccessCancelledError();
    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403)
        await this.required();
      throw new AccessRequiredError();
    }
    const token = await this.parseToken(response);
    await this.persist(
      {
        ...saved,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? saved.refreshToken,
        expiresAt: (this.options.now?.() ?? Date.now()) + token.expires_in * 1000,
      },
      generation,
    );
  }

  async signIn(): Promise<void> {
    if (this.origin !== stagingOrigin || this.pending !== null) return;
    const abort = new AbortController();
    this.pending = abort;
    const generation = ++this.generation;
    let callback: Callback | null = null;
    this.publish('signing_in', 'Finish signing in in your browser, then return to Veyquo.');
    try {
      if (!this.available()) throw new AccessSignInError();
      const metadata = await this.discover();
      if (metadata === null) throw new AccessSignInError();
      const state = randomBytes(32).toString('base64url');
      let verifier: string;
      let challenge: string;
      // Access currently rejects a base64url challenge beginning with '-' or '_'.
      // Regenerate fresh random verifier material; never weaken or truncate PKCE.
      do {
        verifier = randomBytes(48).toString('base64url');
        challenge = createHash('sha256').update(verifier).digest('base64url');
      } while (!/^[a-zA-Z0-9]/u.test(challenge));
      callback = await oauthCallback(state, abort.signal);
      const registration = await this.request(this.endpoint(metadata.registration_endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'Veyquo desktop',
          resource: this.origin,
          redirect_uris: [callback.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });
      if (!registration.ok) throw new AccessSignInError();
      const client = z
        .object({
          client_id: z.string().min(1).max(4096),
          token_endpoint_auth_method: z.literal('none').optional(),
        })
        .parse(await this.json(registration));
      abort.signal.throwIfAborted();
      const login = new URL(this.endpoint(metadata.authorization_endpoint));
      login.search = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: callback.redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: this.origin,
      }).toString();
      await this.options.openExternal(login.href);
      const code = await callback.code;
      abort.signal.throwIfAborted();
      const response = await this.exchange(
        metadata,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: callback.redirectUri,
          resource: this.origin,
        }),
      );
      if (!response.ok) throw new AccessSignInError();
      const token = await this.parseToken(response);
      await this.persist(
        {
          origin: stagingOrigin,
          issuer: stagingIssuer,
          clientId: client.client_id,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? null,
          expiresAt: (this.options.now?.() ?? Date.now()) + token.expires_in * 1000,
        },
        generation,
      );
    } catch (error) {
      if (error instanceof AccessCancelledError || abort.signal.aborted) {
        this.publish('required', 'Staging sign-in was cancelled. You can try again.');
      } else {
        this.publish('error', 'Staging sign-in could not finish. Check your access and try again.');
      }
    } finally {
      callback?.close();
      if (this.pending === abort) this.pending = null;
    }
  }

  cancel(): void {
    this.generation += 1;
    this.pending?.abort();
  }

  async signOut(): Promise<void> {
    if (this.origin !== stagingOrigin) return;
    this.cancel();
    const generation = this.generation;
    const saved = this.session;
    this.session = null;
    await this.mutateFile(() => rm(this.options.file, { force: true }));
    if (generation === this.generation)
      this.publish('required', 'Sign in to staging to reconnect this computer.');
    if (saved !== null) {
      const revoke =
        this.metadata?.revocation_endpoint ?? `${stagingIssuer}/cdn-cgi/access/oauth/revoke`;
      await this.request(this.endpoint(revoke), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: saved.refreshToken ?? saved.accessToken,
          client_id: saved.clientId,
        }).toString(),
      }).catch(() => undefined);
    }
  }

  close(): void {
    this.cancel();
    this.session = null;
  }

  async headers(url: string, original: HeadersInit = {}): Promise<Record<string, string>> {
    const target = new URL(url);
    if (target.protocol === 'wss:') target.protocol = 'https:';
    if (target.protocol === 'ws:') target.protocol = 'http:';
    if (target.origin !== this.origin) throw new AccessSignInError();
    await this.ensure();
    const headers = new Headers(original);
    if (this.session !== null) {
      const authorization = headers.get('authorization');
      if (authorization !== null) {
        // This is the only device HTTP route that uses Veyquo's bearer token. Cloudflare
        // consumes Authorization; the origin validates the separate device credential.
        if (target.pathname !== '/v1/devices/self/revoke') throw new AccessSignInError();
        headers.set('X-Veyquo-Device-Token', authorization.replace(/^Bearer /iu, ''));
      }
      headers.set('authorization', `Bearer ${this.session.accessToken}`);
    }
    return Object.fromEntries(headers.entries());
  }

  /** Call after ensure(), immediately before opening the websocket. Tokens stay out of
   * URLs and subprotocols; the separate Veyquo token remains in its existing subprotocol. */
  socketHeaders(url: string): Record<string, string> {
    const target = new URL(url);
    target.protocol =
      target.protocol === 'wss:' ? 'https:' : target.protocol === 'ws:' ? 'http:' : target.protocol;
    if (target.origin !== this.origin) throw new AccessSignInError();
    return this.session === null ? {} : { authorization: `Bearer ${this.session.accessToken}` };
  }

  readonly fetch: Fetch = async (url, init) => {
    const headers = await this.headers(url, init.headers);
    const generation = this.generation;
    const response = await this.network(url, {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (this.isChallenge(response)) {
      if (generation === this.generation) await this.required();
      throw new AccessRequiredError();
    }
    if (response.status >= 300 && response.status < 400) throw new AccessSignInError();
    return response;
  };
}
