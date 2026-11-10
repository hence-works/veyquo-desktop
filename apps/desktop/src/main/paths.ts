// Where the app keeps its state, all under Electron's `userData` folder (desktop plan §7,
// §8). One place, so "Remove Veyquo from this computer" can find everything.

import { join } from 'node:path';

export interface AppPaths {
  userData: string;
  /** API and web URLs (`config.ts`). */
  config: string;
  /** Per-user staging OAuth session encrypted with OS secure storage. */
  accessSession: string;
  /** The device's Ed25519 private key, PKCS8, encrypted with `safeStorage`. */
  deviceKey: string;
  /** The paired device id (not a secret). */
  device: string;
  /** The submit journal (JSON lines, fsynced). */
  journal: string;
  /** Upload documents, one folder per session; swept on start. */
  tmp: string;
  /** The Veyquo Chrome profile: the person's site sign-ins. */
  chromeProfile: string;
  /** The PID of the Chrome this app launched. */
  chromePid: string;
  logs: string;
  /** The local IPC endpoint for the native-messaging host (Task 10), POSIX only. */
  nativeSocket: string;
  /** This run's key for that endpoint (`native-ipc.ts`). */
  nativeKey: string;
}

export function appPaths(userData: string): AppPaths {
  return {
    userData,
    config: join(userData, 'config.json'),
    accessSession: join(userData, 'access-session.bin'),
    deviceKey: join(userData, 'device-key.bin'),
    device: join(userData, 'device.json'),
    journal: join(userData, 'journal.jsonl'),
    tmp: join(userData, 'tmp'),
    chromeProfile: join(userData, 'chrome-profile'),
    chromePid: join(userData, 'chrome.pid'),
    logs: join(userData, 'logs'),
    nativeSocket: join(userData, 'native.sock'),
    nativeKey: join(userData, 'native-ipc.key'),
  };
}
