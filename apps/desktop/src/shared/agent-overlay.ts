import type { AgentVisualAction } from '@veyquo/local-executor';

export type AgentOverlayUpdate =
  | { kind: 'activity'; visible: boolean }
  | { kind: 'point'; action: AgentVisualAction; x: number; y: number; sequence: number };

export interface AgentOverlayBridge {
  onUpdate(listener: (update: AgentOverlayUpdate) => void): () => void;
}

export const agentOverlayChannel = 'veyquo:agent-overlay';

declare global {
  interface Window {
    veyquoAgentOverlay: AgentOverlayBridge;
  }
}
