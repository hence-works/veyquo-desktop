import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  ignore: null as { ignore: boolean; options: unknown } | null,
  loaded: '',
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn() },
  session: { defaultSession: {} },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      electron.options = options;
    }
    removeMenu(): void {
      // BrowserWindow parity; nothing to record for this assertion.
    }
    setIgnoreMouseEvents(ignore: boolean, options: unknown): void {
      electron.ignore = { ignore, options };
    }
    loadURL(url: string): Promise<void> {
      electron.loaded = url;
      return Promise.resolve();
    }
  },
}));

import { createAgentOverlayWindow } from '../../src/main/window.ts';

describe('createAgentOverlayWindow', () => {
  beforeEach(() => {
    electron.options = null;
    electron.ignore = null;
    electron.loaded = '';
  });

  it('creates a focusless, transparent and click-through native surface', () => {
    createAgentOverlayWindow({
      buildDir: '/opt/veyquo/build',
      bounds: { x: -1280, y: 120, width: 1280, height: 800 },
    });

    expect(electron.options).toMatchObject({
      x: -1280,
      y: 120,
      width: 1280,
      height: 800,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      show: false,
    });
    expect(electron.options).not.toHaveProperty('alwaysOnTop');
    expect(electron.ignore).toEqual({ ignore: true, options: { forward: true } });
    expect(electron.loaded).toMatch(/\/overlay\/index\.html$/u);
  });
});
