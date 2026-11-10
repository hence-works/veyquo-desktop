// Clearing Veyquo off this computer (desktop plan §4.4, §8).
//
// - Revoked (gateway close 4401, or a token refused as `device-revoked`): the device key, its
//   id, the journal and temp files are wiped at once. The Veyquo Chrome profile holds the
//   person's own site sign-ins, so it is deleted only after they confirm.
// - "Remove Veyquo from this computer": after one confirmation (which says the sign-ins go
//   too), everything the app keeps is deleted, the autostart entry and the native-messaging
//   host manifest are removed, and the device is revoked server-side when that is possible.
//   The person's everyday Chrome profile is never touched.

import { rm } from 'node:fs/promises';

import type { AppPaths } from './paths.ts';

async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

/** The device's credentials and state, everything but the Chrome profile. */
async function removeCredentials(paths: AppPaths): Promise<void> {
  await remove(paths.deviceKey);
  await remove(paths.accessSession);
  await remove(paths.device);
  await remove(paths.journal);
  await remove(paths.tmp);
}

export async function wipeRevokedDevice(deps: {
  paths: AppPaths;
  /** Shown to the person: delete the sign-ins in Veyquo's Chrome profile too? */
  confirmDeleteProfile: () => Promise<boolean>;
  /** Chrome must be closed before its profile can be deleted. */
  stopChrome: () => Promise<void>;
}): Promise<void> {
  await removeCredentials(deps.paths);
  if (await deps.confirmDeleteProfile()) {
    await deps.stopChrome();
    await remove(deps.paths.chromeProfile);
    await remove(deps.paths.chromePid);
  }
}

export interface RemoveDeps {
  paths: AppPaths;
  /** One confirmation for the whole removal, sign-ins included. */
  confirm: () => Promise<boolean>;
  stopConnection: () => void;
  stopChrome: () => Promise<void>;
  disableAutostart: () => Promise<void>;
  /** Task 10 registers the native-messaging host; removal unregisters it. */
  unregisterNativeHost?: () => Promise<void>;
  /** Revokes the device server-side with its own token (`POST /v1/devices/self/revoke`);
   * absent when this computer is not paired. */
  revokeRemote?: () => Promise<void>;
}

/** `removed_locally`: this computer is cleared, but its account could not be told. */
export type RemoveOutcome = 'removed' | 'removed_locally' | 'cancelled';

export async function removeFromComputer(deps: RemoveDeps): Promise<RemoveOutcome> {
  if (!(await deps.confirm())) return 'cancelled';
  // The socket first: the gateway answers a revocation with 4401, which must not be taken
  // for a second, separate revocation (and its own wipe and question).
  deps.stopConnection();
  let outcome: RemoveOutcome = 'removed';
  if (deps.revokeRemote !== undefined) {
    // Before the key is deleted: the device token is signed with it. An unreachable
    // account does not stop the local clean-up.
    outcome = await deps.revokeRemote().then(
      (): RemoveOutcome => 'removed',
      (): RemoveOutcome => 'removed_locally',
    );
  }
  await deps.stopChrome();
  await removeCredentials(deps.paths);
  await remove(deps.paths.chromeProfile);
  await remove(deps.paths.chromePid);
  await remove(deps.paths.config);
  await remove(deps.paths.nativeKey);
  await remove(deps.paths.logs);
  await deps.disableAutostart();
  await deps.unregisterNativeHost?.();
  return outcome;
}
