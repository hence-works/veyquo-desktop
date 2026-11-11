// The extension's service worker: connects to the Veyquo desktop app through the native
// host (`connectNative("works.hence.veyquo")`) and gives the relay Chrome's debugger, tabs
// and windows. The relay (`relay.ts`) decides; this file only wires `chrome.*` to it.
//
// The open native-messaging port keeps this worker alive while the app is connected. When
// the port closes (the app quit, or is not running), it reconnects with backoff while the
// worker lives, and again whenever Chrome wakes it (start-up, the popup, a tab event).
//
// Nothing is logged: no page content, URLs or relay frames.

import { nativeHostName } from '@veyquo/local-executor/extension-protocol';

import { AgentWindow } from './agent-window.ts';
import { parsePopupMessage, statusChanged, type PopupMessage } from './messages.ts';
import { ExtensionRelay, type ActiveTab, type BrowserApi, type PopupStatus } from './relay.ts';

const agentWindow = new AgentWindow();

const browser: BrowserApi = {
  attach: (tabId) => chrome.debugger.attach({ tabId }, '1.3'),
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  send: (tabId, method, params) =>
    chrome.debugger.sendCommand({ tabId }, method, params as Record<string, unknown>),
  // Both visibilities: an unfocused Veyquo window (agent-window.ts).
  openAgentTab: () => agentWindow.openTab(),
  closeTab: (tabId) => chrome.tabs.remove(tabId),
  tabUrl: async (tabId) => {
    try {
      const tab = await chrome.tabs.get(tabId);
      // A load in progress counts: it is where the tab is going.
      return tab.pendingUrl ?? tab.url ?? null;
    } catch {
      return null;
    }
  },
  setAttention: (asking) => {
    void chrome.action.setBadgeBackgroundColor({ color: '#6657f4' });
    void chrome.action.setBadgeText({ text: asking ? '1' : '' });
  },
};

const relay = new ExtensionRelay({
  browser,
  version: chrome.runtime.getManifest().version,
  onChange: () => {
    // Tells an open popup to refresh; nobody listening is fine.
    chrome.runtime.sendMessage({ name: statusChanged }).catch(() => undefined);
  },
});

// --- The native host ---------------------------------------------------------------

/** Reading `lastError` marks it handled (no console warning); its text is not logged. */
function readLastError(): boolean {
  return chrome.runtime.lastError !== undefined;
}

let port: chrome.runtime.Port | null = null;
let retryMs = 1000;
let retry: ReturnType<typeof setTimeout> | null = null;
const maxRetryMs = 60_000;

function connect(): void {
  if (port !== null) return;
  if (retry !== null) clearTimeout(retry);
  retry = null;
  const opened = chrome.runtime.connectNative(nativeHostName);
  port = opened;
  opened.onMessage.addListener((message: unknown) => {
    retryMs = 1000;
    relay.receive(message);
  });
  opened.onDisconnect.addListener(() => {
    readLastError();
    if (port !== opened) return;
    port = null;
    relay.disconnect();
    retry = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, maxRetryMs);
  });
  relay.connect((frame) => {
    if (port === opened) opened.postMessage(frame);
  });
}

// --- Chrome's events -----------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  // Tab-level events only: Veyquo attaches no child sessions.
  if (source.tabId !== undefined && source.sessionId === undefined) {
    void relay.debuggerEvent(source.tabId, method, params);
  }
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== undefined) relay.debuggerDetached(source.tabId, reason);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  relay.tabRemoved(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined) void relay.tabNavigated(tabId, change.url);
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// --- The popup -----------------------------------------------------------------------

const popupUrl = chrome.runtime.getURL('popup.html');

/** The active tab of the browser window the person last used: the popup's own window. */
async function activeTab(): Promise<ActiveTab | null> {
  try {
    const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
    const tab = window.tabs?.find((t) => t.active);
    if (tab?.id === undefined) return null;
    return { id: tab.id, url: tab.url ?? '' };
  } catch {
    return null;
  }
}

async function answer(message: PopupMessage): Promise<PopupStatus> {
  connect();
  const tab = await activeTab();
  switch (message.name) {
    case 'status':
      break;
    case 'grant':
      if (tab !== null) relay.grant(tab);
      break;
    case 'revoke':
      if (tab !== null) await relay.revoke(tab.id);
      break;
    case 'decline':
      relay.decline();
      break;
    case 'take_over':
    case 'hand_back':
      relay.takeover(message.name);
      break;
  }
  return relay.status(tab);
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
  // Only the extension's own popup page; no content script or other page can ask.
  if (sender.id !== chrome.runtime.id || sender.url?.split('?')[0] !== popupUrl) return false;
  const message = parsePopupMessage(raw);
  if (message === null) return false;
  void answer(message).then(respond, () => {
    respond(relay.status(null));
  });
  return true; // answered asynchronously
});

connect();
