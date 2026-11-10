// Bundles the app with esbuild into build/: the main process (CommonJS, Electron's Node),
// the sandboxed preload (one CommonJS file that requires only `electron`), and the status
// window's script, page, styles and tray icons. Workspace packages ship TypeScript sources,
// so everything except Electron itself is bundled; the packaged app needs no node_modules.
//
// It also bundles the standalone native-messaging host (`src/main/native-host/standalone.ts`)
// into build-host/host.cjs, outside the app's asar; the integration tests run it with Node.
// On Windows it then builds build-host/veyquo-native-host.exe from it
// (scripts/host-executable.ts): the host a development run registers, and the one
// electron-builder.yml ships in a packaged build.
//
// VEYQUO_SIGNED_BUILD=1 marks a build that will be signed, which turns auto-update on.
// VEYQUO_BUILD_API_URL and VEYQUO_BUILD_WEB_URL (both https, or neither) are the Veyquo URLs
// a packaged build talks to; without them only a development run has a default (localhost).

import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { build } from 'esbuild';

import { parseBuildUrls } from '../src/main/build-urls.ts';
import { buildHostExecutable } from './host-executable.ts';

const root = join(import.meta.dirname, '..');
const out = join(root, 'build');
const hostOut = join(root, 'build-host');
const signed = process.env.VEYQUO_SIGNED_BUILD === '1';
const urls = parseBuildUrls(process.env);

await rm(out, { recursive: true, force: true });
await rm(hostOut, { recursive: true, force: true });
await mkdir(join(out, 'renderer'), { recursive: true });

const shared = {
  bundle: true,
  logLevel: 'warning',
  legalComments: 'none',
  sourcemap: false,
  absWorkingDir: root,
} as const;

await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/main/index.ts'],
    outfile: join(out, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    // ws loads these optional native speed-ups only if present.
    external: ['electron', 'bufferutil', 'utf-8-validate'],
    define: {
      __VEYQUO_SIGNED_BUILD__: JSON.stringify(signed),
      __VEYQUO_BUILD_URLS__: JSON.stringify(urls),
    },
  }),
  build({
    ...shared,
    entryPoints: ['src/main/preload.ts'],
    outfile: join(out, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: ['src/main/native-host/standalone-main.ts'],
    outfile: join(hostOut, 'host.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
  }),
  build({
    ...shared,
    entryPoints: ['src/renderer/index.ts'],
    outfile: join(out, 'renderer', 'index.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
  }),
]);

await cp(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html'));
await build({
  bundle: true,
  entryPoints: [join(root, 'src/renderer/styles.css')],
  outfile: join(out, 'renderer/styles.css'),
  logLevel: 'warning',
});
for (const logo of ['veyquo-logo.png', 'veyquo-logo-dark.png']) {
  await cp(join(root, 'resources', logo), join(out, 'renderer', logo));
}
for (const icon of ['icon.png', 'tray.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
  await cp(join(root, 'resources', icon), join(out, icon));
}

if (process.platform === 'win32') await buildHostExecutable(root);
