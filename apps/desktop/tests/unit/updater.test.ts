import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { manageAutomaticUpdates, type UpdateClient } from '../../src/main/updater.ts';
import type { Logger } from '../../src/main/log.ts';

class FakeUpdater extends EventEmitter implements UpdateClient {
  logger: unknown = undefined;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  readonly checkForUpdates = vi.fn(() => Promise.resolve(null));
  readonly quitAndInstall = vi.fn();
}

function logger(): {
  log: Logger;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const error = vi.fn();
  return { log: { info, warn: vi.fn(), error }, info, error };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('automatic updates', () => {
  it('downloads, checks periodically and hands a ready installer to the app', async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const { log, info } = logger();
    let install: (() => void) | undefined;
    const updates = manageAutomaticUpdates(
      {
        log,
        onReady: (ready) => {
          install = ready;
        },
      },
      updater,
    );

    expect(updater.logger).toBeNull();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    updater.emit('update-downloaded');
    expect(info).toHaveBeenCalledWith('update.ready');
    install?.();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    updates.stop();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('records a rejected update check without leaking updater logging', async () => {
    const updater = new FakeUpdater();
    const failure = new Error('feed unavailable');
    updater.checkForUpdates.mockRejectedValueOnce(failure);
    const { log, error } = logger();
    const updates = manageAutomaticUpdates({ log, onReady: vi.fn() }, updater);

    await Promise.resolve();
    expect(error).toHaveBeenCalledWith('update.check_failed', failure);
    updates.stop();
  });
});
