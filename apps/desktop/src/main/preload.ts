// The status window's only way to the main process: three typed calls, exposed as
// `window.veyquo` through the context bridge. No Node, no `ipcRenderer` in the page.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  ipcChannels,
  type UiCommand,
  type UiState,
  type VeyquoBridge,
} from '../shared/ui-state.ts';

const bridge: VeyquoBridge = {
  getState: () => ipcRenderer.invoke(ipcChannels.getState) as Promise<UiState>,
  onState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: UiState): void => {
      listener(state);
    };
    ipcRenderer.on(ipcChannels.state, handler);
    return () => {
      ipcRenderer.off(ipcChannels.state, handler);
    };
  },
  command: (command: UiCommand) =>
    ipcRenderer.invoke(ipcChannels.command, command) as Promise<void>,
};

contextBridge.exposeInMainWorld('veyquo', bridge);
