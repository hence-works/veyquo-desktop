// The tray (menu-bar) menu as plain data, so it can be tested without Electron; `tray.ts`
// turns it into Electron's menu. Status names follow the plan: signed out, pairing,
// online, working, paused, offline.

import type { DeviceStatus, UiState } from '../shared/ui-state.ts';

export type TrayAction = 'open' | 'take_over' | 'hand_back' | 'pause' | 'remove' | 'quit';

export interface TrayItem {
  id?: TrayAction | 'status';
  type: 'normal' | 'separator' | 'checkbox';
  label?: string;
  enabled?: boolean;
  checked?: boolean;
}

const statusWords: Record<DeviceStatus, string> = {
  signed_out: 'not paired',
  pairing: 'pairing',
  online: 'online',
  working: 'working',
  paused: 'paused',
  offline: 'offline',
};

export function trayTitle(state: UiState): string {
  return `Veyquo: ${statusWords[state.status]}`;
}

export function trayMenu(state: UiState): TrayItem[] {
  const applying = state.activity.kind === 'applying' ? state.activity : null;
  const paired = state.status !== 'signed_out' && state.status !== 'pairing';
  return [
    { id: 'status', type: 'normal', label: trayTitle(state), enabled: false },
    { type: 'separator' },
    { id: 'open', type: 'normal', label: 'Open status', enabled: true },
    {
      id: 'take_over',
      type: 'normal',
      label: 'Take over',
      enabled: applying !== null && !applying.takenOver,
    },
    { id: 'hand_back', type: 'normal', label: 'Hand back', enabled: applying?.takenOver === true },
    {
      id: 'pause',
      type: 'checkbox',
      label: 'Pause local work',
      checked: state.paused,
      enabled: paired,
    },
    { type: 'separator' },
    { id: 'remove', type: 'normal', label: 'Remove Veyquo from this computer…', enabled: true },
    { id: 'quit', type: 'normal', label: 'Quit Veyquo', enabled: true },
  ];
}
