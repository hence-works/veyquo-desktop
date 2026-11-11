import { describe, expect, it } from 'vitest';

import type { AgentOverlayUpdate } from '../../src/shared/agent-overlay.ts';
import {
  AgentOverlay,
  type OverlayDisplay,
  type OverlayWindow,
} from '../../src/main/agent-overlay.ts';

class FakeOverlayWindow implements OverlayWindow {
  readonly updates: AgentOverlayUpdate[] = [];
  readonly bounds: { x: number; y: number; width: number; height: number }[] = [];
  readonly webContents = {
    on: (_event: 'did-finish-load', listener: () => void): void => {
      this.loaded = listener;
    },
    send: (_channel: string, update: AgentOverlayUpdate): void => {
      this.updates.push(update);
    },
  };
  shows = 0;
  hides = 0;
  closed = false;
  private loaded: () => void = () => undefined;

  finishLoad(): void {
    this.loaded();
  }
  isDestroyed(): boolean {
    return this.closed;
  }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds.push(bounds);
  }
  showInactive(): void {
    this.shows += 1;
  }
  hide(): void {
    this.hides += 1;
  }
  close(): void {
    this.closed = true;
  }
}

const primary: OverlayDisplay = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const left: OverlayDisplay = { bounds: { x: -1280, y: 120, width: 1280, height: 800 } };

function setup(): { overlay: AgentOverlay; window: FakeOverlayWindow } {
  const window = new FakeOverlayWindow();
  const overlay = new AgentOverlay({
    window,
    primaryDisplay: () => primary,
    displayNearestPoint: ({ x }) => (x < 0 ? left : primary),
  });
  window.finishLoad();
  return { overlay, window };
}

describe('AgentOverlay', () => {
  it('shows only for a visible agent-driven Veyquo-profile session', () => {
    const { overlay, window } = setup();

    overlay.activity({
      kind: 'applying',
      chromeMode: 'veyquo_profile',
      takenOver: false,
      visibility: 'visible',
    });
    expect(window.bounds).toEqual([primary.bounds]);
    expect(window.shows).toBe(1);
    expect(window.updates.at(-1)).toEqual({ kind: 'activity', visible: true });

    overlay.activity({
      kind: 'applying',
      chromeMode: 'everyday_profile',
      takenOver: false,
      visibility: 'visible',
    });
    overlay.activity({
      kind: 'applying',
      chromeMode: 'veyquo_profile',
      takenOver: false,
      visibility: 'background',
    });
    overlay.activity({ kind: 'idle' });
    expect(window.hides).toBe(3);
    expect(window.updates.at(-1)).toEqual({ kind: 'activity', visible: false });
  });

  it('maps screen points into the active display and never reopens while hidden', () => {
    const { overlay, window } = setup();
    overlay.activity({
      kind: 'applying',
      chromeMode: 'veyquo_profile',
      takenOver: false,
      visibility: 'visible',
    });
    overlay.point({ action: 'press', x: -300, y: 400 });
    expect(window.bounds.at(-1)).toEqual(left.bounds);
    expect(window.updates.at(-1)).toEqual({
      kind: 'point',
      action: 'press',
      x: 980,
      y: 280,
      sequence: 1,
    });

    overlay.activity({
      kind: 'applying',
      chromeMode: 'veyquo_profile',
      takenOver: true,
      visibility: 'visible',
    });
    const shows = window.shows;
    const updates = window.updates.length;
    overlay.point({ action: 'focus', x: 300, y: 400 });
    expect(window.shows).toBe(shows);
    expect(window.updates).toHaveLength(updates);
  });
});
