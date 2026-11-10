// The tray (Windows, Linux) or menu-bar (macOS) icon and its menu, from `tray-menu.ts`.

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';

import type { UiState } from '../shared/ui-state.ts';
import { trayMenu, trayTitle, type TrayAction } from './tray-menu.ts';

export class AppTray {
  private readonly tray: Tray;
  private readonly onAction: (action: TrayAction, checked: boolean) => void;

  constructor(buildDir: string, onAction: (action: TrayAction, checked: boolean) => void) {
    const icon = nativeImage.createFromPath(
      join(buildDir, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
    );
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.onAction = onAction;
  }

  update(state: UiState): void {
    const template: MenuItemConstructorOptions[] = trayMenu(state).map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      const id = item.id;
      return {
        type: item.type,
        label: item.label ?? '',
        enabled: item.enabled ?? true,
        ...(item.checked === undefined ? {} : { checked: item.checked }),
        click: (menuItem) => {
          if (id !== undefined && id !== 'status') this.onAction(id, menuItem.checked);
        },
      };
    });
    this.tray.setToolTip(trayTitle(state));
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray.destroy();
  }
}
