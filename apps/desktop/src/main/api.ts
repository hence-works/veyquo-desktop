// The few device routes of the Veyquo API the app calls (services/api/src/api/devices):
// pairing, its status, and the challenge/token exchange. Responses are untrusted input and
// are parsed with Zod at this boundary. The app never calls any other API route: the device
// token can only hold the socket (desktop plan §4.4).

import { z } from 'zod';

export class ApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number) {
    // The path carries ids only; never the query or a body.
    super(`${method} ${path} answered ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The API refused a token because this computer was removed from the account. */
export class DeviceRevokedError extends Error {
  constructor() {
    super('this computer was removed from its Veyquo account');
    this.name = 'DeviceRevokedError';
  }
}

const pairingStarted = z.object({
  pairing_id: z.uuid(),
  code: z.string().min(4).max(32),
  approve_url: z.url({ protocol: /^https?$/u }),
  poll_token: z.string().min(1).max(256),
  expires_at: z.string(),
});
export type PairingStarted = z.infer<typeof pairingStarted>;

const pairingStatus = z.object({
  status: z.enum(['pending', 'approved', 'expired']),
  device_id: z.uuid().nullable().optional(),
});
export type PairingStatus = z.infer<typeof pairingStatus>;

const challenge = z.object({ nonce: z.string().min(1).max(256) });
const token = z.object({
  access_token: z.string().min(1).max(8192),
  expires_in: z.number().int().positive(),
});
export type DeviceToken = z.infer<typeof token>;

const browserSettings = z.object({
  selected_modes: z.array(z.enum(['veyquo_profile', 'everyday_profile'])),
  profiles: z
    .array(
      z.object({
        view_id: z.uuid(),
        name: z.string(),
        chrome_mode: z.enum(['veyquo_profile', 'everyday_profile']),
        has_proxy: z.boolean(),
      }),
    )
    .default([]),
});
export type DeviceBrowserSettings = z.infer<typeof browserSettings>;

const egressSettings = z.object({
  enabled: z.boolean(),
  enabled_at: z.string().nullable(),
});
export type DeviceEgressSettings = z.infer<typeof egressSettings>;

const problem = z.object({ type: z.string().optional() }).loose();

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class DevicesApi {
  private readonly base: string;
  private readonly fetch: Fetch;

  constructor(apiUrl: string, fetchImpl: Fetch = (url, init) => fetch(url, init)) {
    this.base = apiUrl.replace(/\/+$/u, '');
    this.fetch = fetchImpl;
  }

  /** The WebSocket URL of the device gateway. */
  get connectUrl(): string {
    return `${this.base.replace(/^http/u, 'ws')}/v1/devices/connect`;
  }

  /** The dedicated binary relay endpoint. It shares the trusted API origin at ingress but
   * is served by a separate relay process. */
  get egressConnectUrl(): string {
    return `${this.base.replace(/^http/u, 'ws')}/v1/device-egress/connect`;
  }

  startPairing(body: {
    public_key_b64: string;
    os: string;
    app_version: string;
    name_hint: string | null;
  }): Promise<PairingStarted> {
    return this.call('POST', '/v1/devices/pairings', pairingStarted, { body });
  }

  pairingStatus(pairingId: string, pollToken: string): Promise<PairingStatus> {
    return this.call('GET', `/v1/devices/pairings/${pairingId}`, pairingStatus, {
      headers: { 'X-Pairing-Token': pollToken },
    });
  }

  async challenge(deviceId: string): Promise<string> {
    const answer = await this.call('POST', `/v1/devices/${deviceId}/challenge`, challenge, {
      body: {},
      deviceRoute: true,
    });
    return answer.nonce;
  }

  token(deviceId: string, nonce: string, signatureB64: string): Promise<DeviceToken> {
    return this.call('POST', `/v1/devices/${deviceId}/token`, token, {
      body: { nonce, signature_b64: signatureB64 },
      deviceRoute: true,
    });
  }

  browserSettings(deviceToken: string): Promise<DeviceBrowserSettings> {
    return this.call('GET', '/v1/devices/self/browser-settings', browserSettings, {
      headers: { Authorization: `Bearer ${deviceToken}` },
      deviceRoute: true,
    });
  }

  updateBrowserMode(
    deviceToken: string,
    viewId: string,
    mode: 'veyquo_profile' | 'everyday_profile',
  ): Promise<DeviceBrowserSettings> {
    return this.call('PATCH', `/v1/devices/self/browser-settings/${viewId}`, browserSettings, {
      headers: { Authorization: `Bearer ${deviceToken}` },
      body: { chrome_mode: mode },
      deviceRoute: true,
    });
  }

  egress(deviceToken: string): Promise<DeviceEgressSettings> {
    return this.call('GET', '/v1/devices/self/egress', egressSettings, {
      headers: { Authorization: `Bearer ${deviceToken}` },
      deviceRoute: true,
    });
  }

  updateEgress(deviceToken: string, enabled: boolean): Promise<DeviceEgressSettings> {
    return this.call('PUT', '/v1/devices/self/egress', egressSettings, {
      headers: { Authorization: `Bearer ${deviceToken}` },
      body: { enabled },
      deviceRoute: true,
    });
  }

  /** Revokes this device with its own token (removal from the computer). Already revoked
   * counts as done. */
  async revokeSelf(deviceToken: string): Promise<void> {
    const path = '/v1/devices/self/revoke';
    const response = await this.fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${deviceToken}` },
      redirect: 'error',
    });
    if (!response.ok) throw new ApiError('POST', path, response.status);
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    path: string,
    schema: z.ZodType<T>,
    options: { body?: unknown; headers?: Record<string, string>; deviceRoute?: boolean } = {},
  ): Promise<T> {
    const response = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'error',
    });
    if (!response.ok) {
      // On a device route, `device-revoked` (403) and `device-not-found` (404) both mean this
      // computer no longer belongs to an account: the gateway's 4401 says the same.
      if (options.deviceRoute === true && (response.status === 403 || response.status === 404)) {
        const body = problem.safeParse(await response.json().catch(() => null));
        const type = body.success ? (body.data.type ?? '') : '';
        if (type.endsWith('device-revoked') || type.endsWith('device-not-found')) {
          throw new DeviceRevokedError();
        }
      }
      throw new ApiError(method, path, response.status);
    }
    return schema.parse(await response.json());
  }
}
