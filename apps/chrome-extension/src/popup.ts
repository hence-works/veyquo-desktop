// The toolbar popup: the connection to the app, the person's tab ("Let Veyquo use this tab"),
// the agent's request for a tab, and Take over / Hand back. It shows only app-written copy
// built with `textContent`: no page content, no HTML strings.

import { statusChanged, type PopupMessage } from './messages.ts';
import type { PopupStatus } from './relay.ts';

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
function updateTheme(): void {
  document.documentElement.classList.toggle('dark', colorScheme.matches);
}
updateTheme();
colorScheme.addEventListener('change', updateTheme);

const root = document.getElementById('root');
let pendingFocusCommand: string | undefined;

function element(
  tag: string,
  options: { className?: string; testId?: string; text?: string; role?: string } = {},
  ...children: HTMLElement[]
): HTMLElement {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.testId !== undefined) node.dataset.testid = options.testId;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.role !== undefined) node.setAttribute('role', options.role);
  node.append(...children);
  return node;
}

function button(label: string, message: PopupMessage, kind: 'primary' | 'secondary'): HTMLElement {
  const node = element('button', { className: `button ${kind}`, text: label });
  node.setAttribute('type', 'button');
  node.dataset.command =
    message.name === 'take_over' || message.name === 'hand_back'
      ? 'takeover'
      : message.name === 'grant' || message.name === 'revoke'
        ? 'tab-permission'
        : message.name;
  node.addEventListener('click', () => {
    pendingFocusCommand = node.dataset.command;
    (node as HTMLButtonElement).disabled = true;
    void send(message);
  });
  return node;
}

function tabSection(status: PopupStatus): HTMLElement {
  const section = element(
    'section',
    { className: 'section', testId: 'tab' },
    element('h2', { text: 'Current tab' }),
  );
  switch (status.tab) {
    case 'agent':
      section.append(
        element('p', { className: 'supporting', text: 'Veyquo is working in this tab.' }),
      );
      break;
    case 'granted':
      section.append(
        element('p', {
          className: 'supporting',
          text: 'Veyquo may use this tab while it stays on this site.',
        }),
        button('Stop letting Veyquo use this tab', { name: 'revoke' }, 'secondary'),
      );
      break;
    case 'grantable':
      section.append(
        button(
          'Let Veyquo use this tab',
          { name: 'grant' },
          status.activity === 'idle' ? 'primary' : 'secondary',
        ),
        element('p', {
          className: 'supporting',
          text: 'This allows Veyquo to work here until you leave this site or take the tab back.',
        }),
      );
      break;
    case 'unavailable':
      section.append(
        element('p', { className: 'supporting', text: 'Veyquo can’t use this page.' }),
      );
      break;
  }
  return section;
}

