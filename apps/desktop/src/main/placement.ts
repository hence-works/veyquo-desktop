// Where agent windows go (desktop plan §4.3; Task 9 carry 6). "background" is an unfocused
// window placed beyond the left edge of every display, never minimised: a minimised window
// stops painting, which stalls screencast and page timers. The displays come from
// Electron's `screen`, so a display arranged to the left (negative coordinates, common on
// Windows and macOS) is cleared too. "visible" centres the window in the primary display's
// work area (below the macOS menu bar, above the Windows taskbar).
//
// Verified under Xvfb on Linux. On macOS, AppKit constrains only a window's vertical
// position to keep its title bar on a screen, so a horizontal off-screen position stands;
// on Windows, Chrome applies the bounds as given. Both still need checking on real
// machines (Task 12's per-OS smoke run).

import type { WindowPlacement } from '@veyquo/local-executor';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Electron's `screen`, as far as placement needs it. */
export interface Displays {
  getAllDisplays(): { bounds: Rect }[];
  getPrimaryDisplay(): { bounds: Rect; workArea: Rect };
}

/** Space between the window and the leftmost display edge. */
const margin = 200;

export function windowPlacement(screen: Displays): WindowPlacement {
  return {
    offScreen(size) {
      const displays = screen.getAllDisplays();
      const leftmost = Math.min(0, ...displays.map((display) => display.bounds.x));
      const top = screen.getPrimaryDisplay().workArea.y;
      return { left: Math.floor(leftmost - size.width - margin), top };
    },
    onScreen(size) {
      const area = screen.getPrimaryDisplay().workArea;
      return {
        left: area.x + Math.max(0, Math.floor((area.width - size.width) / 2)),
        top: area.y + Math.max(0, Math.floor((area.height - size.height) / 2)),
      };
    },
  };
}
