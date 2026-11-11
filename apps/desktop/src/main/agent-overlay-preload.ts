// The native agent overlay's one-way bridge. It accepts only local, typed display state;
// the page cannot send commands back to the main process.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  agentOverlayChannel,
  type AgentOverlayBridge,
  type AgentOverlayUpdate,
} from '../shared/agent-overlay.ts';

const bridge: AgentOverlayBridge = {
  onUpdate: (listener) => {
    const handler = (_event: IpcRendererEvent, update: AgentOverlayUpdate): void => {
      listener(update);
    };
    ipcRenderer.on(agentOverlayChannel, handler);
    return () => {
      ipcRenderer.off(agentOverlayChannel, handler);
    };
  },
};

contextBridge.exposeInMainWorld('veyquoAgentOverlay', bridge);
