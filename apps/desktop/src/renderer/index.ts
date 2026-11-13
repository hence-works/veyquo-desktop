// The status window: one plain-TypeScript view of `UiState` (desktop plan §4.2). It builds
// DOM with `textContent` only, never HTML strings, and talks to the main process only
// through `window.veyquo` (the preload bridge).

import type { UiCommand, UiState, VeyquoBridge } from '../shared/ui-state.ts';

declare global {
  interface Window {
    veyquo: VeyquoBridge;
  }
}

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
function updateTheme(): void {
  document.documentElement.classList.toggle('dark', colorScheme.matches);
}
updateTheme();
colorScheme.addEventListener('change', updateTheme);

const statusLabels: Record<UiState['status'], string> = {
  signed_out: 'Not paired',
  pairing: 'Pairing',
  online: 'Online',
  working: 'Working',
  paused: 'Paused',
  offline: 'Offline',
};

type Child = Node | string | null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; testId?: string; data?: Record<string, string>; role?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className !== undefined) node.className = props.className;
  if (props.role !== undefined) node.setAttribute('role', props.role);
  if (props.testId !== undefined) node.dataset.testid = props.testId;
  for (const [key, value] of Object.entries(props.data ?? {})) node.dataset[key] = value;
  for (const child of children) {
    if (child === null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function send(command: UiCommand): void {
  void window.veyquo.command(command);
}

function button(
  label: string,
  command: UiCommand,
  kind: 'primary' | 'secondary' | 'ghost' | 'destructive' = 'secondary',
  testId?: string,
): HTMLButtonElement {
  const node = el(
    'button',
    { className: kind, ...(testId === undefined ? {} : { testId }) },
    label,
  );
  node.type = 'button';
  node.dataset.command =
    command.name === 'take_over' || command.name === 'hand_back'
      ? 'takeover'
      : command.name.startsWith('access_')
        ? 'access'
        : command.name;
  node.addEventListener('click', () => {
    send(command);
  });
  return node;
}

function row(term: string, value: string, testId?: string): HTMLElement {
  return el(
    'div',
    { className: 'row' },
    el('dt', {}, term),
    el('dd', testId === undefined ? {} : { testId }, value),
  );
}

function brandLogo(): HTMLElement {
  const source = el('source');
  source.media = '(prefers-color-scheme: dark)';
  source.srcset = 'veyquo-logo-dark.png';
  const image = el('img');
  image.src = 'veyquo-logo.png';
  image.alt = 'Veyquo';
  image.width = 128;
  image.height = 32;
  return el('picture', { className: 'brand' }, source, image);
}

function pairingCard(state: UiState): HTMLElement {
  if (state.status === 'pairing') {
    return el(
      'section',
      { className: 'card' },
      el('h2', {}, 'Approve this computer'),
      el(
        'p',
        {},
        'Your browser opened Veyquo. Check that it shows this code, then approve the computer.',
      ),
      state.pairing === null
        ? el('p', { className: 'muted' }, 'Getting a code…')
        : el('div', { className: 'code', testId: 'pairing-code' }, state.pairing.code),
      el('div', { className: 'actions' }, button('Cancel', { name: 'cancel_pairing' }, 'ghost')),
    );
  }
  return el(
    'section',
    { className: 'card' },
    el('h2', {}, 'Pair this computer'),
    el(
      'p',
      {},
      'Pairing lets your Veyquo agent apply to jobs in Chrome on this computer, with your own ' +
        'sign-ins. You approve it in your browser.',
    ),
    el(
      'div',
      { className: 'actions' },
      button('Pair this computer', { name: 'pair' }, 'primary', 'pair'),
    ),
  );
}

function accessCard(state: UiState): HTMLElement | null {
  const access = state.access;
  if (access.status === 'unknown' || access.status === 'not_required') return null;
  const connected = access.status === 'connected';
  const signingIn = access.status === 'signing_in';
  const section = el(
    'section',
    { className: 'card', testId: 'access' },
    el('h2', {}, connected ? 'Browser sign-in' : 'Sign in to connect'),
    el(
      'p',
      {},
      connected
        ? 'This computer is signed in and can connect to Veyquo.'
        : 'Use your browser to authorize this computer. You can keep your current VPN connected.',
    ),
    access.message === null
      ? null
      : el(
          'p',
          { className: 'muted', role: access.status === 'error' ? 'alert' : 'status' },
          access.message,
        ),
    el(
      'div',
      { className: 'actions' },
      connected
        ? button('Sign out of browser access', { name: 'access_sign_out' }, 'ghost')
        : signingIn
          ? button('Cancel sign-in', { name: 'access_cancel' }, 'ghost')
          : button('Sign in with browser', { name: 'access_sign_in' }, 'primary', 'access-sign-in'),
    ),
  );
  return section;
}

function chromeCard(state: UiState): HTMLElement {
  const chrome = state.chrome;
  const version =
    chrome.available === true
      ? `Version ${chrome.version}`
      : chrome.available === false
        ? chrome.message
        : 'Checking…';
  const profileControls = state.browserProfiles.map((profile) => {
    const select = el('select', { testId: `browser-mode-${profile.viewId}` });
    const labelId = `browser-mode-label-${profile.viewId}`;
    const helpId = `browser-mode-help-${profile.viewId}`;
    select.id = `browser-mode-${profile.viewId}`;
    select.setAttribute('aria-labelledby', labelId);
    if (profile.hasProxy) select.setAttribute('aria-describedby', helpId);
    select.disabled = state.browserModePending !== null;
    for (const [value, label] of [
      ['veyquo_profile', 'Veyquo profile'],
      ['everyday_profile', 'Everyday Chrome'],
    ] as const) {
      const option = el('option', {}, label);
      option.value = value;
      if (value === 'everyday_profile' && profile.hasProxy) option.disabled = true;
      select.append(option);
    }
    select.value = profile.chromeMode;
    select.addEventListener('change', () => {
      send({
        name: 'set_browser_mode',
        viewId: profile.viewId,
        mode: select.value === 'everyday_profile' ? 'everyday_profile' : 'veyquo_profile',
      });
    });
    const label = el('label', { className: 'browser-choice-label' }, profile.name);
    label.id = labelId;
    label.htmlFor = select.id;
    const help = profile.hasProxy
      ? el(
          'span',
          { className: 'muted' },
          'Proxy saved. Use the Veyquo profile. Remove the proxy in Veyquo settings to use everyday Chrome.',
        )
      : null;
    if (help !== null) help.id = helpId;
    return el('div', { className: 'browser-choice' }, label, select, help);
  });
  return el(
    'section',
    { className: 'card' },
    el('h2', {}, 'Browsers'),
    el(
      'dl',
      {},
      row('Chrome', version, 'chrome-version'),
      row(
        'Veyquo profile',
        state.selectedModes.veyquoProfile
          ? 'Selected in job profile settings'
          : state.modes.veyquoProfile
            ? 'Available'
            : 'Not available',
        'mode-veyquo',
      ),
      row(
        'Everyday profile',
        state.selectedModes.everydayProfile
          ? 'Selected in job profile settings'
          : state.modes.everydayProfile
            ? 'Available'
            : 'Needs the Veyquo extension',
        'mode-everyday',
      ),
    ),
    state.browserProfiles.length > 0
      ? el(
          'div',
          { className: 'browser-choices' },
          el('h3', {}, 'Job profiles on this computer'),
          ...profileControls,
          state.browserModePending === null
            ? null
            : el('p', { className: 'muted', role: 'status' }, 'Saving browser choice…'),
          el('p', { className: 'muted' }, 'Changes apply to new applications.'),
        )
      : el(
          'p',
          { className: 'muted' },
          'Choose this computer in a job profile’s Browser settings to select a browser here.',
        ),
  );
}

function egressCard(state: UiState): HTMLElement {
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = state.egress.enabled;
  toggle.disabled = state.egress.pending;
  toggle.dataset.testid = 'egress-enabled';
  toggle.addEventListener('change', () => {
    send({ name: 'set_egress_enabled', enabled: toggle.checked });
  });
  return el(
    'section',
    { className: state.egress.active ? 'card agent' : 'card', testId: 'egress' },
    el('h2', {}, 'Cloud browser internet access'),
    state.egress.active
      ? el(
          'p',
          { role: 'status', testId: 'egress-active' },
          'A Veyquo cloud browser is using this computer’s internet connection now.',
        )
      : el(
          'p',
          {},
          'Allow a cloud browser you select in Veyquo to reach job sites through this computer.',
        ),
    el(
      'p',
      { className: 'muted' },
      'Job sites will see this computer’s public IP address. Your local DNS provider may see the requested site names. Veyquo does not decrypt the secure site traffic.',
    ),
    el('label', { className: 'toggle' }, toggle, 'Allow access from selected cloud browsers'),
    state.egress.pending ? el('p', { className: 'muted', role: 'status' }, 'Saving…') : null,
    state.egress.active
      ? el(
          'div',
          { className: 'actions' },
          button('Stop now', { name: 'stop_egress' }, 'destructive', 'stop-egress'),
        )
      : null,
  );
}

function activityCard(state: UiState): HTMLElement {
  const activity = state.activity;
  if (activity.kind === 'idle') {
    return el(
      'section',
      { className: 'card' },
      el('h2', {}, 'Current activity'),
      el(
        'p',
        { testId: 'activity' },
        'Nothing is running. The agent will work here when a job profile set to this computer applies.',
      ),
    );
  }
  const visible = activity.visibility === 'visible';
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = visible;
  toggle.dataset.testid = 'visibility';
  toggle.addEventListener('change', () => {
    send({ name: 'set_visibility', visibility: toggle.checked ? 'visible' : 'background' });
  });
  return el(
    'section',
    { className: 'card agent' },
    el('h2', {}, 'Current activity'),
    el(
      'p',
      { testId: 'activity' },
      activity.takenOver
        ? 'You have control of the agent’s Chrome window. The agent will not submit this application.'
        : 'The agent is applying to a job in Chrome. Your mouse and keyboard are ignored in its window until you take over.',
    ),
    el(
      'div',
      { className: 'actions' },
      activity.takenOver
        ? button('Hand back', { name: 'hand_back' }, 'primary', 'hand-back')
        : button('Take over', { name: 'take_over' }, 'primary', 'take-over'),
    ),
    activity.takenOver
      ? el(
          'p',
          { className: 'muted' },
          'Hand back lets Veyquo continue filling this application. You’ll submit it yourself.',
        )
      : null,
    el('label', { className: 'toggle' }, toggle, 'Show the agent’s window'),
  );
}

function render(state: UiState): void {
  const root = document.getElementById('app');
  if (root === null) return;
  const focused = document.activeElement;
  const focusKey =
    focused instanceof HTMLElement
      ? (focused.dataset.command ?? focused.dataset.testid)
      : undefined;
  const paired = state.status !== 'signed_out' && state.status !== 'pairing';
  const accessBlocksPairing =
    state.access.status === 'required' ||
    state.access.status === 'signing_in' ||
    state.access.status === 'error';
  const pause = el('input');
  pause.type = 'checkbox';
  pause.checked = state.paused;
  pause.dataset.testid = 'pause';
  pause.addEventListener('change', () => {
    send({ name: 'set_paused', paused: pause.checked });
  });
  const sections: Child[] = [
    el(
      'header',
      {},
      brandLogo(),
      el(
        'span',
        { className: 'status', testId: 'status', data: { status: state.status } },
        el('span', { className: 'dot' }),
        statusLabels[state.status],
      ),
    ),
    el(
      'div',
      { className: 'introduction' },
      el('h1', {}, 'Your agent, on this computer'),
      el('p', {}, 'Manage local applications and stay in control.'),
    ),
    state.security === null
      ? null
      : el(
          'div',
          {
            className: 'notice',
            testId: 'security',
            data: { tone: state.security.tone },
            role: 'alert',
          },
          state.security.text,
        ),
    state.notice === null
      ? null
      : el(
          'div',
          {
            className: 'notice',
            testId: 'notice',
            data: { tone: state.notice.tone },
            role: state.notice.tone === 'error' ? 'alert' : 'status',
          },
          state.notice.text,
        ),
    accessCard(state),
    paired ? activityCard(state) : null,
    paired ? egressCard(state) : null,
    paired
      ? el(
          'section',
          { className: 'card' },
          el('h2', {}, 'This computer'),
          el('dl', {}, row('Name', state.deviceName, 'device-name')),
          el('label', { className: 'toggle' }, pause, 'Pause local work'),
        )
      : accessBlocksPairing
        ? null
        : pairingCard(state),
    chromeCard(state),
    el(
      'footer',
      {},
      button('Remove Veyquo from this computer…', { name: 'remove' }, 'destructive', 'remove'),
    ),
  ];
  root.replaceChildren(...sections.filter((section): section is Node => section !== null));
  if (focusKey !== undefined) {
    const target = [...root.querySelectorAll<HTMLElement>('button, input, select')].find(
      (node) => (node.dataset.command ?? node.dataset.testid) === focusKey,
    );
    const next =
      target ??
      (focusKey === 'access' ? root.querySelector<HTMLElement>('[data-testid="pair"]') : null);
    next?.focus({ preventScroll: true });
  }
}

window.veyquo.onState(render);
void window.veyquo.getState().then(render);
