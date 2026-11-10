// Finding the person's installed Google Chrome stable (desktop plan §8 startup checks;
// global constraints: Chrome stable only, at least 136). The version comes from
// `chrome --version` on macOS and Linux. On Windows that would start the browser, so it is
// read from the registry (`BLBeacon`, written by Chrome itself), else from the versioned
// folder next to chrome.exe.

import { posix, win32 } from 'node:path';

export const minChromeMajor = 136;

export type ChromeLocation =
  | { ok: true; path: string; version: string; major: number }
  | {
      ok: false;
      error: 'chrome_unavailable';
      reason: 'missing' | 'too_old' | 'unknown_version';
      path?: string;
      version?: string;
    };

export interface LocateDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists: (path: string) => Promise<boolean>;
  /** Runs a program and resolves with its stdout. */
  run: (file: string, args: string[]) => Promise<string>;
  listDir: (path: string) => Promise<string[]>;
}

const versionPattern = /\b(\d{2,4})\.(\d+)\.(\d+)\.(\d+)\b/u;

export function chromeCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
  if (platform === 'darwin') {
    return [posix.join('/Applications', app), posix.join(home, 'Applications', app)];
  }
  if (platform === 'win32') {
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter((root): root is string => root !== undefined && root.length > 0)
      .map((root) => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (platform === 'linux') {
    return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  }
  return [];
}

function parseVersion(text: string): { version: string; major: number } | null {
  const match = versionPattern.exec(text);
  if (match === null) return null;
  return { version: match.slice(1, 5).join('.'), major: Number(match[1]) };
}

async function windowsVersion(
  deps: LocateDeps,
  chrome: string,
): Promise<{ version: string; major: number } | null> {
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const out = await deps.run('reg', [
        'query',
        `${hive}\\Software\\Google\\Chrome\\BLBeacon`,
        '/v',
        'version',
      ]);
      const found = parseVersion(out);
      if (found !== null) return found;
    } catch {
      // No such key: try the next hive, then the install folder.
    }
  }
  try {
    const versions = (await deps.listDir(win32.dirname(chrome)))
      .map(parseVersion)
      .filter((found): found is { version: string; major: number } => found !== null)
      .sort((a, b) => compareVersions(b.version, a.version));
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 4; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function locateChrome(deps: LocateDeps): Promise<ChromeLocation> {
  // A development override (tests, a non-standard install); still version-checked.
  const override = deps.env.VEYQUO_CHROME_PATH;
  const candidates =
    override !== undefined && override.length > 0
      ? [override]
      : chromeCandidates(deps.platform, deps.env, deps.home);
  let path: string | undefined;
  for (const candidate of candidates) {
    if (await deps.exists(candidate)) {
      path = candidate;
      break;
    }
  }
  if (path === undefined) return { ok: false, error: 'chrome_unavailable', reason: 'missing' };
  let found: { version: string; major: number } | null;
  if (deps.platform === 'win32') {
    found = await windowsVersion(deps, path);
  } else {
    found = parseVersion(await deps.run(path, ['--version']).catch(() => ''));
  }
  if (found === null) {
    return { ok: false, error: 'chrome_unavailable', reason: 'unknown_version', path };
  }
  if (found.major < minChromeMajor) {
    return {
      ok: false,
      error: 'chrome_unavailable',
      reason: 'too_old',
      path,
      version: found.version,
    };
  }
  return { ok: true, path, version: found.version, major: found.major };
}