function browserSettingsUrl(status: PopupStatus | null): string | null {
  if (!status?.connected || status.browser_settings_url === undefined) return null;
  try {
    const url = new URL(status.browser_settings_url);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (
      !((url.protocol === 'http:' && loopback) || url.protocol === 'https:') ||
      url.pathname !== '/app/settings/browser' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function proxySection(status: PopupStatus | null): HTMLElement {
  const section = element(
    'section',
    { className: 'section proxy', testId: 'proxy' },
    element(
      'div',
      { className: 'section-title-row' },
      element('h2', { text: 'Account proxy' }),
      element('span', { className: 'section-kicker', text: 'Veyquo profile only' }),
    ),
    element('p', {
      className: 'supporting',
      text: 'Set a proxy for each job profile’s separate Veyquo browser. This everyday Chrome keeps its own network connection.',
    }),
  );
  const url = browserSettingsUrl(status);
  if (url !== null) {
    const link = element('a', {
      className: 'text-link',
      testId: 'proxy-settings',
      text: 'Manage proxy settings (opens in a new tab)',
    });
    link.setAttribute('href', url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    section.append(link);
  } else {
    section.append(
      element('p', {
        className: 'supporting',
        text: status?.connected
          ? 'Open Browser settings in your Veyquo account to manage proxies.'
          : 'Open the desktop app, then manage proxies in your Veyquo account.',
      }),
    );
  }
  return section;
}

function render(status: PopupStatus | null): void {
  if (root === null) return;
  const focused = document.activeElement;
  const focusCommand =
    (focused instanceof HTMLElement ? focused.dataset.command : undefined) ?? pendingFocusCommand;
  pendingFocusCommand = undefined;
  const logo = element('img', { className: 'brand-mark' });
  logo.setAttribute('src', 'icons/32.png');
  logo.setAttribute('alt', '');
  const parts: HTMLElement[] = [
    element(
      'header',
      {},
      logo,
      element(
        'div',
        { className: 'brand-copy' },
        element('h1', { text: 'Veyquo' }),
        element('p', { className: 'eyebrow', text: 'Chrome companion' }),
      ),
    ),
    element(
      'section',
      {
        className: `connection-card ${status === null ? 'error' : status.connected ? 'online' : 'offline'}`,
      },
      element('span', { className: 'status-dot' }),
      element(
        'div',
        {},
        element('p', {
          className: 'connection-label',
          testId: 'connection',
          role: 'status',
          text:
            status === null
              ? 'Couldn’t check the connection'
              : status.connected
                ? 'Connected to the Veyquo app'
                : 'Veyquo app is offline',
        }),
        ...(status === null
          ? [
              element('p', {
                className: 'connection-help',
                text: 'Try again to see whether Veyquo is ready to work here.',
              }),
              button('Try again', { name: 'status' }, 'secondary'),
            ]
          : status.connected
            ? []
            : [
                element('p', {
                  className: 'connection-help',
                  text: 'Open the desktop app on this computer to let Veyquo work here.',
                }),
              ]),
      ),
    ),
  ];
  if (status?.connected) {
    if (status.asking) {
      parts.push(
        element(
          'section',
          { className: 'section notice', testId: 'asking' },
          element('h2', { text: 'Waiting for your permission' }),
          element('p', {
            className: 'supporting',
            text: 'Veyquo is asking to use a tab. Open the tab you want it to use, then choose “Let Veyquo use this tab”.',
          }),
          button('Not now', { name: 'decline' }, 'secondary'),
        ),
      );
    }
    if (status.activity === 'applying') {
      parts.push(
        element(
          'section',
          { className: 'section activity', testId: 'activity' },
          element('h2', { text: 'Working on an application' }),
          element('p', { className: 'supporting', text: 'Veyquo is filling in the form.' }),
          button('Take over', { name: 'take_over' }, 'primary'),
        ),
      );
    } else if (status.activity === 'taken_over') {
      parts.push(
        element(
          'section',
          { className: 'section activity', testId: 'activity' },
          element('h2', { text: 'You’re in control' }),
          element('p', {
            className: 'supporting',
            text: 'You have control. Veyquo won’t press submit on this application.',
          }),
          element('p', {
            className: 'supporting',
            text: 'Hand back lets Veyquo continue filling this application. You’ll submit it yourself.',
          }),
          button('Hand back', { name: 'hand_back' }, 'primary'),
        ),
      );
    }
    parts.push(tabSection(status));
  }
  parts.push(proxySection(status));
  parts.push(
    element('p', {
      className: 'footnote',
      text: 'Chrome shows “Veyquo started debugging this browser” while the agent works in a tab here.',
    }),
  );
  root.replaceChildren(...parts);
  if (focusCommand !== undefined) {
    const target = [...root.querySelectorAll<HTMLElement>('button')].find(
      (node) => node.dataset.command === focusCommand,
    );
    const fallback =
      root.querySelector<HTMLElement>('button') ??
      root.querySelector<HTMLElement>('[data-testid="connection"]');
    const focusTarget = target ?? fallback;
    if (focusTarget !== null) {
      if (focusTarget.tagName !== 'BUTTON') focusTarget.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
    }
  }
}

async function send(message: PopupMessage): Promise<void> {
  try {
    render(await chrome.runtime.sendMessage<PopupMessage, PopupStatus>(message));
  } catch {
    render(null);
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { name?: unknown } | null)?.name === statusChanged) void send({ name: 'status' });
});

void send({ name: 'status' });
