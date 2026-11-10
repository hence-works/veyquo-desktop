import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { extensionIds } from '@veyquo/local-executor/extension-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runNativeHost, type NativeHostExit } from '../../src/main/native-host/host.ts';
import {
  hostCommand,
  launcherPath,
  manifestPath,
  registrationFailure,
  registerNativeHost,
  unregisterNativeHost,
  windowsRegistryKey,
  type HostRegistration,
  type WindowsRegistry,
} from '../../src/main/native-host/register.ts';
import { runStandaloneHost, userDataArg } from '../../src/main/native-host/standalone.ts';
import {
  FrameDecoder,
  encodeFrame,
  ipcProof,
  startNativeIpc,
  type IpcConnection,
  type IpcFrame,
} from '../../src/main/native-ipc.ts';

const key = 'b'.repeat(64);

/** Chrome's side of the host: what it writes on stdin, and the frames it reads on stdout. */
function chromeSide() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const decoder = new FrameDecoder();
  const received: IpcFrame[] = [];
  stdout.on('data', (chunk: Buffer) => received.push(...decoder.push(chunk)));
  return {
    stdin,
    stdout,
    received,
    write: (frame: IpcFrame) => stdin.write(encodeFrame(frame)),
  };
}

async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${what} never happened`);
}

describe('the native-messaging host', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'veyquo-host-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('frames relay both ways', async () => {
    const path = join(dir, 'native.sock');
    let app: IpcConnection | null = null;
    const fromChrome: IpcFrame[] = [];
    const server = await startNativeIpc(
      path,
      (connection) => {
        app = connection;
        connection.onFrame((frame) => fromChrome.push(frame));
      },
      { key },
    );
    const chrome = chromeSide();
    // Chrome may write before the handshake is done: nothing is lost or sent early.
    chrome.write({ id: 'e-1', kind: 'hello', payload: { version: '0.1.0' } });
    const exit = runNativeHost({
      stdin: chrome.stdin,
      stdout: chrome.stdout,
      connect: () => connect(path),
      readKey: () => Promise.resolve(`${key}\n`),
    });
    const connection = await eventually(() => app ?? undefined, 'admission');
    await eventually(() => fromChrome[0], 'the first frame');
    expect(fromChrome).toEqual([{ id: 'e-1', kind: 'hello', payload: { version: '0.1.0' } }]);
    connection.send({ id: 'a-1', kind: 'cdp.attach', payload: { tab_id: 4 } });
    await eventually(() => chrome.received[0], 'a frame to Chrome');
    expect(chrome.received).toEqual([{ id: 'a-1', kind: 'cdp.attach', payload: { tab_id: 4 } }]);
    chrome.write({ id: 'a-1', kind: 'reply', payload: { ok: true, result: {} } });
    await eventually(() => fromChrome[1], 'the reply');
    expect(fromChrome[1]).toEqual({ id: 'a-1', kind: 'reply', payload: { ok: true, result: {} } });
    // Chrome closes stdin: the host ends, and the app sees the connection go.
    chrome.stdin.end();
    await expect(exit).resolves.toBe('stdin_closed' satisfies NativeHostExit);
    await server.close();
  });

  it('answers a frame too large for Chrome instead of sending it', async () => {
    const path = join(dir, 'native.sock');
    const replies: IpcFrame[] = [];
    let app: IpcConnection | null = null;
    const server = await startNativeIpc(
      path,
      (connection) => {
        app = connection;
        connection.onFrame((frame) => replies.push(frame));
      },
      { key },
    );
    const chrome = chromeSide();
    const exit = runNativeHost({
      stdin: chrome.stdin,
      stdout: chrome.stdout,
      connect: () => connect(path),
      readKey: () => Promise.resolve(key),
    });
    const connection = await eventually(() => app ?? undefined, 'admission');
    const params = { text: 'x'.repeat(1024 * 1024 + 10) };
    connection.send({
      id: 'a-9',
      kind: 'cdp.send',
      payload: { tab_id: 1, method: 'Input.insertText', params },
    });
    const reply = await eventually(() => replies[0], 'the refusal');
    expect(reply).toMatchObject({ id: 'a-9', kind: 'reply', payload: { ok: false } });
    expect(chrome.received).toEqual([]);
    chrome.stdin.end();
    await exit;
    await server.close();
  });

  it('relays nothing to an endpoint that cannot prove the key (a squatted pipe)', async () => {
    const path = join(dir, 'squat.sock');
    const seen: Buffer[] = [];
    const squatter = createServer((socket: Socket) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk: Buffer) => {
        seen.push(chunk);
        for (const frame of decoder.push(chunk)) {
          if (frame.kind === 'hello') {
            const nonce = (frame.payload as { nonce: string }).nonce;
            // It does not know the key: its best guess is a proof with another one.
            socket.write(
              encodeFrame({
                id: frame.id,
                kind: 'welcome',
                payload: { proof: ipcProof('c'.repeat(64), 'app', nonce), nonce: 'd'.repeat(64) },
              }),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => squatter.listen(path, resolve));
    const chrome = chromeSide();
    chrome.write({
      id: 'e-1',
      kind: 'permission.grant',
      payload: { tab_id: 1, url: 'https://a.example/' },
    });
    const exit = await runNativeHost({
      stdin: chrome.stdin,
      stdout: chrome.stdout,
      connect: () => connect(path),
      readKey: () => Promise.resolve(key),
    });
    expect(exit).toBe('app_unverified');
    const everything = Buffer.concat(seen).toString('utf8');
    expect(everything).toContain('"hello"');
    expect(everything).not.toContain('permission.grant');
    expect(everything).not.toContain(key);
    expect(chrome.received).toEqual([]);
    await new Promise<void>((resolve) => {
      squatter.close(() => {
        resolve();
      });
    });
  });

  it('ends at once when the app is not running', async () => {
    const chrome = chromeSide();
    const exit = await runNativeHost({
      stdin: chrome.stdin,
      stdout: chrome.stdout,
      connect: () => connect(join(dir, 'nobody.sock')),
      readKey: () => Promise.resolve(key),
    });
    expect(exit).toBe('app_unreachable');
  });

  it('ends when it cannot read the key', async () => {
    const chrome = chromeSide();
    const exit = await runNativeHost({
      stdin: chrome.stdin,
      stdout: chrome.stdout,
      connect: () => connect(join(dir, 'nobody.sock')),
      readKey: () => Promise.reject(new Error('ENOENT')),
    });
    expect(exit).toBe('no_key');
  });
});

class FakeRegistry implements WindowsRegistry {
  readonly values = new Map<string, string>();
  setDefault(registryKey: string, value: string): Promise<void> {
    this.values.set(registryKey, value);
    return Promise.resolve();
  }
  deleteKey(registryKey: string): Promise<void> {
    this.values.delete(registryKey);
    return Promise.resolve();
  }
}

describe('registering the host with Chrome', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'veyquo-register-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    {
      platform: 'darwin' as const,
      expected:
        '/Users/ana/Library/Application Support/Google/Chrome/NativeMessagingHosts/works.hence.veyquo.json',
      home: '/Users/ana',
    },
    {
      platform: 'linux' as const,
      expected: '/home/ana/.config/google-chrome/NativeMessagingHosts/works.hence.veyquo.json',
      home: '/home/ana',
    },
    {
      platform: 'win32' as const,
      expected: join('/appdata/Veyquo', 'native-host', 'works.hence.veyquo.json'),
      home: 'C:\\Users\\ana',
    },
  ])('manifest path per OS: $platform', ({ platform, home, expected }) => {
    expect(manifestPath({ platform, home, userData: '/appdata/Veyquo' })).toBe(expected);
  });

  it('a failed registration is logged by its code and type, never its path', () => {
    const error = Object.assign(
      new Error("EACCES: permission denied, open '/home/ana/.config/google-chrome/x.json'"),
      { code: 'EACCES' },
    );
    expect(registrationFailure(error)).toEqual({ code: 'EACCES', type: 'Error' });
    expect(registrationFailure('weird')).toEqual({ code: null, type: 'unknown' });
    expect(registrationFailure(Object.assign(new Error('x'), { code: '/home/ana/path' }))).toEqual({
      code: null,
      type: 'Error',
    });
  });

  it('the Windows manifest is found through the per-user registry key', () => {
    expect(windowsRegistryKey).toBe(
      'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\works.hence.veyquo',
    );
  });

  function registration(
    platform: NodeJS.Platform,
    registry = new FakeRegistry(),
  ): HostRegistration {
    return {
      platform,
      home: join(dir, 'home'),
      userData: join(dir, 'userData'),
      command: ['/opt/Veyquo/veyquo'],
      registry,
    };
  }

  it('writes a manifest that admits only the Veyquo extension and starts the app as a host', async () => {
    const reg = registration('linux');
    await registerNativeHost(reg);
    const manifest = JSON.parse(await readFile(manifestPath(reg), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(manifest).toEqual({
      name: 'works.hence.veyquo',
      description: 'Veyquo desktop app',
      path: launcherPath(reg),
      type: 'stdio',
      allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
    });
    const launcher = await readFile(launcherPath(reg), 'utf8');
    expect(launcher).toMatch(/^#!\/bin\/sh\n/u);
    expect(launcher).toContain(`exec '/opt/Veyquo/veyquo' '--native-host' "$@"`);
    expect((await stat(launcherPath(reg))).mode & 0o777).toBe(0o700);
  });

  it('quotes a launcher path with spaces and quotes', async () => {
    const reg = {
      ...registration('darwin'),
      command: ["/Applications/Ana's Apps/Veyquo.app/Contents/MacOS/Veyquo"],
    };
    await registerNativeHost(reg);
    expect(await readFile(launcherPath(reg), 'utf8')).toContain(
      `exec '/Applications/Ana'\\''s Apps/Veyquo.app/Contents/MacOS/Veyquo' '--native-host' "$@"`,
    );
  });

  it('on Windows writes a .cmd launcher and points the registry at the manifest', async () => {
    const registry = new FakeRegistry();
    const reg = {
      ...registration('win32', registry),
      command: ['C:\\Program Files\\Veyquo\\Veyquo.exe'],
    };
    await registerNativeHost(reg);
    expect(registry.values.get(windowsRegistryKey)).toBe(manifestPath(reg));
    expect(launcherPath(reg)).toMatch(/\.cmd$/u);
    expect(await readFile(launcherPath(reg), 'utf8')).toBe(
      '@echo off\r\n"C:\\Program Files\\Veyquo\\Veyquo.exe" --native-host %*\r\n',
    );
  });

  it('on Windows the launcher starts the standalone host with the app data folder, quoted', async () => {
    const reg = {
      ...registration('win32', new FakeRegistry()),
      command: [
        'C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Veyquo\\resources\\veyquo-native-host.exe',
        '--user-data',
        'C:\\Users\\Ana Lee\\AppData\\Roaming\\Veyquo 100%',
      ],
    };
    await registerNativeHost(reg);
    expect(await readFile(launcherPath(reg), 'utf8')).toBe(
      '@echo off\r\n' +
        '"C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Veyquo\\resources\\veyquo-native-host.exe" ' +
        '"--user-data" "C:\\Users\\Ana Lee\\AppData\\Roaming\\Veyquo 100%%" --native-host %*\r\n',
    );
  });

  it.each(['linux', 'darwin', 'win32'] as const)('unregister removes it: %s', async (platform) => {
    const registry = new FakeRegistry();
    const reg = registration(platform, registry);
    await registerNativeHost(reg);
    await unregisterNativeHost(reg);
    await expect(stat(manifestPath(reg))).rejects.toThrow();
    await expect(stat(launcherPath(reg))).rejects.toThrow();
    expect(registry.values.size).toBe(0);
    await unregisterNativeHost(reg); // twice is fine
  });
});

