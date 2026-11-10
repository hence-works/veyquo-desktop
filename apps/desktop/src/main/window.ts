// The status window (desktop plan §4.2): the app's own page, from its own files. Electron's
// security baseline: context isolation on, Node integration off, a sandboxed renderer, a
// minimal typed preload API, no remote content, no navigation, no new windows, no
// permissions, and a strict CSP in the page itself.

import { BrowserWindow, app, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function statusPageUrl(buildDir: string): string {
  return pathToFileURL(join(buildDir, 'renderer', 'index.html')).href;
}

/** Applied once, before any window: every web contents is locked down the same way. */
export function lockDownWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    contents.on('will-redirect', (event) => {
      event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Nothing but the app's own files: the page needs no network at all.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({
      cancel: !details.url.startsWith('file://') && !details.url.startsWith('devtools://'),
    });
  });
}

export function createStatusWindow(options: { buildDir: string; show: boolean }): BrowserWindow {
  const window = new BrowserWindow({
    width: 440,
    height: 680,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Veyquo',
    icon: join(options.buildDir, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: join(options.buildDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.removeMenu();
  window.once('ready-to-show', () => {
    if (options.show) window.show();
  });
  void window.loadURL(statusPageUrl(options.buildDir));
  return window;
}
