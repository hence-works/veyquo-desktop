import { describe, expect, it } from 'vitest';

import { windowPlacement, type Displays, type Rect } from '../../src/main/placement.ts';

function displays(rects: Rect[], workAreaTop = 0): Displays {
  return {
    getAllDisplays: () => rects.map((bounds) => ({ bounds })),
    getPrimaryDisplay: () => {
      const first = rects[0] ?? { x: 0, y: 0, width: 0, height: 0 };
      return {
        bounds: first,
        workArea: { ...first, y: first.y + workAreaTop, height: first.height - workAreaTop },
      };
    },
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const size = { width: 1280, height: 900 };

describe('windowPlacement', () => {
  it.each([
    { layout: 'one display', rects: [{ x: 0, y: 0, width: 1920, height: 1080 }] },
    {
      layout: 'a display to the left of the primary',
      rects: [
        { x: 0, y: 0, width: 2560, height: 1440 },
        { x: -1920, y: 200, width: 1920, height: 1080 },
      ],
    },
    {
      layout: 'displays stacked vertically',
      rects: [
        { x: 0, y: 0, width: 1512, height: 982 },
        { x: -200, y: -1440, width: 2560, height: 1440 },
      ],
    },
    {
      layout: 'a scaled Windows layout with negative origins',
      rects: [
        { x: 0, y: 0, width: 1536, height: 864 },
        { x: -3840, y: -500, width: 3840, height: 2160 },
        { x: 1536, y: 0, width: 1920, height: 1080 },
      ],
    },
  ])('a background window lies on no display ($layout)', ({ rects }) => {
    const placement = windowPlacement(displays(rects));
    const position = placement.offScreen(size);
    const window = { x: position.left, y: position.top, ...size };
    for (const rect of rects) expect(overlaps(window, rect)).toBe(false);
  });

  it('a window made visible again is centred in the primary work area, below a menu bar', () => {
    const placement = windowPlacement(displays([{ x: 0, y: 0, width: 1920, height: 1080 }], 25));
    expect(placement.onScreen(size)).toEqual({ left: 320, top: 25 + 77 });
  });

  it('a window larger than the work area starts at its corner', () => {
    const placement = windowPlacement(displays([{ x: 100, y: 0, width: 1024, height: 768 }], 0));
    expect(placement.onScreen(size)).toEqual({ left: 100, top: 0 });
  });
});
