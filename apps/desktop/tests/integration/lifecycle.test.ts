// The desktop app end to end: the built app under Electron (Xvfb on Linux), a local fake
// gateway, and real Google Chrome over --remote-debugging-pipe against a local fixture page.
// The tests run in order and share one computer's state: pair, reconnect, work, restart,
// then remove.

import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeviceReply } from '@veyquo/device-protocol';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extensionIds } from '@veyquo/local-executor/extension-protocol';

import { FrameDecoder, encodeFrame, type IpcFrame } from '../../src/main/native-ipc.ts';
import { appDir, electronPath, launchApp, openedUrls, type LaunchedApp } from '../support/app.ts';
import { FakeGateway } from '../support/fake-gateway.ts';

/** The standalone host's bundle (scripts/build.ts), the script of the Windows executable. */
const standaloneHost = join(appDir, 'build-host', 'host.cjs');

const fixtureHtml = `<!doctype html><html><head><title>Apply</title></head><body>
<form method="post" action="/submit"><label for="name">Full name</label>
<input id="name" name="name" autocomplete="name">
<button type="submit">Submit application</button></form></body></html>`;

let root: string;
let userData: string;
let home: string;
let gateway: FakeGateway;
let fixture: Server;
let fixtureUrl: string;
let running: LaunchedApp | null = null;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function launch(): Promise<LaunchedApp> {
  running = await launchApp({ userData, home, apiUrl: gateway.url });
  return running;
}

async function quit(): Promise<void> {
  if (running === null) return;
  const { app } = running;
  running = null;
  await app.close();
}

/** The visible text of a test id, polled until it equals `expected`. */
async function shows(page: Page | undefined, testId: string, expected: string): Promise<void> {
  await expect
    .poll(
      () =>
        page
          ?.getByTestId(testId)
          .textContent({ timeout: 1000 })
          .catch(() => null),
      {
        timeout: 30_000,
        interval: 250,
      },
    )
    .toBe(expected);
}

function opened(reply: DeviceReply): string {
  if (!reply.ok || reply.result?.kind !== 'opened') throw new Error('the session did not open');
  return reply.result.session_id;
}

