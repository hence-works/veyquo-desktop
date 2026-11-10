// Makes sure Electron's own binary is present. The repository installs with lifecycle
// scripts off, so electron's postinstall (which downloads the binary from GitHub and checks
// it against the checksums shipped in the package) does not run; this runs that same step on
// demand. It does nothing when the binary for the locked version is already there.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const install = fileURLToPath(import.meta.resolve('electron/install.js'));
const result = spawnSync(process.execPath, [install], { stdio: 'inherit' });
process.exit(result.status ?? 1);
