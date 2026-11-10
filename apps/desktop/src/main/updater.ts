// Updates (desktop plan §8): electron-updater with signature verification, from the
// generic feed set at build time (`VEYQUO_UPDATE_URL`). Enabled only in signed packaged
// builds; unsigned internal builds are installed by hand.

import type { Logger } from './log.ts';

declare const __VEYQUO_SIGNED_BUILD__: boolean;

export async function checkForUpdates(options: { packaged: boolean; log: Logger }): Promise<void> {
  if (!options.packaged || !__VEYQUO_SIGNED_BUILD__) return;
  try {
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.logger = null; // its messages can carry URLs; the app logs ids only
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (error) {
    options.log.error('update.check_failed', error);
  }
}
