import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import type { AgentOverlayUpdate } from '../../src/shared/agent-overlay.ts';

it('keeps the branded cursor label in view and honours reduced motion', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 680 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      let notify: (update: AgentOverlayUpdate) => void = () => undefined;
      Object.defineProperty(window, 'veyquoAgentOverlay', {
        value: Object.freeze({
          onUpdate: (listener: (update: AgentOverlayUpdate) => void) => {
            notify = listener;
          },
        }),
      });
      Object.defineProperty(window, 'testOverlayUpdate', {
        value: (update: AgentOverlayUpdate) => {
          notify(update);
        },
      });
    });
    const url = pathToFileURL(join(import.meta.dirname, '../../build/overlay/index.html'));
    await page.goto(url.href);
    await page.evaluate(() => {
      const send = (
        window as typeof window & { testOverlayUpdate: (u: AgentOverlayUpdate) => void }
      ).testOverlayUpdate;
      send({ kind: 'activity', visible: true });
      send({ kind: 'point', action: 'press', x: 355, y: 675, sequence: 1 });
    });

    expect(await page.getByRole('status').innerText()).toBe('Veyquo is controlling this browser');
    const cursor = page.locator('#agent-cursor');
    expect(await cursor.getAttribute('data-edge-x')).toBe('right');
    expect(await cursor.getAttribute('data-edge-y')).toBe('bottom');
    const label = cursor.locator('span');
    const box = await label.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) + (box?.width ?? 1)).toBeLessThanOrEqual(360);
    expect((box?.y ?? -1) + (box?.height ?? 1)).toBeLessThanOrEqual(680);
    const reducedTransition = await cursor.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).transitionDuration),
    );
    const reducedAnimation = await cursor
      .locator('i')
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).animationDuration));
    expect(reducedTransition).toBeLessThanOrEqual(0.000_01);
    expect(reducedAnimation).toBeLessThanOrEqual(0.000_01);
  } finally {
    await browser.close();
  }
});
