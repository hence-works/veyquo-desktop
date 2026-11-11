// A native, click-through surface above the dedicated Veyquo Chrome profile. The employer
// page is never modified: local executor coordinates are drawn in this Electron window only.

import type { AgentVisualPoint, AgentVisualSink } from '@veyquo/local-executor';

import { agentOverlayChannel, type AgentOverlayUpdate } from '../shared/agent-overlay.ts';
import type { Rect } from './placement.ts';

type OverlayActivity =
  | { kind: 'idle' }
  | {
      kind: 'applying';
      takenOver: boolean;
      visibility: 'background' | 'visible';
      chromeMode?: 'veyquo_profile' | 'everyday_profile';
    };

export interface OverlayDisplay {
  bounds: Rect;
}

export interface OverlayWindow {
  readonly webContents: {
    on(event: 'did-finish-load', listener: () => void): void;
    send(channel: string, update: AgentOverlayUpdate): void;
  };
  isDestroyed(): boolean;
  setBounds(bounds: Rect, animate?: boolean): void;
  showInactive(): void;
  hide(): void;
  close(): void;
}

export interface AgentOverlayDeps {
  window: OverlayWindow;
  primaryDisplay(): OverlayDisplay;
  displayNearestPoint(point: { x: number; y: number }): OverlayDisplay;
}

function sameBounds(left: Rect | null, right: Rect): boolean {
  return (
    left !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export class AgentOverlay implements AgentVisualSink {
  private readonly deps: AgentOverlayDeps;
  private ready = false;
  private visible = false;
  private bounds: Rect | null = null;
  private sequence = 0;
  private pendingActivity: AgentOverlayUpdate = { kind: 'activity', visible: false };
  private pendingPoint: AgentOverlayUpdate | null = null;

  constructor(deps: AgentOverlayDeps) {
    this.deps = deps;
    deps.window.webContents.on('did-finish-load', () => {
      this.ready = true;
      this.send(this.pendingActivity);
      if (this.visible && this.pendingPoint !== null) this.send(this.pendingPoint);
    });
  }

  activity(activity: OverlayActivity): void {
    const visible =
      activity.kind === 'applying' &&
      activity.chromeMode === 'veyquo_profile' &&
      !activity.takenOver &&
      activity.visibility === 'visible';
    this.visible = visible;
    this.pendingActivity = { kind: 'activity', visible };
    if (!visible) {
      this.pendingPoint = null;
      this.send(this.pendingActivity);
      if (!this.deps.window.isDestroyed()) this.deps.window.hide();
      return;
    }
    this.useDisplay(this.deps.primaryDisplay());
    this.send(this.pendingActivity);
    if (!this.deps.window.isDestroyed()) this.deps.window.showInactive();
  }

  point(point: AgentVisualPoint): void {
    if (!this.visible || this.deps.window.isDestroyed()) return;
    const display = this.deps.displayNearestPoint(point);
    this.useDisplay(display);
    this.sequence += 1;
    this.pendingPoint = {
      kind: 'point',
      action: point.action,
      x: point.x - display.bounds.x,
      y: point.y - display.bounds.y,
      sequence: this.sequence,
    };
    this.send(this.pendingPoint);
    this.deps.window.showInactive();
  }

  close(): void {
    this.visible = false;
    if (!this.deps.window.isDestroyed()) this.deps.window.close();
  }

  private useDisplay(display: OverlayDisplay): void {
    if (sameBounds(this.bounds, display.bounds) || this.deps.window.isDestroyed()) return;
    this.bounds = { ...display.bounds };
    this.deps.window.setBounds(display.bounds, false);
  }

  private send(update: AgentOverlayUpdate): void {
    if (!this.ready || this.deps.window.isDestroyed()) return;
    this.deps.window.webContents.send(agentOverlayChannel, update);
  }
}