describe('the command the host launcher runs', () => {
  const base = {
    execPath: '/opt/Veyquo/veyquo',
    appPath: '/src/apps/desktop',
    resourcesPath: '/opt/Veyquo/resources',
    userData: '/home/ana/.config/Veyquo',
  };
  const windows = {
    execPath: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Veyquo\\Veyquo.exe',
    appPath: 'C:\\src\\apps\\desktop',
    resourcesPath: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Veyquo\\resources',
    userData: 'C:\\Users\\Ana\\AppData\\Roaming\\Veyquo',
  };

  it.each([
    {
      name: 'a packaged build runs its binary, never without the sandbox',
      input: { ...base, packaged: true, platform: 'linux' as const, noSandbox: true },
      command: ['/opt/Veyquo/veyquo'],
    },
    {
      name: 'a packaged AppImage runs the AppImage',
      input: {
        ...base,
        packaged: true,
        platform: 'linux' as const,
        noSandbox: false,
        appImage: '/home/ana/Veyquo.AppImage',
      },
      command: ['/home/ana/Veyquo.AppImage'],
    },
    {
      name: 'development runs Electron on the app folder',
      input: { ...base, packaged: false, platform: 'linux' as const, noSandbox: false },
      command: ['/opt/Veyquo/veyquo', '/src/apps/desktop'],
    },
    {
      name: 'Linux development started with --no-sandbox passes it on',
      input: { ...base, packaged: false, platform: 'linux' as const, noSandbox: true },
      command: ['/opt/Veyquo/veyquo', '/src/apps/desktop', '--no-sandbox'],
    },
    {
      name: 'only Linux development passes it on',
      input: { ...base, packaged: false, platform: 'darwin' as const, noSandbox: true },
      command: ['/opt/Veyquo/veyquo', '/src/apps/desktop'],
    },
    {
      name: 'a packaged macOS build runs its binary',
      input: { ...base, packaged: true, platform: 'darwin' as const, noSandbox: false },
      command: ['/opt/Veyquo/veyquo'],
    },
    {
      name: 'a packaged Windows build runs the standalone host, told where the app keeps its state',
      input: { ...windows, packaged: true, platform: 'win32' as const, noSandbox: false },
      command: [
        'C:\\Users\\Ana\\AppData\\Local\\Programs\\Veyquo\\resources\\veyquo-native-host.exe',
        '--user-data',
        'C:\\Users\\Ana\\AppData\\Roaming\\Veyquo',
      ],
    },
    {
      name: 'Windows development runs the standalone host the build made, never Electron',
      input: { ...windows, packaged: false, platform: 'win32' as const, noSandbox: true },
      command: [
        'C:\\src\\apps\\desktop\\build-host\\veyquo-native-host.exe',
        '--user-data',
        'C:\\Users\\Ana\\AppData\\Roaming\\Veyquo',
      ],
    },
  ])('$name', ({ input, command }) => {
    expect(hostCommand(input)).toEqual(command);
  });
});

