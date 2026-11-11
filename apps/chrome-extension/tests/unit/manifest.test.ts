import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extensionIds, nativeHostName } from '@veyquo/local-executor/extension-protocol';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'manifest.json'), 'utf8'),
) as {
  manifest_version: number;
  key: string;
  permissions: string[];
  host_permissions?: string[];
  content_scripts?: unknown;
  externally_connectable?: unknown;
  web_accessible_resources?: unknown;
  minimum_chrome_version: string;
};

/** Chrome's extension id: the SHA-256 of the public key, first 16 bytes, as a-p digits. */
function extensionId(publicKeyB64: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex');
  return hex.slice(0, 32).replace(/[0-9a-f]/gu, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

describe('manifest', () => {
  it('has the stable id the desktop app’s host manifest admits', () => {
    expect(extensionIds).toContain(extensionId(manifest.key));
  });

  it('holds a public key only', () => {
    expect(manifest.key).not.toMatch(/PRIVATE/u);
    expect(Buffer.from(manifest.key, 'base64').length).toBeLessThan(600);
  });

  it('asks for exactly what the everyday profile needs, and reaches no site itself', () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(
      ['debugger', 'nativeMessaging', 'tabGroups', 'tabs'].sort(),
    );
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(136);
  });

  it('names the host the desktop app registers', () => {
    expect(nativeHostName).toBe('works.hence.veyquo');
  });
});
