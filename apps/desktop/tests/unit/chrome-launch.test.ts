import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ChromeLauncher,
  ChromeUnavailableError,
  type ChromeLauncherDeps,
} from '../../src/main/chrome/launch.ts';
import { locateChrome, minChromeMajor, type LocateDeps } from '../../src/main/chrome/locate.ts';

function locateDeps(overrides: Partial<LocateDeps> = {}): LocateDeps {
  return {
    platform: 'linux',
    env: {},
    home: '/home/ana',
    exists: () => Promise.resolve(true),
    run: () => Promise.resolve('Google Chrome 152.0.7977.75 \n'),
    listDir: () => Promise.resolve([]),
    ...overrides,
  };
}

describe('locateChrome', () => {
  it('missing Chrome → chrome_unavailable', async () => {
    const found = await locateChrome(locateDeps({ exists: () => Promise.resolve(false) }));
    expect(found).toEqual({ ok: false, error: 'chrome_unavailable', reason: 'missing' });
  });

  it('Chrome 135 → chrome_unavailable', async () => {
    expect(minChromeMajor).toBe(136);
    const found = await locateChrome(
      locateDeps({ run: () => Promise.resolve('Google Chrome 135.0.7049.114\n') }),
    );
    expect(found).toEqual({
      ok: false,
      error: 'chrome_unavailable',
      reason: 'too_old',
      path: '/usr/bin/google-chrome-stable',
      version: '135.0.7049.114',
    });
  });

  it('Chrome 136 is enough', async () => {
    const found = await locateChrome(
      locateDeps({ run: () => Promise.resolve('Google Chrome 136.0.7103.48') }),
    );
    expect(found).toMatchObject({ ok: true, major: 136, version: '136.0.7103.48' });
  });

  it('an unreadable version is not taken as supported', async () => {
    const found = await locateChrome(locateDeps({ run: () => Promise.resolve('Chromium ?') }));
    expect(found).toMatchObject({ ok: false, reason: 'unknown_version' });
  });

  it.each([
    {
      platform: 'darwin' as const,
      present: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    {
      platform: 'darwin' as const,
      present: '/Users/ana/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    { platform: 'linux' as const, present: '/opt/google/chrome/chrome' },
    {
      platform: 'win32' as const,
      present: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    },
    {
      platform: 'win32' as const,
      present: 'C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    },
  ])('finds Chrome stable on $platform at $present', async ({ platform, present }) => {
    const found = await locateChrome(
      locateDeps({
        platform,
        home: platform === 'darwin' ? '/Users/ana' : '/home/ana',
        env: {
          PROGRAMFILES: 'C:\\Program Files',
          'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
          LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local',
        },
        exists: (path) => Promise.resolve(path === present),
        run: (file) =>
          Promise.resolve(
            file === 'reg'
              ? '\r\nHKEY_CURRENT_USER\\Software\\Google\\Chrome\\BLBeacon\r\n    version    REG_SZ    152.0.7977.75\r\n'
              : 'Google Chrome 152.0.7977.75',
          ),
      }),
    );
    expect(found).toEqual({ ok: true, path: present, version: '152.0.7977.75', major: 152 });
  });

  it("reads Windows' version from the install folder when the registry has none", async () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const found = await locateChrome(
      locateDeps({
        platform: 'win32',
        env: { PROGRAMFILES: 'C:\\Program Files' },
        exists: (path) => Promise.resolve(path === chrome),
        run: () => Promise.reject(new Error('ERROR: The system was unable to find the key')),
        listDir: () =>
          Promise.resolve(['SetupMetrics', '151.0.1.2', '152.0.7977.75', 'chrome.exe']),
      }),
    );
    expect(found).toEqual({ ok: true, path: chrome, version: '152.0.7977.75', major: 152 });
  });
});

describe('ChromeLauncher', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'veyquo-launch-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function launcherDeps(overrides: Partial<ChromeLauncherDeps> = {}) {
    const order: string[] = [];
    const deps: ChromeLauncherDeps = {
      locate: () =>
        Promise.resolve({
          ok: true,
          path: '/usr/bin/google-chrome',
          version: '152.0.1.2',
          major: 152,
        }),
      userDataDir: join(dir, 'chrome-profile'),
      pidFile: join(dir, 'chrome.pid'),
      processes: {
        isAlive: () => false,
        commandLine: () => Promise.resolve(null),
        kill: (pid, signal) => {
          order.push(`kill ${String(pid)} ${signal}`);
        },
      },
      launch: (options) => {
        order.push(`launch ${options.chromePath}`);
        return Promise.resolve({ pid: 5151, transport: fakeTransport() });
      },
      sleep: () => Promise.resolve(),
      ...overrides,
    };
    return { deps, order };
  }

  it('passes a managed-session proxy switch to Chrome without credentials', async () => {
    let args: readonly string[] | undefined;
    const { deps } = launcherDeps({
      launch: (options) => {
        args = options.args;
        return Promise.resolve({ pid: 5151, transport: fakeTransport() });
      },
    });
    await new ChromeLauncher(deps).start(['--proxy-server=http://proxy.example:8080']);
    expect(args).toContain('--proxy-server=http://proxy.example:8080');
  });

  it('missing Chrome → chrome_unavailable', async () => {
    const { deps, order } = launcherDeps({
      locate: () => Promise.resolve({ ok: false, error: 'chrome_unavailable', reason: 'missing' }),
    });
    const launcher = new ChromeLauncher(deps);
    const failure = launcher.start();
    await expect(failure).rejects.toThrow(ChromeUnavailableError);
    await expect(failure).rejects.toMatchObject({ reason: 'missing' });
    expect(order).toEqual([]);
  });

  it('stale PID is terminated before relaunch', async () => {
    await writeFile(join(dir, 'chrome.pid'), '4242\n');
    let alive = true;
    const { deps, order } = launcherDeps({
      processes: {
        isAlive: (pid) => pid === 4242 && alive,
        commandLine: () =>
          Promise.resolve(
            `/opt/google/chrome/chrome --remote-debugging-pipe --user-data-dir=${join(dir, 'chrome-profile')} --no-first-run`,
          ),
        kill: (pid, signal) => {
          order.push(`kill ${String(pid)} ${signal}`);
          alive = false;
        },
      },
    });
    await new ChromeLauncher(deps).start();
    expect(order).toEqual(['kill 4242 SIGTERM', 'launch /usr/bin/google-chrome']);
    expect((await readFile(join(dir, 'chrome.pid'), 'utf8')).trim()).toBe('5151');
  });

  it('a stale PID that Chrome will not give up is killed', async () => {
    await writeFile(join(dir, 'chrome.pid'), '4242');
    const { deps, order } = launcherDeps({
      processes: {
        isAlive: () => !order.includes('kill 4242 SIGKILL'),
        commandLine: () => Promise.resolve(`chrome --user-data-dir=${join(dir, 'chrome-profile')}`),
        kill: (pid, signal) => {
          order.push(`kill ${String(pid)} ${signal}`);
        },
      },
    });
    await new ChromeLauncher(deps).start();
    expect(order).toEqual([
      'kill 4242 SIGTERM',
      'kill 4242 SIGKILL',
      'launch /usr/bin/google-chrome',
    ]);
  });

  it.each([
    {
      case: 'another profile whose path starts the same',
      suffix: '-backup --no-first-run',
      kill: false,
    },
    { case: 'a profile path continuing the name', suffix: '2', kill: false },
    { case: 'our profile at the end of the line', suffix: '', kill: true },
    { case: 'our profile followed by a space', suffix: ' --no-first-run', kill: true },
    { case: 'our profile in a quoted Windows argument', suffix: '" --no-first-run', kill: true },
  ])('matches the profile path exactly: $case', async ({ suffix, kill }) => {
    await writeFile(join(dir, 'chrome.pid'), '4242');
    const kills: string[] = [];
    let alive = true;
    const quote = suffix.startsWith('"') ? '"' : '';
    const { deps } = launcherDeps({
      processes: {
        isAlive: () => alive,
        commandLine: () =>
          Promise.resolve(`chrome ${quote}--user-data-dir=${join(dir, 'chrome-profile')}${suffix}`),
        kill: (pid, signal) => {
          kills.push(`${String(pid)} ${signal}`);
          alive = false;
        },
      },
    });
    await new ChromeLauncher(deps).start();
    expect(kills).toEqual(kill ? ['4242 SIGTERM'] : []);
  });

  it('never kills a reused PID that is not our Chrome', async () => {
    await writeFile(join(dir, 'chrome.pid'), '4242');
    const { deps, order } = launcherDeps({
      processes: {
        isAlive: () => true,
        commandLine: () => Promise.resolve('/usr/bin/vim notes.txt'),
        kill: (pid, signal) => {
          order.push(`kill ${String(pid)} ${signal}`);
        },
      },
    });
    await new ChromeLauncher(deps).start();
    expect(order).toEqual(['launch /usr/bin/google-chrome']);
  });

  it('launches with the pipe, the Veyquo profile and no first-run prompts', async () => {
    const launch = vi.fn<ChromeLauncherDeps['launch']>(() =>
      Promise.resolve({ pid: 77, transport: fakeTransport() }),
    );
    const { deps } = launcherDeps({ launch });
    const started = await new ChromeLauncher(deps).start();
    expect(started.version).toBe('152.0.1.2');
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        chromePath: '/usr/bin/google-chrome',
        userDataDir: join(dir, 'chrome-profile'),
        headless: false,
      }),
    );
  });
});

function fakeTransport() {
  return {
    send: () => Promise.resolve({}),
    on: () => () => undefined,
    close: () => Promise.resolve(),
  };
}
