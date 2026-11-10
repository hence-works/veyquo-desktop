// The device access token (desktop plan §4.4): the device signs a server challenge with its
// key and gets a short-lived token, which only holds the gateway socket. The token is kept
// in memory only, and replaced 60 s before it expires; a 4403 close drops it at once.

import { deviceTokenMessage } from '@veyquo/local-executor';

import type { DevicesApi } from './api.ts';
import type { DeviceKey } from './keystore.ts';

/** How long before expiry a token is replaced. */
export const tokenRefreshMarginMs = 60_000;

export class DeviceAuth {
  private readonly api: Pick<DevicesApi, 'challenge' | 'token'>;
  private readonly deviceId: string;
  private readonly key: DeviceKey;
  private readonly now: () => number;
  private cached: { token: string; refreshAt: number } | null = null;

  constructor(options: {
    api: Pick<DevicesApi, 'challenge' | 'token'>;
    deviceId: string;
    key: DeviceKey;
    /** Monotonic milliseconds (expiry is relative, never compared across clocks). */
    now?: () => number;
  }) {
    this.api = options.api;
    this.deviceId = options.deviceId;
    this.key = options.key;
    this.now = options.now ?? (() => performance.now());
  }

  /** A token good for at least another minute. Throws `DeviceRevokedError` when the
   * computer was removed from the account. */
  async token(): Promise<string> {
    if (this.cached !== null && this.now() < this.cached.refreshAt) return this.cached.token;
    this.cached = null;
    const requested = this.now();
    const nonce = await this.api.challenge(this.deviceId);
    const signature = this.key.sign(deviceTokenMessage(nonce)).toString('base64');
    const answer = await this.api.token(this.deviceId, nonce, signature);
    this.cached = {
      token: answer.access_token,
      refreshAt: requested + answer.expires_in * 1000 - tokenRefreshMarginMs,
    };
    return answer.access_token;
  }

  invalidate(): void {
    this.cached = null;
  }
}
