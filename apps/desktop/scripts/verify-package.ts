// Checks a packaged build (`yarn dist:dir` first): the Electron fuses that harden the binary
// are set as electron-builder.yml asks, and ELECTRON_RUN_AS_NODE does not turn the app into
// a Node interpreter. Exits non-zero, naming each failure.
//
//   node scripts/verify-package.ts [path to the packaged executable]

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fuses from '@electron/fuses';

import { packagedExecutable } from './packaged-app.ts';

// A CommonJS package: its exports come through the default export. `FuseState` is not
// exported at runtime; its values are the ASCII digits the wire stores.
const { FuseV1Options, getCurrentFuseWire } = fuses;
const FuseState = { DISABLE: 48, ENABLE: 49 } as const;

const executable = process.argv[2] ?? packagedExecutable();

/** The fuses electron-builder.yml sets, and the state each must have. */
const expectedFuses: [fuses.FuseV1Options, string, number][] = [
  [FuseV1Options.RunAsNode, 'runAsNode', FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, 'enableCookieEncryption', FuseState.ENABLE],
  [
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    'enableNodeOptionsEnvironmentVariable',
    FuseState.DISABLE,
  ],
  [FuseV1Options.EnableNodeCliInspectArguments, 'enableNodeCliInspectArguments', FuseState.DISABLE],
  [
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    'enableEmbeddedAsarIntegrityValidation',
    FuseState.ENABLE,
  ],
  [FuseV1Options.OnlyLoadAppFromAsar, 'onlyLoadAppFromAsar', FuseState.ENABLE],
];

const failures: string[] = [];
const wire = await getCurrentFuseWire(executable);
for (const [fuse, name, state] of expectedFuses) {
  const actual = Number(wire[fuse]); // the wire's byte, as the number FuseState names
  if (actual !== state) {
    failures.push(`fuse ${name} is ${String(actual)}, expected ${String(state)}`);
  }
}

// With the RunAsNode fuse off, the variable is ignored: the app starts instead of evaluating
// the script. `--smoke` after the script makes that start the smoke check, which exits at once
// and touches no app state. A full start would not: on Windows HOME does not move userData
// (%APPDATA%) and there is a display, so it wrote the IPC key and opened the IPC endpoint that
// smoke-package's "--native-host with no app" check then found. A Node interpreter, if the fuse
// were on, still runs the script and passes `--smoke` to it as an argument.
const home = await mkdtemp(join(tmpdir(), 'vq-verify-'));
const marker = 'NODE-RAN-42';
const output = await new Promise<string>((resolve) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'DISPLAY' && key !== 'WAYLAND_DISPLAY') env[key] = value;
  }
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    VEYQUO_API_URL: 'http://127.0.0.1:9',
  });
  const child = spawn(executable, ['-e', "process.stdout.write('NODE-RAN-' + 6 * 7)", '--smoke'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  // On 'close', or shortly after 'exit' if a helper process (GPU, renderer) the started app
  // left behind still holds its stdout (Windows).
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(text);
  };
  child.on('close', settle);
  child.on('exit', () => {
    setTimeout(settle, 2_000);
  });
});
await rm(home, { recursive: true, force: true });
if (output.includes(marker)) failures.push('ELECTRON_RUN_AS_NODE=1 ran Node');

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('fuses set; ELECTRON_RUN_AS_NODE ignored\n');
