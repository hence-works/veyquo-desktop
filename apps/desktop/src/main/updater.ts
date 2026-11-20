// Updates (desktop plan §8): electron-updater with signature verification, from the
// generic feed set at build time (`VEYQUO_UPDATE_URL`). Enabled only in signed packaged
// builds; unsigned internal builds are installed by hand. A downloaded update is handed
// to the app so it can wait for local browser work to become idle, cleanly close its
// connection and Chrome, then restart into the installer.

import type { Logger } from './log.ts';

declare const __VEYQUO_SIGNED_BUILD__: boolean;

const checkIntervalMs = 4 * 60 * 60 * 1_000;

export interface AutomaticUpdates {
  stop(): void;
}

export interface UpdateClient {
  logger: unknown;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'update-downloaded', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'update-downloaded', listener: () => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

const disabledUpdates: AutomaticUpdates = { stop: () => undefined };

export function manageAutomaticUpdates(
  options: { log: Logger; onReady: (install: () => void) => void },
  autoUpdater: UpdateClient,
): AutomaticUpdates {
  autoUpdater.logger = null; // its messages can carry URLs; the app logs ids only
  autoUpdater.autoDownload = true;
  // The main process owns shutdown so an update cannot kill an active browser session.
  autoUpdater.autoInstallOnAppQuit = false;

  const onDownloaded = (): void => {
    options.log.info('update.ready');
    options.onReady(() => {
      autoUpdater.quitAndInstall(false, true);
    });
  };
  const onError = (error: Error): void => {
    options.log.error('update.check_failed', error);
  };
  autoUpdater.on('update-downloaded', onDownloaded);
  autoUpdater.on('error', onError);

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch(onError);
  };
  check();
  const timer = setInterval(check, checkIntervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      autoUpdater.removeListener('update-downloaded', onDownloaded);
      autoUpdater.removeListener('error', onError);
    },
  };
}

export async function startAutomaticUpdates(options: {
  packaged: boolean;
  log: Logger;
  onReady: (install: () => void) => void;
}): Promise<AutomaticUpdates> {
  if (!options.packaged || !__VEYQUO_SIGNED_BUILD__) return disabledUpdates;
  try {
    const { autoUpdater } = await import('electron-updater');
    return manageAutomaticUpdates(options, autoUpdater);
  } catch (error) {
    options.log.error('update.check_failed', error);
    return disabledUpdates;
  }
}
