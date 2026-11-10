// What the status window and the tray show. Built in the main process, sent to the
// renderer over the preload bridge. Ids and short, app-written copy only: no page content.

export type DeviceStatus = 'signed_out' | 'pairing' | 'online' | 'working' | 'paused' | 'offline';

export type ChromeAvailability =
  | { available: true; version: string }
  | { available: false; message: string }
  | { available: null };

export type Activity =
  { kind: 'idle' } | { kind: 'applying'; takenOver: boolean; visibility: 'visible' | 'background' };

export interface Notice {
  tone: 'info' | 'warning' | 'error';
  text: string;
}

export interface AccessState {
  status: 'unknown' | 'not_required' | 'required' | 'signing_in' | 'connected' | 'error';
  message: string | null;
}

export interface UiState {
  access: AccessState;
  status: DeviceStatus;
  /** The name this computer offered when it paired (the person may rename it on the web). */
  deviceName: string;
  pairing: { code: string; approveUrl: string; expiresAt: string } | null;
  chrome: ChromeAvailability;
  /** Chrome modes this computer can offer now. */
  modes: { veyquoProfile: boolean; everydayProfile: boolean };
  /** Modes selected by job profiles attached to this computer. */
  selectedModes: { veyquoProfile: boolean; everydayProfile: boolean };
  /** The browser selected for each job profile attached to this computer. */
  browserProfiles: {
    viewId: string;
    name: string;
    chromeMode: 'veyquo_profile' | 'everyday_profile';
    hasProxy: boolean;
  }[];
  /** Profile whose browser choice is being saved through the API. */
  browserModePending: string | null;
  activity: Activity;
  paused: boolean;
  notice: Notice | null;
  /** A security problem that lasts for this run (the local IPC endpoint could not be
   * opened). Shown apart from `notice`, which other events replace. */
  security: Notice | null;
}

export const initialUiState: UiState = {
  access: { status: 'unknown', message: null },
  status: 'signed_out',
  deviceName: '',
  pairing: null,
  chrome: { available: null },
  modes: { veyquoProfile: false, everydayProfile: false },
  selectedModes: { veyquoProfile: false, everydayProfile: false },
  browserProfiles: [],
  browserModePending: null,
  activity: { kind: 'idle' },
  paused: false,
  notice: null,
  security: null,
};

/** The actions the renderer may ask for (validated again in the main process). */
export type UiCommand =
  | { name: 'access_sign_in' }
  | { name: 'access_cancel' }
  | { name: 'access_sign_out' }
  | { name: 'pair' }
  | { name: 'cancel_pairing' }
  | { name: 'take_over' }
  | { name: 'hand_back' }
  | { name: 'set_visibility'; visibility: 'visible' | 'background' }
  | {
      name: 'set_browser_mode';
      viewId: string;
      mode: 'veyquo_profile' | 'everyday_profile';
    }
  | { name: 'set_paused'; paused: boolean }
  | { name: 'remove' };

/** The preload bridge, as `window.veyquo` in the renderer. */
export interface VeyquoBridge {
  getState(): Promise<UiState>;
  onState(listener: (state: UiState) => void): () => void;
  command(command: UiCommand): Promise<void>;
}

export const ipcChannels = {
  getState: 'veyquo:get-state',
  state: 'veyquo:state',
  command: 'veyquo:command',
} as const;
