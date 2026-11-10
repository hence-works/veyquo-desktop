// Where `yarn dist:dir` / `yarn dist` leave the packaged executable on each operating system
// (electron-builder.yml: output `release`). macOS builds both architectures; the one that
// runs here is the host's.

import { join } from 'node:path';

import { hostExecutableName } from '../src/main/native-host/register.ts';

const root = join(import.meta.dirname, '..');

export function packagedExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'linux') return join(root, 'release', 'linux-unpacked', 'veyquo');
  if (platform === 'win32') return join(root, 'release', 'win-unpacked', 'Veyquo.exe');
  if (platform === 'darwin') {
    const dir = arch === 'arm64' ? 'mac-arm64' : 'mac';
    return join(root, 'release', dir, 'Veyquo.app', 'Contents', 'MacOS', 'Veyquo');
  }
  throw new Error(`no packaged app for ${platform}`);
}

/** The standalone native-messaging host a Windows build ships (scripts/host-executable.ts);
 * null elsewhere, where the app's own binary is the host. */
export function packagedHostExecutable(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  return join(root, 'release', 'win-unpacked', 'resources', hostExecutableName);
}
