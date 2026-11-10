// The native-messaging host as its own executable, without Electron (Windows). Chrome's
// launcher runs `veyquo-native-host.exe --user-data <dir> --native-host <origin> ...`: a Node
// single executable application that scripts/host-executable.ts builds from
// `standalone-main.ts`, shipped in the app's resources folder.
//
// Electron cannot be the host on Windows. Its main process writes an empty line to stdout
// before any app code runs (`ElectronMainDelegate::BasicStartupComplete`, which on Windows
// writes `std::wcout << std::endl` so console output starts on a new line), and Chrome reads
// the host's stdout as length-prefixed frames: that `\r\n` would become part of the first
// frame's length. macOS and Linux keep `Veyquo --native-host` (`index.ts`).
//
// The relay is the same `runNativeHost` with the same checks; only the process around it
// differs. `--user-data` names the app's data folder (the key and the IPC endpoint), written
// into the launcher by the app, which knows where it keeps its state.

import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import type { Readable, Writable } from 'node:stream';

import { nativeEndpoint } from '../native-ipc.ts';
import { appPaths } from '../paths.ts';
import { exitCode, runNativeHost } from './host.ts';

/** The folder after `--user-data`, or null when it is missing or empty. */
export function userDataArg(argv: readonly string[]): string | null {
  const index = argv.indexOf('--user-data');
  const value = index < 0 ? undefined : argv[index + 1];
  return value === undefined || value.length === 0 || value.startsWith('--') ? null : value;
}

/** Relays Chrome's stdin and stdout to the running app; resolves to the exit code. */
export async function runStandaloneHost(options: {
  argv: readonly string[];
  platform: NodeJS.Platform;
  stdin: Readable;
  stdout: Writable;
}): Promise<number> {
  const userData = userDataArg(options.argv);
  if (userData === null) return 1;
  const endpoint = nativeEndpoint({
    platform: options.platform,
    userData,
    username: userInfo().username,
  });
  const exit = await runNativeHost({
    stdin: options.stdin,
    stdout: options.stdout,
    connect: () => connect(endpoint),
    readKey: () => readFile(appPaths(userData).nativeKey, 'utf8'),
  });
  return exitCode(exit);
}
