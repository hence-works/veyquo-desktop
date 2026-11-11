// Bundles the extension with esbuild into dist/, the folder Chrome loads ("Load unpacked")
// and the store package is zipped from: the service worker and the popup script as IIFEs,
// plus manifest.json, the popup page and styles, and the icons. Workspace packages ship
// TypeScript sources, so everything is bundled; the extension loads no remote code.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

export const extensionRoot = join(import.meta.dirname, '..');
const out = join(extensionRoot, 'dist');

export async function buildExtension(devBuild?: {
  buildId: string;
  webSocketToken: string;
}): Promise<void> {
  // Keep the loaded unpacked directory present during dev rebuilds. Removing it causes
  // Chromium to disable the extension before the reload signal can arrive.
  if (devBuild === undefined) await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'icons'), { recursive: true });

  await build({
    bundle: true,
    logLevel: 'warning',
    legalComments: 'none',
    sourcemap: devBuild !== undefined,
    absWorkingDir: extensionRoot,
    entryPoints: { background: 'src/background.ts', popup: 'src/popup.ts' },
    outdir: out,
    platform: 'browser',
    format: 'iife',
    target: 'chrome136',
  });

  const manifest = JSON.parse(
    await readFile(join(extensionRoot, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  if (devBuild !== undefined) {
    await build({
      bundle: true,
      logLevel: 'warning',
      absWorkingDir: extensionRoot,
      entryPoints: { 'dev-reload': 'src/dev-reload.ts' },
      outdir: out,
      platform: 'browser',
      format: 'iife',
      target: 'chrome136',
      define: {
        __VEYQUO_BUILD_ID__: JSON.stringify(devBuild.buildId),
        __VEYQUO_WS_TOKEN__: JSON.stringify(devBuild.webSocketToken),
      },
    });
    await writeFile(join(out, 'background.js'), "\nimportScripts('dev-reload.js');\n", {
      flag: 'a',
    });
    const csp = manifest.content_security_policy as { extension_pages: string };
    csp.extension_pages += '; connect-src ws://127.0.0.1:5187';
  }
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(extensionRoot, 'src', 'popup.html'), join(out, 'popup.html'));
  await build({
    bundle: true,
    entryPoints: [join(extensionRoot, 'src/popup.css')],
    outfile: join(out, 'popup.css'),
    logLevel: 'warning',
  });
  for (const size of [16, 32, 48, 128]) {
    await cp(
      join(extensionRoot, 'icons', `${String(size)}.png`),
      join(out, 'icons', `${String(size)}.png`),
    );
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildExtension();
}
