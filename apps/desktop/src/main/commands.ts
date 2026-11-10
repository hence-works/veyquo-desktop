// What the status window may ask the main process to do. The renderer is sandboxed and
// loads only the app's own page, but its messages are still parsed here, at the boundary.

import { z } from 'zod';

import type { UiCommand } from '../shared/ui-state.ts';

const command = z.discriminatedUnion('name', [
  z.object({ name: z.literal('access_sign_in') }),
  z.object({ name: z.literal('access_cancel') }),
  z.object({ name: z.literal('access_sign_out') }),
  z.object({ name: z.literal('pair') }),
  z.object({ name: z.literal('cancel_pairing') }),
  z.object({ name: z.literal('take_over') }),
  z.object({ name: z.literal('hand_back') }),
  z.object({
    name: z.literal('set_visibility'),
    visibility: z.enum(['visible', 'background']),
  }),
  z.object({
    name: z.literal('set_browser_mode'),
    viewId: z.uuid(),
    mode: z.enum(['veyquo_profile', 'everyday_profile']),
  }),
  z.object({ name: z.literal('set_paused'), paused: z.boolean() }),
  z.object({ name: z.literal('remove') }),
]);

export function parseCommand(raw: unknown): UiCommand | null {
  const parsed = command.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Only the app's own status page, loaded from its files, may send commands. */
export function isOwnPage(senderUrl: string | undefined, pageUrl: string): boolean {
  return senderUrl !== undefined && senderUrl === pageUrl;
}
