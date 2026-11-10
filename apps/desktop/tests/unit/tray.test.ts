import { describe, expect, it } from 'vitest';

import { initialUiState, type UiState } from '../../src/shared/ui-state.ts';
import { trayMenu, trayTitle } from '../../src/main/tray-menu.ts';

function state(patch: Partial<UiState>): UiState {
  return { ...initialUiState, ...patch };
}

function enabled(s: UiState): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = {};
  for (const item of trayMenu(s)) if (item.id !== undefined) out[item.id] = item.enabled;
  return out;
}

describe('tray', () => {
  it.each([
    { status: 'signed_out', title: 'Veyquo: not paired' },
    { status: 'pairing', title: 'Veyquo: pairing' },
    { status: 'online', title: 'Veyquo: online' },
    { status: 'working', title: 'Veyquo: working' },
    { status: 'paused', title: 'Veyquo: paused' },
    { status: 'offline', title: 'Veyquo: offline' },
  ] as const)('says $status as "$title"', ({ status, title }) => {
    expect(trayTitle(state({ status }))).toBe(title);
  });

  it('offers Take over only while the agent drives, and Hand back only after', () => {
    const idle = enabled(state({ status: 'online' }));
    expect(idle).toMatchObject({ take_over: false, hand_back: false });
    const driving = enabled(
      state({
        status: 'working',
        activity: { kind: 'applying', takenOver: false, visibility: 'background' },
      }),
    );
    expect(driving).toMatchObject({ take_over: true, hand_back: false });
    const taken = enabled(
      state({
        status: 'working',
        activity: { kind: 'applying', takenOver: true, visibility: 'visible' },
      }),
    );
    expect(taken).toMatchObject({ take_over: false, hand_back: true });
  });

  it('lists every action the plan names', () => {
    expect(trayMenu(state({ status: 'online' })).map((i) => i.id ?? '—')).toEqual([
      'status',
      '—',
      'open',
      'take_over',
      'hand_back',
      'pause',
      '—',
      'remove',
      'quit',
    ]);
  });

  it('Pause local work is a checkbox that shows the paused state', () => {
    const pause = trayMenu(state({ status: 'paused', paused: true })).find((i) => i.id === 'pause');
    expect(pause).toMatchObject({ type: 'checkbox', checked: true, enabled: true });
    const signedOut = trayMenu(state({ status: 'signed_out' })).find((i) => i.id === 'pause');
    expect(signedOut?.enabled).toBe(false);
  });
});
