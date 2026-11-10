// The confirmations the app asks on this computer. Each is a native dialog, so it shows
// even when the status window is hidden. Copy follows design.md's plain, calm voice.

import type { Confirmation, Information } from './controller.ts';

export interface ConfirmationCopy {
  message: string;
  detail: string;
  confirm: string;
  cancel: string;
}

export const confirmations: Record<Confirmation, ConfirmationCopy> = {
  remove: {
    message: 'Remove Veyquo from this computer?',
    detail:
      'This computer is removed from your Veyquo account, and Veyquo’s Chrome profile here ' +
      'is deleted with the sign-ins you made in it, along with Veyquo’s local data. Your ' +
      'everyday Chrome profile is not touched.',
    confirm: 'Remove',
    cancel: 'Cancel',
  },
  revoked_profile: {
    message: 'This computer was removed from your Veyquo account.',
    detail:
      "Veyquo's data on this computer has been deleted. Delete the sign-ins in Veyquo's " +
      'Chrome profile too? Your everyday Chrome profile is not touched.',
    confirm: 'Delete sign-ins',
    cancel: 'Keep them',
  },
  clear_profile: {
    message: 'Clear sign-ins on this computer?',
    detail:
      'Veyquo asked to clear the sign-ins in its Chrome profile on this computer. You will ' +
      'need to sign in to those sites again before the agent can use them. Your everyday ' +
      'Chrome profile is not touched.',
    confirm: 'Clear sign-ins',
    cancel: 'Keep them',
  },
};

export const information: Record<Information, { message: string; detail: string }> = {
  removed_locally: {
    message: 'Veyquo was removed from this computer.',
    detail:
      'Your Veyquo account could not be reached, so it still lists this computer. Open ' +
      'Devices in Veyquo and remove it there too.',
  },
};