describe('the standalone host reads where the app keeps its state', () => {
  const origin = 'chrome-extension://abc/';

  it.each([
    {
      name: 'from --user-data, wherever Chrome adds its own arguments',
      argv: ['--user-data', 'C:\\Users\\Ana\\AppData\\Roaming\\Veyquo', '--native-host', origin],
      userData: 'C:\\Users\\Ana\\AppData\\Roaming\\Veyquo',
    },
    {
      name: 'with spaces in the path',
      argv: ['--native-host', '--user-data', 'C:\\Users\\Ana Lee\\Veyquo', origin],
      userData: 'C:\\Users\\Ana Lee\\Veyquo',
    },
    { name: 'not at all without --user-data', argv: ['--native-host', origin], userData: null },
    { name: 'not from a missing value', argv: ['--user-data'], userData: null },
    { name: 'not from an empty value', argv: ['--user-data', '', origin], userData: null },
    {
      name: 'not from another switch',
      argv: ['--user-data', '--native-host', origin],
      userData: null,
    },
  ])('$name', ({ argv, userData }) => {
    expect(userDataArg(argv)).toBe(userData);
  });

  it('exits 1 without --user-data, writing nothing to stdout', async () => {
    const stdout = new PassThrough();
    const written: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => written.push(chunk));
    const code = await runStandaloneHost({
      argv: ['--native-host', origin],
      platform: 'linux',
      stdin: new PassThrough(),
      stdout,
    });
    expect(code).toBe(1);
    expect(Buffer.concat(written).length).toBe(0);
  });
});
