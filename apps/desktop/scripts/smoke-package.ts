// Starts a packaged build (`yarn dist:dir` or `yarn dist` first) the way CI does on every
// operating system, and fails unless each check holds:
//
// 1. `--smoke` exits 0 and reports Chrome found and the executor loaded (the machine must
//    have Google Chrome stable, at least the minimum version).
// 2. `--smoke` with VEYQUO_CHROME_PATH pointing at nothing exits 3 (Chrome unavailable).
// 3. `--native-host` with no running app (no IPC key) exits 1 and writes nothing to stdout,
//    so a GUI-subsystem binary started by Chrome as its native host ends cleanly. On Windows
//    the host is the standalone executable in the resources folder, started as its launcher
//    starts it (`--user-data`, here a folder with no key): Electron's own stdout is not clean
//    there (`src/main/native-host/standalone.ts`).
//
// When VEYQUO_BUILD_API_URL is set (as for every installer), the build must also report that
// it carries its Veyquo URLs.
//
// Linux only: the binary gets --no-sandbox, because CI runners and Ubuntu 24.04 hosts
// restrict unprivileged user namespaces and chrome-sandbox is not setuid in an unpacked
// build. The packaged app never adds it itself.
//
//   node scripts/smoke-package.ts [path to the packaged executable]

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packagedExecutable, packagedHostExecutable } from './packaged-app.ts';

const executable = process.argv[2] ?? packagedExecutable();
const hostExecutable = packagedHostExecutable();
const platformArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];

interface Run {
  code: number | null;
  stdout: string;
}

function run(
  args: string[],
  extraEnv: Record<string, string>,
  home: string,
  program: string = executable,
): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  // A throwaway home on Linux and macOS; Windows keeps its own (Chrome is found through
  // PROGRAMFILES and LOCALAPPDATA).
  if (process.platform !== 'win32') env.HOME = home;
  Object.assign(env, extraEnv);
  return new Promise((resolve, reject) => {
    const child = spawn(program, program === executable ? [...platformArgs, ...args] : args, {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    // Resolve on 'close' (all output read), or shortly after 'exit' in case a helper process
    // the binary started still holds its stdout.
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    child.on('close', settle);
    child.on('exit', (code) => {
      setTimeout(() => {
        settle(code);
      }, 2_000);
    });
  });
}

function smokeLine(stdout: string): Record<string, unknown> | null {
  const line = stdout.split('\n').find((text) => text.startsWith('{"event":"smoke"'));
  return line === undefined ? null : (JSON.parse(line) as Record<string, unknown>);
}

const failures: string[] = [];
const home = await mkdtemp(join(tmpdir(), 'vq-smoke-'));
try {
  const found = await run(['--smoke'], {}, home);
  const report = smokeLine(found.stdout);
  process.stdout.write(`--smoke: exit ${String(found.code)} ${JSON.stringify(report)}\n`);
  if (found.code !== 0 || report?.result !== 'ok' || report.packaged !== true) {
    failures.push(`--smoke exited ${String(found.code)}, expected 0 with Chrome found`);
  }
  // A build made with its Veyquo URLs (as every installer is) must report carrying them.
  if ((process.env.VEYQUO_BUILD_API_URL ?? '') !== '' && report?.build_urls !== true) {
    failures.push('the build was given VEYQUO_BUILD_API_URL but does not carry it');
  }

  const missing = await run(['--smoke'], { VEYQUO_CHROME_PATH: join(home, 'no-chrome') }, home);
  const missingReport = smokeLine(missing.stdout);
  process.stdout.write(
    `--smoke without Chrome: exit ${String(missing.code)} ${JSON.stringify(missingReport)}\n`,
  );
  if (missing.code !== 3 || missingReport?.result !== 'chrome_unavailable') {
    failures.push(`--smoke without Chrome exited ${String(missing.code)}, expected 3`);
  }

  const origin = 'chrome-extension://smoke/';
  const host =
    hostExecutable === null
      ? await run(['--native-host', origin], {}, home)
      : await run(['--user-data', home, '--native-host', origin], {}, home, hostExecutable);
  process.stdout.write(`--native-host with no app: exit ${String(host.code)}\n`);
  if (host.code !== 1 || host.stdout.length > 0) {
    failures.push(
      `--native-host with no app exited ${String(host.code)} with ${String(host.stdout.length)} ` +
        'bytes on stdout, expected 1 and none',
    );
  }
} finally {
  await rm(home, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('packaged app smoke: ok\n');
