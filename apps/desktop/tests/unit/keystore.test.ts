import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Keystore, SecureStorageUnavailableError } from '../../src/main/keystore.ts';
import { fakeSafeStorage } from '../support/fakes.ts';

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

function publicKey(b64: string) {
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(b64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'veyquo-keystore-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Keystore', () => {
  it('key survives restart', async () => {
    const storage = fakeSafeStorage();
    const created = await new Keystore({ dir, storage, platform: 'darwin' }).create();
    await new Keystore({ dir, storage, platform: 'darwin' }).setDeviceId(
      '6F1C2B8E-0D5A-4C33-9D0E-2A1B3C4D5E6F',
    );

    const restarted = new Keystore({ dir, storage, platform: 'darwin' });
    const loaded = await restarted.load();
    expect(loaded?.publicKeyB64).toBe(created.publicKeyB64);
    expect(await restarted.deviceId()).toBe('6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f');
    const message = Buffer.from('veyquo-device-token:nonce');
    const signature = loaded?.sign(message) ?? Buffer.alloc(0);
    expect(verify(null, message, publicKey(created.publicKeyB64), signature)).toBe(true);
  });

  it('keeps the private key only encrypted on disk', async () => {
    const storage = fakeSafeStorage();
    await new Keystore({ dir, storage, platform: 'win32' }).create();
    const onDisk = await readFile(join(dir, 'device-key.bin'));
    expect(storage.encrypted).toHaveLength(1);
    expect(onDisk.equals(storage.encrypted[0] ?? Buffer.alloc(0))).toBe(true);
    // PKCS8 DER of an Ed25519 key starts 30 2e 02 01 00: never written in the clear.
    expect(onDisk.includes(Buffer.from('302e020100', 'hex'))).toBe(false);
  });

  it('refuses without safeStorage', async () => {
    const keystore = new Keystore({
      dir,
      storage: fakeSafeStorage({ available: false }),
      platform: 'darwin',
    });
    await expect(keystore.create()).rejects.toThrow(SecureStorageUnavailableError);
    await expect(keystore.create()).rejects.toThrow(/secure storage/u);
    expect(await readdir(dir)).toEqual([]);
    expect(keystore.available()).toBe(false);
  });

  it("refuses Linux's plain-text fallback unless development allows it", async () => {
    const storage = fakeSafeStorage({ backend: 'basic_text' });
    await expect(new Keystore({ dir, storage, platform: 'linux' }).create()).rejects.toThrow(
      SecureStorageUnavailableError,
    );
    const dev = new Keystore({ dir, storage, platform: 'linux', allowPlainTextLinux: true });
    await expect(dev.create()).resolves.toHaveProperty('publicKeyB64');
  });

  it('a new pairing replaces the key and forgets the old device id', async () => {
    const keystore = new Keystore({ dir, storage: fakeSafeStorage(), platform: 'darwin' });
    const first = await keystore.create();
    await keystore.setDeviceId('6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f');
    const second = await keystore.create();
    expect(second.publicKeyB64).not.toBe(first.publicKeyB64);
    expect(await keystore.deviceId()).toBeNull();
  });

  it('erase removes the key and the device id', async () => {
    const keystore = new Keystore({ dir, storage: fakeSafeStorage(), platform: 'darwin' });
    await keystore.create();
    await keystore.setDeviceId('6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f');
    await keystore.erase();
    expect(await keystore.load()).toBeNull();
    expect(await keystore.deviceId()).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});
