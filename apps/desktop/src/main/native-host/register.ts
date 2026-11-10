// Registers the app as Google Chrome's native-messaging host `works.hence.veyquo` for the
// current user (desktop plan §4.2), so the Veyquo extension can reach it:
//
// - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/works.hence.veyquo.json`
// - Linux: `~/.config/google-chrome/NativeMessagingHosts/works.hence.veyquo.json`
// - Windows: the manifest in `<userData>/native-host/`, found by Chrome through
//   `HKCU\Software\Google\Chrome\NativeMessagingHosts\works.hence.veyquo` (its default value).
//
// The manifest admits only the Veyquo extension (`allowed_origins`). Its `path` is a launcher
// in `<userData>/native-host/` (a shell script, or a `.cmd` on Windows) that starts the app's
// own binary with `--native-host`: the packaged app runs no loose script and never as plain
// Node (Electron fuses: runAsNode off, onlyLoadAppFromAsar on). Registration is rewritten on
// every start, so an update that moved the app is picked up; removal unregisters it.

import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';

import { extensionIds, nativeHostName } from '@veyquo/local-executor/extension-protocol';

/** The standalone host's file name in a packaged Windows build's resources folder. */
export const hostExecutableName = 'veyquo-native-host.exe';

export const windowsRegistryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${nativeHostName}`;

/** The per-user registry, as far as registration needs it (Windows only). */
export interface WindowsRegistry {
  setDefault(key: string, value: string): Promise<void>;
  /** Deletes the key; a key that is not there is fine. */
  deleteKey(key: string): Promise<void>;
}

export interface HostRegistration {
  platform: NodeJS.Platform;
  home: string;
  userData: string;
  /** The argv that starts this app: the packaged binary (or the AppImage); in development,
   * Electron and the app folder. `--native-host` is added. */
  command: readonly string[];
  /** Development only: environment the launcher sets (where the app keeps its state). */
  env?: Readonly<Record<string, string>>;
  registry: WindowsRegistry;
}

/** The argv the launcher runs before `--native-host`: the packaged binary (or its AppImage),
 * or in development Electron on the app folder. A Linux development run started with
 * `--no-sandbox` (hosts that restrict unprivileged user namespaces) passes it on, so the
 * host Chrome starts can run too. A packaged build never runs without the sandbox.
 *
 * On Windows it is the standalone host instead, told where the app keeps its state
 * (`standalone.ts`: Electron's own stdout is not clean there): from the resources folder when
 * packaged, and in development the one scripts/build.ts made in `build-host/`. */
export function hostCommand(options: {
  packaged: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  appPath: string;
  resourcesPath: string;
  userData: string;
  appImage?: string;
  noSandbox: boolean;
}): string[] {
  if (options.platform === 'win32') {
    const host = options.packaged
      ? win32.join(options.resourcesPath, hostExecutableName)
      : win32.join(options.appPath, 'build-host', hostExecutableName);
    return [host, '--user-data', options.userData];
  }
  if (options.packaged) return [options.appImage ?? options.execPath];
  const devNoSandbox = options.platform === 'linux' && options.noSandbox;
  return [options.execPath, options.appPath, ...(devNoSandbox ? ['--no-sandbox'] : [])];
}

type Where = Pick<HostRegistration, 'platform' | 'home' | 'userData'>;

const manifestName = `${nativeHostName}.json`;

export function manifestPath(where: Where): string {
  if (where.platform === 'darwin') {
    return join(
      where.home,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
      manifestName,
    );
  }
  if (where.platform === 'win32') return join(where.userData, 'native-host', manifestName);
  return join(where.home, '.config', 'google-chrome', 'NativeMessagingHosts', manifestName);
}

export function launcherPath(where: Where): string {
  const name = where.platform === 'win32' ? 'veyquo-native-host.cmd' : 'veyquo-native-host.sh';
  return join(where.userData, 'native-host', name);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function posixLauncher(reg: HostRegistration): string {
  const env = Object.entries(reg.env ?? {}).map(
    ([name, value]) => `export ${name}=${shellQuote(value)}\n`,
  );
  const argv = [...reg.command, '--native-host'].map(shellQuote).join(' ');
  return [
    '#!/bin/sh\n',
    '# Started by Google Chrome for the Veyquo extension. Written by the Veyquo app.\n',
    ...(env.length > 0 ? ['unset ELECTRON_RUN_AS_NODE\n', ...env] : []),
    `exec ${argv} "$@"\n`,
  ].join('');
}

function windowsLauncher(reg: HostRegistration): string {
  const quote = (value: string): string => `"${value.replaceAll('%', '%%')}"`;
  const env = Object.entries(reg.env ?? {}).map(
    ([name, value]) => `set "${name}=${value.replaceAll('%', '%%')}"\r\n`,
  );
  return ['@echo off\r\n', ...env, `${reg.command.map(quote).join(' ')} --native-host %*\r\n`].join(
    '',
  );
}

export async function registerNativeHost(reg: HostRegistration): Promise<void> {
  const launcher = launcherPath(reg);
  const manifest = manifestPath(reg);
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, reg.platform === 'win32' ? windowsLauncher(reg) : posixLauncher(reg), {
    mode: 0o700,
  });
  await chmod(launcher, 0o700);
  await mkdir(dirname(manifest), { recursive: true });
  const body = {
    name: nativeHostName,
    description: 'Veyquo desktop app',
    path: launcher,
    type: 'stdio',
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
  await writeFile(manifest, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
  if (reg.platform === 'win32') await reg.registry.setDefault(windowsRegistryKey, manifest);
}

export async function unregisterNativeHost(
  reg: Where & { registry: WindowsRegistry },
): Promise<void> {
  if (reg.platform === 'win32') await reg.registry.deleteKey(windowsRegistryKey);
  await rm(manifestPath(reg), { force: true });
  await rm(launcherPath(reg), { force: true });
  await rm(dirname(launcherPath(reg)), { recursive: true, force: true });
}

/** What a failed registration is logged with: the error's code and type, never its message,
 * which names paths under the person's home folder. */
export function registrationFailure(error: unknown): { code: string | null; type: string } {
  if (!(error instanceof Error)) return { code: null, type: 'unknown' };
  const code = (error as { code?: unknown }).code;
  return {
    code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) ? code : null,
    type: error.name,
  };
}

function reg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', [...args], { windowsHide: true }, (error) => {
      if (error === null) resolve();
      else reject(new Error(`reg.exe ${args[0] ?? ''} failed`));
    });
  });
}

/** `reg.exe` on the current user's hive. */
export const systemRegistry: WindowsRegistry = {
  setDefault: (key, value) => reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f']),
  deleteKey: (key) => reg(['delete', key, '/f']).catch(() => undefined),
};
