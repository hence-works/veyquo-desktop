// The device key (desktop plan §4.4, §7): an Ed25519 key pair made with `node:crypto`. The
// private key is stored as PKCS8 DER, encrypted with Electron's `safeStorage` (Keychain on
// macOS, DPAPI on Windows, the Secret Service on Linux), in `userData/device-key.bin`. It
// never leaves this module in the clear: callers get a `sign` function.
//
// Without OS-backed secret storage the app refuses to pair. On Linux, `safeStorage` falls
// back to a hard-coded plain-text key when no keyring is running ("basic_text"); that is
// refused too, unless development explicitly allows it (Linux builds are for development
// and CI only).

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileDurably } from './durable-file.ts';

/** The part of Electron's `safeStorage` the keystore uses. */
export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only in Electron; other platforms report no backend. */
  getSelectedStorageBackend?: () => string;
}

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super(
      "This computer's secure storage is not available, so Veyquo cannot keep its device key " +
        'safely. Pairing is turned off until it is.',
    );
    this.name = 'SecureStorageUnavailableError';
  }
}

export interface DeviceKey {
  /** Base64 of the 32 raw public-key bytes, as the API expects. */
  readonly publicKeyB64: string;
  sign(message: Uint8Array): Buffer;
}

const plainTextBackends = new Set(['basic_text', 'unknown']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function deviceKey(privateKey: KeyObject): DeviceKey {
  const publicKeyB64 = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
  return {
    publicKeyB64,
    sign: (message) => sign(null, message, privateKey),
  };
}

export class Keystore {
  private readonly keyFile: string;
  private readonly deviceFile: string;
  private readonly storage: SecretStorage;
  private readonly platform: NodeJS.Platform;
  private readonly allowPlainTextLinux: boolean;

  constructor(options: {
    dir: string;
    storage: SecretStorage;
    platform: NodeJS.Platform;
    allowPlainTextLinux?: boolean;
  }) {
    this.keyFile = join(options.dir, 'device-key.bin');
    this.deviceFile = join(options.dir, 'device.json');
    this.storage = options.storage;
    this.platform = options.platform;
    this.allowPlainTextLinux = options.allowPlainTextLinux ?? false;
  }

  /** Whether a device key can be kept safely here. */
  available(): boolean {
    if (!this.storage.isEncryptionAvailable()) return false;
    if (this.platform !== 'linux' || this.allowPlainTextLinux) return true;
    const backend = this.storage.getSelectedStorageBackend?.() ?? 'unknown';
    return !plainTextBackends.has(backend);
  }

  /** A new key pair for a new pairing. Replaces any earlier key and forgets its device. */
  async create(): Promise<DeviceKey> {
    if (!this.available()) throw new SecureStorageUnavailableError();
    const { privateKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    await rm(this.deviceFile, { force: true });
    await writeFileDurably(this.keyFile, this.storage.encryptString(pkcs8));
    return deviceKey(privateKey);
  }

  /** The stored key, or null when there is none. */
  async load(): Promise<DeviceKey | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.keyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (!this.available()) throw new SecureStorageUnavailableError();
    const pkcs8 = Buffer.from(this.storage.decryptString(encrypted), 'base64');
    return deviceKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
  }

  /** Records the device id the API gave this key when the person approved the pairing. */
  async setDeviceId(deviceId: string): Promise<void> {
    const id = deviceId.toLowerCase();
    if (!uuidPattern.test(id)) throw new Error('a device id is a UUID');
    await writeFileDurably(this.deviceFile, `${JSON.stringify({ device_id: id })}\n`);
  }

  async deviceId(): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(this.deviceFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as { device_id?: unknown };
      const id = typeof parsed.device_id === 'string' ? parsed.device_id : '';
      return uuidPattern.test(id) ? id : null;
    } catch {
      return null; // unreadable: treated as not paired, so the person pairs again
    }
  }

  /** Deletes the key and the device id (revocation, removal). */
  async erase(): Promise<void> {
    await rm(this.keyFile, { force: true });
    await rm(this.deviceFile, { force: true });
  }
}
