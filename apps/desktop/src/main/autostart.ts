// Starting with the computer (desktop plan §8): the OS login item on macOS and Windows
// (`app.setLoginItemSettings`), an XDG autostart entry at `~/.config/autostart/veyquo.desktop`
// on Linux. The app starts hidden, in the tray. Removal takes the entry away again.

import { mkdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export interface LoginItems {
  setLoginItemSettings(settings: { openAtLogin: boolean; args: string[] }): void;
  getLoginItemSettings(): { openAtLogin: boolean };
}

export interface Autostart {
  enable(): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): Promise<boolean>;
}

const hiddenArgs = ['--hidden'];

/** Quotes a path for a desktop entry's `Exec` (freedesktop Desktop Entry spec). */
function execQuoted(path: string): string {
  return `"${path.replace(/["`$\\]/gu, (char) => `\\${char}`)}"`;
}

export function createAutostart(options: {
  platform: NodeJS.Platform;
  home: string;
  execPath: string;
  /** Set when running from an AppImage: the image, not its temporary mount, is started. */
  appImage?: string;
  loginItems: LoginItems;
}): Autostart {
  const { platform, loginItems } = options;
  if (platform === 'darwin' || platform === 'win32') {
    return {
      enable: () => {
        loginItems.setLoginItemSettings({ openAtLogin: true, args: hiddenArgs });
        return Promise.resolve();
      },
      disable: () => {
        loginItems.setLoginItemSettings({ openAtLogin: false, args: hiddenArgs });
        return Promise.resolve();
      },
      isEnabled: () => Promise.resolve(loginItems.getLoginItemSettings().openAtLogin),
    };
  }
  if (platform !== 'linux') {
    return {
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      isEnabled: () => Promise.resolve(false),
    };
  }
  const dir = join(options.home, '.config', 'autostart');
  const file = join(dir, 'veyquo.desktop');
  const target = options.appImage ?? options.execPath;
  return {
    async enable() {
      await mkdir(dir, { recursive: true });
      const entry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Veyquo',
        'Comment=Runs your Veyquo job agent in your own Chrome',
        `Exec=${execQuoted(target)} ${hiddenArgs.join(' ')}`,
        'X-GNOME-Autostart-enabled=true',
        'NoDisplay=true',
        'Terminal=false',
        '',
      ].join('\n');
      await writeFile(file, entry, { mode: 0o644 });
      await chmod(file, 0o644);
    },
    async disable() {
      await rm(file, { force: true });
    },
    async isEnabled() {
      try {
        await stat(file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
