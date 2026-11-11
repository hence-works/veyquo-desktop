// Local visual preview only. The unpacked extension and Chromium tests exercise the native host.
import type { PopupMessage } from './messages.ts';
import type { PopupStatus } from './relay.ts';

type PreviewState =
  'ready' | 'offline' | 'error' | 'asking' | 'granted' | 'applying' | 'taken_over';

const stateSelect = document.querySelector<HTMLSelectElement>('#preview-state');
let state: PreviewState = 'ready';
const listeners: ((message: unknown) => void)[] = [];

function status(): PopupStatus {
  return {
    connected: state !== 'offline',
    activity: state === 'applying' || state === 'taken_over' ? state : 'idle',
    tab: state === 'granted' ? 'granted' : state === 'applying' ? 'agent' : 'grantable',
    asking: state === 'asking',
    browser_settings_url:
      state === 'offline' ? undefined : 'http://127.0.0.1:3400/app/settings/browser',
  };
}

function notify(): void {
  for (const listener of listeners) listener({ name: 'veyquo:status-changed' });
}

Object.assign(globalThis, {
  chrome: {
    runtime: {
      onMessage: {
        addListener: (listener: (message: unknown) => void) => listeners.push(listener),
      },
      sendMessage: (message: PopupMessage): Promise<PopupStatus> => {
        if (state === 'error') return Promise.reject(new Error('Preview connection check failed'));
        if (message.name === 'grant') state = 'granted';
        if (message.name === 'revoke' || message.name === 'decline') state = 'ready';
        if (message.name === 'take_over') state = 'taken_over';
        if (message.name === 'hand_back') state = 'applying';
        if (stateSelect !== null) stateSelect.value = state;
        return Promise.resolve(status());
      },
    },
  },
});

stateSelect?.addEventListener('change', () => {
  state = stateSelect.value as PreviewState;
  notify();
});

await import('./popup.ts');
