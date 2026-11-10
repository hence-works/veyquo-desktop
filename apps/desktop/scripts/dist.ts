// Packages the app with electron-builder (`yarn dist`, or `yarn dist:dir` for an unpacked
// app). Rules from the plan (§9) that electron-builder.yml cannot say by itself:
//
// - Signing happens only when a signing identity is in the environment (CSC_LINK or
//   CSC_NAME; for Windows also WIN_CSC_LINK). Otherwise the build is explicitly unsigned
//   (macOS ad-hoc), and auto-discovery of identities in the keychain is off. The macOS app
//   is ad-hoc signed again after the fuses are flipped
//   (`resetAdHocDarwinSignature`): flipping them breaks Electron's own ad-hoc signature, and
//   Apple silicon refuses to run a binary whose signature does not match.
// - The update feed is VEYQUO_UPDATE_URL. Without it there is no publish configuration,
//   and the build never publishes anything itself.
// - Installers (`yarn dist`) must carry the Veyquo URLs: VEYQUO_BUILD_API_URL and
//   VEYQUO_BUILD_WEB_URL (https), baked in by scripts/build.ts. An unpacked `--dir` build may
//   go without them for local testing; it then needs VEYQUO_API_URL and VEYQUO_WEB_URL at
//   run time, because a packaged build never falls back to localhost.
// - A Windows build carries the standalone native-messaging host that scripts/build.ts made
//   (scripts/host-executable.ts); electron-builder.yml copies it into the resources folder.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Configuration } from 'electron-builder';

import { parseBuildUrls } from '../src/main/build-urls.ts';

const root = join(import.meta.dirname, '..');
const dirOnly = process.argv.includes('--dir');
const env = process.env;
const signing = [env.CSC_LINK, env.CSC_NAME, env.WIN_CSC_LINK].some(
  (value) => value !== undefined && value.length > 0,
);
const updateUrl = env.VEYQUO_UPDATE_URL;

if (!signing) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

if (!dirOnly && parseBuildUrls(env) === null) {
  process.stderr.write(
    'dist: an installer must carry its Veyquo URLs; set VEYQUO_BUILD_API_URL and ' +
      'VEYQUO_BUILD_WEB_URL (https), or build an unpacked app with `dist:dir`\n',
  );
  process.exit(2);
}

// The locked Electron (hoisted to the workspace root, where electron-builder does not look).
const electronPackage = JSON.parse(
  await readFile(fileURLToPath(import.meta.resolve('electron/package.json')), 'utf8'),
) as { version: string };

const overrides: Configuration = {
  extends: join(root, 'electron-builder.yml'),
  electronVersion: electronPackage.version,
  ...(signing
    ? {}
    : // Deep-merged over electron-builder.yml's electronFuses.
      { mac: { identity: null }, electronFuses: { resetAdHocDarwinSignature: true } }),
  ...(updateUrl !== undefined && updateUrl.length > 0
    ? { publish: { provider: 'generic', url: updateUrl } }
    : { publish: null }),
};

await build({
  projectDir: root,
  config: overrides,
  publish: 'never',
  ...(dirOnly ? { dir: true } : {}),
});