beforeAll(async () => {
  // Short: the IPC socket lives under userData, and Unix socket paths are limited.
  root = await mkdtemp(join(tmpdir(), 'vq-'));
  userData = join(root, 'ud');
  home = join(root, 'home');
  await mkdir(home, { recursive: true });
  gateway = await new FakeGateway().start();
  fixture = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${String((fixture.address() as AddressInfo).port)}/apply`;
});

afterAll(async () => {
  await quit().catch(() => undefined);
  await gateway.stop();
  await new Promise<void>((resolve) => {
    fixture.close(() => {
      resolve();
    });
  });
  // VEYQUO_KEEP_TEST_DATA=1 keeps the app's folder (and its log) for a failed run.
  if (process.env.VEYQUO_KEEP_TEST_DATA === '1') process.stdout.write(`kept ${root}\n`);
  else await rm(root, { recursive: true, force: true });
});

describe('the desktop app', () => {
  it('pairs against the fake gateway and connects', async () => {
    const { app, page } = await launch();
    await shows(page, 'status', 'Not paired');
    await page.getByTestId('pair').click();
    await shows(page, 'pairing-code', 'ABCD2345');
    expect(await openedUrls(app)).toEqual(['http://127.0.0.1:3400/app/devices/pair?code=ABCD2345']);

    gateway.approved = true;
    const hello = await gateway.frame((f) => f.name === 'hello');
    expect(hello).toMatchObject({
      device_id: gateway.deviceId,
      protocol_version: 1,
      os: 'linux',
      modes: ['veyquo_profile'],
      journal: [],
    });
    expect(hello.journal_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(String(hello.chrome_version)).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
    await shows(page, 'status', 'Online');

    // The key is stored encrypted; the journal and autostart entry exist.
    expect(await exists(join(userData, 'device-key.bin'))).toBe(true);
    const header = (await readFile(join(userData, 'journal.jsonl'), 'utf8')).split('\n')[0] ?? '';
    expect(JSON.parse(header)).toMatchObject({ journal_id: hello.journal_id });
    expect(await exists(join(home, '.config', 'autostart', 'veyquo.desktop'))).toBe(true);
    // The IPC endpoint for the native-messaging host is up.
    expect((await stat(join(userData, 'native.sock'))).isSocket()).toBe(true);
  });

  it('gives the status page no Node and only the three bridge calls', async () => {
    const page = running?.page;
    if (page === undefined) throw new Error('the app is not running');
    const surface = await page.evaluate(() => {
      const scope = globalThis as unknown as Record<string, unknown>;
      return {
        require: typeof scope.require,
        process: typeof scope.process,
        module: typeof scope.module,
        bridge: Object.keys(scope.veyquo ?? {}).sort(),
        frozen: Object.isFrozen(scope.veyquo),
      };
    });
    expect(surface).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      bridge: ['command', 'getState', 'onState'],
      frozen: true,
    });
  });

  it('reconnects after the gateway drops', async () => {
    const before = gateway.hellos().length;
    gateway.drop();
    await gateway.frame(() => gateway.hellos().length > before, 15_000);
    expect(gateway.connections).toBeGreaterThanOrEqual(2);
    await shows(running?.page, 'status', 'Online');
    // A heartbeat follows on the new connection.
    await gateway.frame((f) => f.name === 'heartbeat', 20_000);
  });

  it('runs an inspect request in launched Chrome', async () => {
    const applicationId = crypto.randomUUID();
    const sessionId = opened(
      await gateway.request({
        name: 'session_open',
        application_id: applicationId,
        chrome_mode: 'veyquo_profile',
        visibility: 'background',
        allowed_hosts: ['127.0.0.1'],
        proxy: null,
      }),
    );
    const pid = Number((await readFile(join(userData, 'chrome.pid'), 'utf8')).trim());
    // Chrome rewrites its process title into one string, so the words are matched in it.
    const command = (await readFile(`/proc/${String(pid)}/cmdline`, 'utf8')).replaceAll('\0', ' ');
    expect(command).toContain('--remote-debugging-pipe');
    expect(command).toContain(`--user-data-dir=${join(userData, 'chrome-profile')}`);
    expect(command).not.toContain('--remote-debugging-port');

    const navigated = await gateway.request(
      { name: 'navigate', url: fixtureUrl, owner: false },
      sessionId,
    );
    expect(navigated).toMatchObject({ ok: true, result: { kind: 'signals' } });
    const inspected = await gateway.request({ name: 'inspect' }, sessionId);
    expect(inspected.ok).toBe(true);
    expect(inspected.result?.kind).toBe('inspect');
    if (inspected.result?.kind === 'inspect') {
      expect(inspected.result.document_json).toContain('Full name');
      expect(inspected.result.capture_id).toMatch(/\S/u);
    }
    // The background window still paints (no throttled, hidden tab).
    const shot = await gateway.request({ name: 'screenshot' }, sessionId);
    expect(shot.ok).toBe(true);

    // The window shows the work and lets the person take over.
    const page = running?.page;
    await shows(page, 'status', 'Working');
    await page?.getByTestId('take-over').click();
    const taken = await gateway.frame((f) => f.name === 'takeover' && f.state === 'taken');
    expect(taken).toMatchObject({ session_id: sessionId, application_id: applicationId });
    await page?.getByTestId('hand-back').click();
    await gateway.frame((f) => f.name === 'takeover' && f.state === 'handed_back');

    const closed = await gateway.request({ name: 'session_close' }, sessionId);
    expect(closed.ok).toBe(true);
    await shows(page, 'status', 'Online');
  });

  it('restart sweeps temp files and reports unacknowledged journal entries', async () => {
    const firstHello = gateway.hellos()[0];
    if (firstHello === undefined) throw new Error('the app never said hello');
    await quit();
    const leftover = join(userData, 'tmp', crypto.randomUUID());
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'resume.pdf'), '%PDF-1.4');
    const entry = {
      grant_id: crypto.randomUUID(),
      application_id: crypto.randomUUID(),
      state: 'received',
      signals_after: null,
    };
    // As if the app crashed after journalling a grant and before the cloud acknowledged it.
    await appendFile(
      join(userData, 'journal.jsonl'),
      `${JSON.stringify({ record: entry, at: Date.now() })}\n`,
    );

    const before = gateway.hellos().length;
    await launch();
    await gateway.frame(() => gateway.hellos().length > before, 20_000);
    const hello = gateway.hellos().at(-1);
    if (hello === undefined) throw new Error('the app said no hello after restarting');
    expect(hello.journal_id).toBe(firstHello.journal_id);
    expect(hello.journal).toEqual([entry]);
    expect(await readdir(join(userData, 'tmp'))).toEqual([]);
  });

  it('Chrome starts the app as the extension’s native host, which reaches the running app', async () => {
    const page = running?.page;
    const manifestFile = join(
      home,
      '.config',
      'google-chrome',
      'NativeMessagingHosts',
      'works.hence.veyquo.json',
    );
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      path: string;
      allowed_origins: string[];
    };
    const origin = `chrome-extension://${extensionIds[0]}/`;
    expect(manifest.allowed_origins).toEqual([origin]);
    const launcher = await readFile(manifest.path, 'utf8');
    expect(launcher).toContain(`'--native-host' "$@"`);
    await shows(page, 'mode-everyday', 'Needs the Veyquo extension');

    // What the launcher runs, as Chrome runs it (plus --no-sandbox, which this Linux host
    // needs for any Chromium): a second copy of the app, while the first holds its lock.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
    }
    env.VEYQUO_DESKTOP_USER_DATA = userData;
    const host = spawn(electronPath, ['--no-sandbox', appDir, '--native-host', origin], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = new Promise<number | null>((resolve) => {
      host.once('exit', (code) => {
        resolve(code);
      });
    });
    const decoder = new FrameDecoder();
    const toChrome: IpcFrame[] = [];
    const stdout: Buffer[] = [];
    host.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      toChrome.push(...decoder.push(chunk));
    });
    const fromChrome = (frame: IpcFrame): void => {
      host.stdin.write(encodeFrame(frame));
    };
    const nextToChrome = async (kind: string): Promise<IpcFrame> => {
      await expect
        .poll(() => toChrome.some((f) => f.kind === kind), { timeout: 20_000 })
        .toBe(true);
      const frame = toChrome.find((f) => f.kind === kind);
      if (frame === undefined) throw new Error(`no ${kind} frame`);
      return frame;
    };

    fromChrome({ id: 'e-1', kind: 'hello', payload: { version: '0.1.0' } });
    expect((await nextToChrome('state')).payload).toMatchObject({ activity: 'idle' });
    await shows(page, 'mode-everyday', 'Available');

    // A gateway request for the everyday profile goes through the host to the extension.
    const reply = gateway.request({
      name: 'session_open',
      application_id: null,
      chrome_mode: 'everyday_profile',
      visibility: 'visible',
      allowed_hosts: ['127.0.0.1'],
      proxy: null,
    });
    const open = await nextToChrome('tabs.open');
    expect(open.payload).toEqual({ visibility: 'visible' });
    fromChrome({
      id: open.id,
      kind: 'reply',
      payload: { ok: false, error: { code: 'unavailable', message: 'test' } },
    });
    expect(await reply).toMatchObject({ ok: false, error: { type: 'chrome_unavailable' } });

    // Chrome closes the port: the host exits cleanly and the app notices.
    host.stdin.end();
    expect(await exited).toBe(0);
    await shows(page, 'mode-everyday', 'Needs the Veyquo extension');
    // stdout carried native-messaging frames and nothing else.
    const bytes = Buffer.concat(stdout);
    let offset = 0;
    while (offset < bytes.length) offset += 4 + bytes.readUInt32LE(offset);
    expect(offset).toBe(bytes.length);
  });

  it('the standalone host (Windows) reaches the running app the same way', async () => {
    const page = running?.page;
    const origin = `chrome-extension://${extensionIds[0]}/`;
    // What the Windows launcher runs, here with Node on the bundle the executable is made of.
    const host = spawn(
      process.execPath,
      [standaloneHost, '--user-data', userData, '--native-host', origin],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const exited = new Promise<number | null>((resolve) => {
      host.once('exit', (code) => {
        resolve(code);
      });
    });
    const decoder = new FrameDecoder();
    const toChrome: IpcFrame[] = [];
    const stdout: Buffer[] = [];
    host.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      toChrome.push(...decoder.push(chunk));
    });

    host.stdin.write(encodeFrame({ id: 'e-1', kind: 'hello', payload: { version: '0.1.0' } }));
    await expect
      .poll(() => toChrome.find((f) => f.kind === 'state')?.payload, { timeout: 20_000 })
      .toMatchObject({ activity: 'idle' });
    await shows(page, 'mode-everyday', 'Available');

    host.stdin.end();
    expect(await exited).toBe(0);
    await shows(page, 'mode-everyday', 'Needs the Veyquo extension');
    // The first bytes are a frame's length: nothing came before it.
    const bytes = Buffer.concat(stdout);
    let offset = 0;
    while (offset < bytes.length) offset += 4 + bytes.readUInt32LE(offset);
    expect(offset).toBe(bytes.length);
  });

  it('remove from this computer deletes profile, journal, temp and autostart', async () => {
    const launched = running;
    if (launched === null) throw new Error('the app is not running');
    expect(await exists(join(userData, 'chrome-profile'))).toBe(true);
    const exited = new Promise<void>((resolve) => {
      launched.app.process().once('exit', () => {
        resolve();
      });
    });
    await launched.page.getByTestId('remove').click();
    await exited;
    running = null;
    const removed = [
      'chrome-profile',
      'journal.jsonl',
      'tmp',
      'device-key.bin',
      'device.json',
      'chrome.pid',
      'config.json',
      'logs',
      'native.sock',
    ];
    for (const name of removed) {
      expect(await exists(join(userData, name)), name).toBe(false);
    }
    expect(await exists(join(home, '.config', 'autostart', 'veyquo.desktop'))).toBe(false);
    // Chrome can no longer start the native host.
    expect(
      await exists(
        join(home, '.config', 'google-chrome', 'NativeMessagingHosts', 'works.hence.veyquo.json'),
      ),
    ).toBe(false);
    expect(await exists(join(userData, 'native-host'))).toBe(false);
    // The computer also left the account, with its own device token.
    expect(gateway.selfRevoked).toBe(true);
  });
});
