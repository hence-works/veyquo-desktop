import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAutostart, type LoginItems } from '../../src/main/autostart.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'veyquo-autostart-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function loginItems(): LoginItems & { calls: unknown[] } {
  const calls: unknown[] = [];
  let open = false;
  return {
    calls,
    setLoginItemSettings: (settings) => {
      calls.push(settings);
      open = settings.openAtLogin;
    },
    getLoginItemSettings: () => ({ openAtLogin: open }),
  };
}

describe('autostart', () => {
  it.each(['darwin', 'win32'] as const)('uses the login item on %s', async (platform) => {
    const items = loginItems();
    const autostart = createAutostart({ platform, home, execPath: '/x/Veyquo', loginItems: items });
    await autostart.enable();
    expect(await autostart.isEnabled()).toBe(true);
    await autostart.disable();
    expect(await autostart.isEnabled()).toBe(false);
    expect(items.calls).toEqual([
      { openAtLogin: true, args: ['--hidden'] },
      { openAtLogin: false, args: ['--hidden'] },
    ]);
  });

  it('writes an XDG autostart entry on linux', async () => {
    const items = loginItems();
    const autostart = createAutostart({
      platform: 'linux',
      home,
      execPath: '/opt/Veyquo/veyquo',
      loginItems: items,
    });
    await autostart.enable();
    const file = join(home, '.config', 'autostart', 'veyquo.desktop');
    const entry = await readFile(file, 'utf8');
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('Type=Application');
    expect(entry).toContain('Name=Veyquo');
    expect(entry).toContain('Exec="/opt/Veyquo/veyquo" --hidden');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await autostart.isEnabled()).toBe(true);
    expect(items.calls).toEqual([]);

    await autostart.disable();
    expect(await autostart.isEnabled()).toBe(false);
    await expect(stat(file)).rejects.toThrow();
  });

  it('starts the AppImage, not its temporary mount, and quotes the path', async () => {
    const autostart = createAutostart({
      platform: 'linux',
      home,
      execPath: '/tmp/.mount_Veyq1/veyquo',
      appImage: '/home/ana/Apps/Vey "quo" $1.AppImage',
      loginItems: loginItems(),
    });
    await autostart.enable();
    const entry = await readFile(join(home, '.config', 'autostart', 'veyquo.desktop'), 'utf8');
    expect(entry).toContain('Exec="/home/ana/Apps/Vey \\"quo\\" \\$1.AppImage" --hidden');
  });

  it('disabling twice is harmless', async () => {
    const autostart = createAutostart({
      platform: 'linux',
      home,
      execPath: '/opt/Veyquo/veyquo',
      loginItems: loginItems(),
    });
    await autostart.disable();
    await expect(autostart.disable()).resolves.toBeUndefined();
  });

  it('is never touched on an unknown platform', async () => {
    const items = loginItems();
    const set = vi.spyOn(items, 'setLoginItemSettings');
    const autostart = createAutostart({
      platform: 'freebsd',
      home,
      execPath: '/x',
      loginItems: items,
    });
    await autostart.enable();
    expect(set).not.toHaveBeenCalled();
    expect(await autostart.isEnabled()).toBe(false);
  });
});
