// Builds the standalone native-messaging host for Windows (`src/main/native-host/standalone.ts`)
// as a Node single executable application: build-host/host.cjs (scripts/build.ts) injected
// into a copy of the Node running this script, as build-host/veyquo-native-host.exe.
// electron-builder.yml ships it in the app's resources folder and signs it with the app.
//
// The copy is of this Node, so the executable is built on the system it is packaged for
// (CI: the Windows runner's locked Node). Node's own signature on the copy no longer matches
// once the script is injected; a signed build signs the result again.

import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { hostExecutableName } from '../src/main/native-host/register.ts';

// postject ships no types.
const { inject } = createRequire(import.meta.url)('postject') as {
  inject: (
    file: string,
    resource: string,
    data: Buffer,
    options: { sentinelFuse: string },
  ) => Promise<void>;
};

/** The fuse Node looks for to find an injected application. */
const seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export async function buildHostExecutable(root: string): Promise<string> {
  const dir = join(root, 'build-host');
  const config = join(dir, 'sea-config.json');
  const blob = join(dir, 'host.blob');
  await writeFile(
    config,
    JSON.stringify({
      main: join(dir, 'host.cjs'),
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
  const executable = join(dir, hostExecutableName);
  await copyFile(process.execPath, executable);
  await inject(executable, 'NODE_SEA_BLOB', await readFile(blob), { sentinelFuse: seaFuse });
  return executable;
}
