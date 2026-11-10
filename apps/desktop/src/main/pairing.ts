// Pairing (desktop plan §4.4): a fresh device key, `POST /v1/devices/pairings`, the one-time
// code shown in the app, the API's `approve_url` opened in the person's default browser,
// then the pairing's status polled every 2 s until it is approved or expires. The signed-in
// person approves and names the computer in the web app; API tokens cannot pair.

import type { DevicesApi, PairingStarted } from './api.ts';
import type { DeviceKey, Keystore } from './keystore.ts';

export const pairingPollMs = 2000;

export class PairingExpiredError extends Error {
  constructor() {
    super('the pairing code expired before it was approved');
    this.name = 'PairingExpiredError';
  }
}

export class PairingCancelledError extends Error {
  constructor() {
    super('pairing was cancelled');
    this.name = 'PairingCancelledError';
  }
}

export interface PairingDeps {
  api: Pick<DevicesApi, 'startPairing' | 'pairingStatus'>;
  keystore: Pick<Keystore, 'create' | 'setDeviceId'>;
  openExternal: (url: string) => Promise<void>;
  /** The code and where the person approves it, for the window. */
  onCode: (pairing: Pick<PairingStarted, 'code' | 'approve_url' | 'expires_at'>) => void;
  os: string;
  appVersion: string;
  nameHint: string | null;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PairingCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PairingCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pairs this computer. Resolves with the device id and its key once approved. */
export async function pairDevice(deps: PairingDeps): Promise<{ deviceId: string; key: DeviceKey }> {
  const sleep = deps.sleep ?? abortableSleep;
  const key = await deps.keystore.create();
  const started = await deps.api.startPairing({
    public_key_b64: key.publicKeyB64,
    os: deps.os,
    app_version: deps.appVersion,
    name_hint: deps.nameHint,
  });
  deps.onCode({
    code: started.code,
    approve_url: started.approve_url,
    expires_at: started.expires_at,
  });
  await deps.openExternal(started.approve_url);
  for (;;) {
    await sleep(pairingPollMs, deps.signal);
    const status = await deps.api.pairingStatus(started.pairing_id, started.poll_token);
    if (status.status === 'approved' && typeof status.device_id === 'string') {
      await deps.keystore.setDeviceId(status.device_id);
      return { deviceId: status.device_id.toLowerCase(), key };
    }
    if (status.status === 'expired') throw new PairingExpiredError();
  }
}
