// Launches the built desktop app (`yarn build`) under Electron with Playwright's `_electron`,
// pointed at a fake gateway, with its state in a temporary folder and a temporary HOME (for
// the Linux autostart entry). Real Chrome: CHROME_PATH, else /usr/bin/google-chrome.
//
// `--no-sandbox` is passed on Linux only: hosts that restrict unprivileged user namespaces
// (Ubuntu 24.04, GitHub runners) cannot start Chromium's OS sandbox without a setuid helper.
// The renderer keeps Electron's `sandbox: true`, context isolation and no Node integration.

import { join } from 'node:path';

import { _electron, type ElectronApplication, type Page } from 'playwright';

export const appDir = join(import.meta.dirname, '..', '..');
export const chromePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const electronDist = join(appDir, '..', '..', 'node_modules', 'electron', 'dist');
export const electronPath =
  process.platform === 'darwin'
    ? join(electronDist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : join(electronDist, process.platform === 'win32' ? 'electron.exe' : 'electron');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
}

export async function launchApp(options: {
  userData: string;
  home: string;
  apiUrl: string;
}): Promise<LaunchedApp> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  Object.assign(env, {
    HOME: options.home,
    VEYQUO_DESKTOP_USER_DATA: options.userData,
    VEYQUO_API_URL: options.apiUrl,
    VEYQUO_WEB_URL: 'http://127.0.0.1:3400',
    VEYQUO_DESKTOP_INSECURE_KEYSTORE: '1',
    VEYQUO_DESKTOP_AUTOSTART: '1',
    VEYQUO_CHROME_PATH: chromePath,
  });
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), appDir],
    env,
    timeout: 30_000,
  });
  // The person's browser and native dialogs are outside the test: record and accept.
  await app.evaluate(({ shell, dialog }) => {
    const opened: string[] = [];
    (globalThis as { openedUrls?: string[] }).openedUrls = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
  });
  await app.firstWindow();
  let page: Page | undefined;
  const deadline = Date.now() + 30_000;
  while (page === undefined && Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if ((await candidate.title()) === 'Veyquo') page = candidate;
    }
    if (page === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (page === undefined) throw new Error('the Veyquo status window did not open');
  return { app, page };
}

export function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls ?? []);
}
