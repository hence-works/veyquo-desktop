// Messages between the popup and the service worker (`chrome.runtime.sendMessage`). The
// popup names an action; the service worker works out the tab from the last focused browser
// window itself, so the popup can never name some other tab.

import type { PopupStatus } from './relay.ts';

export type PopupMessage =
  | { name: 'status' }
  | { name: 'grant' }
  | { name: 'revoke' }
  | { name: 'decline' }
  | { name: 'take_over' }
  | { name: 'hand_back' };

export type PopupAnswer = PopupStatus;

/** Sent by the service worker when what the popup shows may have changed. */
export const statusChanged = 'veyquo:status-changed';

const names = new Set<PopupMessage['name']>([
  'status',
  'grant',
  'revoke',
  'decline',
  'take_over',
  'hand_back',
]);

export function parsePopupMessage(value: unknown): PopupMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && names.has(name as PopupMessage['name'])
    ? { name: name as PopupMessage['name'] }
    : null;
}
