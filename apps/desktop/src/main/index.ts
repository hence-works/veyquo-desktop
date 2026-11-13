// The Veyquo desktop app's main process (desktop plan §4.2): one instance per user, a tray
// or menu-bar icon, the status window, and the `DeviceController` that pairs this computer,
// holds its connection and runs the agent's work in the person's Chrome.
//
// Development and test switches (ignored in packaged builds unless noted):
//   VEYQUO_DESKTOP_USER_DATA=<dir>      keep app state in <dir>
//   VEYQUO_DESKTOP_INSECURE_KEYSTORE=1  Linux only: accept safeStorage's plain-text fallback
//   VEYQUO_DESKTOP_AUTOSTART=1          register autostart from an unpackaged run too
//   VEYQUO_CHROME_PATH=<path>           use this Chrome (still version-checked; packaged too)
//   --hidden                            start in the tray without the window (autostart)
//
// `--smoke` (packaged too): find Chrome, load the executor, print one JSON line and exit
// (0 ok, 3 Chrome unavailable, 1 anything else; `smoke.ts`). CI runs it on each packaged
// build. Like `--native-host` it is decided before the single-instance lock, so it runs
// beside an app that is already open, and it touches no app state.
//
// `--native-host` (packaged too): Chrome started this binary as the Veyquo extension's
// native-messaging host (`native-host/register.ts` wrote the launcher). It relays stdin and
// stdout to the running app's IPC endpoint and exits with stdin. It is decided before the
// single-instance lock and before any window, tray or IPC is set up, runs from the asar like
// the app (no ELECTRON_RUN_AS_NODE, no loose script), writes nothing but frames to stdout
// and logs nothing.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import { app, dialog, ipcMain, powerMonitor, safeStorage, screen, session, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DeviceProxy } from '@veyquo/device-protocol';
import { CdpTabHost, LocalExecutor } from '@veyquo/local-executor';
import { PipeTransport } from '@veyquo/local-executor/pipe';
import { WebSocket } from 'ws';

import { DevicesApi } from './api.ts';
import { AccessSession } from './access-session.ts';
import { AgentOverlay } from './agent-overlay.ts';
import { createAutostart } from './autostart.ts';
import { builtInUrls } from './build-urls.ts';
import { ChromeLauncher } from './chrome/launch.ts';
import { locateChrome } from './chrome/locate.ts';
import { runProgram, systemProcesses } from './chrome/processes.ts';
import { isOwnPage, parseCommand } from './commands.ts';
import { loadConfig } from './config.ts';
import { DeviceController, type ChromeContext, type Confirmation } from './controller.ts';
import { confirmations, information } from './dialogs.ts';
import type { RunningChrome } from './executor-host.ts';
import { Keystore } from './keystore.ts';
import { fileLogger, type FileLogger, type Logger } from './log.ts';
import { ExtensionHub, everydayChrome } from './native-host/extension-transport.ts';
import { exitCode, runNativeHost } from './native-host/host.ts';
import {
  hostCommand,
  registerNativeHost,
  registrationFailure,
  systemRegistry,
  unregisterNativeHost,
} from './native-host/register.ts';
import {
  createIpcKey,
  nativeEndpoint,
  startNativeIpc,
  type NativeIpcServer,
} from './native-ipc.ts';
import { appPaths } from './paths.ts';
import { checkExecutor, runSmoke } from './smoke.ts';
import { windowPlacement } from './placement.ts';
import { AppTray } from './tray.ts';
import type { TrayAction } from './tray-menu.ts';
import { checkForUpdates } from './updater.ts';
import {
  createAgentOverlayWindow,
  createStatusWindow,
  lockDownWebContents,
  statusPageUrl,
} from './window.ts';
import { ipcChannels, type UiCommand, type UiState } from '../shared/ui-state.ts';

const buildDir = __dirname;
const env = process.env;
const packaged = app.isPackaged;
const startHidden = process.argv.includes('--hidden');
const nativeHostMode = process.argv.includes('--native-host');
const smokeMode = process.argv.includes('--smoke');

app.setName('Veyquo');
const userDataOverride = env.VEYQUO_DESKTOP_USER_DATA;
app.setPath(
  'userData',
  !packaged && userDataOverride !== undefined && userDataOverride.length > 0
    ? userDataOverride
    : join(app.getPath('appData'), 'Veyquo'),
);
// Every renderer is sandboxed, before anything is created.
app.enableSandbox();
// Linux development and CI only: no keyring under Xvfb, so the key may be kept with
// safeStorage's plain-text backend when explicitly asked (never in a packaged build).
const insecureKeystore =
  !packaged && process.platform === 'linux' && env.VEYQUO_DESKTOP_INSECURE_KEYSTORE === '1';
if (insecureKeystore) app.commandLine.appendSwitch('password-store', 'basic');

function deviceOs(platform: NodeJS.Platform): 'macos' | 'windows' | 'linux' {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}
const osName = deviceOs(process.platform);

function exists(path: string): Promise<boolean> {
  return Promise.resolve(existsSync(path));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function endpointFor(userData: string): string {
  return nativeEndpoint({ platform: process.platform, userData, username: userInfo().username });
}

function chromeLocator(): () => ReturnType<typeof locateChrome> {
  return () =>
    locateChrome({
      platform: process.platform,
      env,
      home: homedir(),
      exists,
      run: runProgram,
      listDir: (path) => readdir(path),
    });
}

/** `--smoke`: the packaged-app check (see `smoke.ts`). */
function runAsSmoke(): void {
  if (process.platform === 'darwin') app.dock?.hide();
  let output = '';
  void runSmoke({
    locate: chromeLocator(),
    checkExecutor,
    write: (line) => {
      output += line;
    },
    packaged,
    buildUrls: builtInUrls() !== null,
  }).then((code) => {
    // Exit once the line is out: a pipe's writes are asynchronous on Windows.
    process.stdout.write(output, () => {
      app.exit(code);
    });
  });
}

/** `--native-host`: relay Chrome's stdin/stdout to the running app, then exit. */
function runAsNativeHost(): void {
  if (process.platform === 'darwin') app.dock?.hide();
  const paths = appPaths(app.getPath('userData'));
  runNativeHost({
    stdin: process.stdin,
    stdout: process.stdout,
    connect: () => connect(endpointFor(paths.userData)),
    readKey: () => readFile(paths.nativeKey, 'utf8'),
  }).then(
    (exit) => {
      app.exit(exitCode(exit));
    },
    () => {
      app.exit(1);
    },
  );
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();

  const paths = appPaths(app.getPath('userData'));
  await mkdir(paths.userData, { recursive: true });
  if (process.platform !== 'win32') await chmod(paths.userData, 0o700);
  const log: FileLogger = fileLogger(paths.logs, { echo: !packaged });
  installCrashHandlers(log);
  log.info('app.start', { version: app.getVersion(), os: osName, packaged });

  if (insecureKeystore) safeStorage.setUsePlainTextEncryption(true);
  const config = await loadConfig(paths.config, env, { packaged, defaults: builtInUrls() });
  let controllerRef: DeviceController | null = null;
  const access = new AccessSession({
    apiUrl: config.apiUrl,
    file: paths.accessSession,
    storage: safeStorage,
    platform: process.platform,
    openExternal: (url) => shell.openExternal(url),
    onState: (state) => controllerRef?.setAccessState(state),
  });
  const api = new DevicesApi(config.apiUrl, access.fetch);
  lockDownWebContents();

  const primaryBounds = screen.getPrimaryDisplay().bounds;
  const agentOverlay = new AgentOverlay({
    window: createAgentOverlayWindow({ buildDir, bounds: primaryBounds }),
    primaryDisplay: () => screen.getPrimaryDisplay(),
    displayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
  });

  const processes = systemProcesses(process.platform);
  const locate = chromeLocator();
  const launcher = new ChromeLauncher({
    locate,
    userDataDir: paths.chromeProfile,
    pidFile: paths.chromePid,
    processes,
    launch: async (options) => {
      const transport = await PipeTransport.launch(options);
      return { pid: transport.pid, transport };
    },
    sleep,
  });
  const startChrome = async (
    context: ChromeContext,
    proxy: DeviceProxy | null,
  ): Promise<RunningChrome> => {
    const started = await launcher.start(
      proxy === null ? [] : [`--proxy-server=${proxy.endpoint}`],
    );
    const transport = started.transport;
    const tabs = new CdpTabHost(transport, { placement: windowPlacement(screen) });
    const executor = new LocalExecutor({
      transport,
      tabs,
      journal: context.journal,
      grantKeys: context.grantKeys,
      tempFiles: context.tempFiles,
      emit: context.emit,
      agentVisual: agentOverlay,
    });
    log.info('chrome.started', { version: started.version });
    return {
      executor,
      tabs,
      onClosed: (listener) => {
        transport.on('Transport.closed', listener);
      },
      stop: async () => {
        await executor.shutdown();
        await transport.close();
      },
    };
  };

  // The Veyquo extension in the person's everyday Chrome, once its native host connects.
  const extensions = new ExtensionHub({
    browserSettingsUrl: `${config.webUrl}/app/settings/browser`,
    onTakeover: (action) => {
      void (action === 'take_over' ? controllerRef?.takeOver() : controllerRef?.handBack());
    },
    onConnected: (connected) => {
      log.info('extension.connection', { connected });
      controllerRef?.setExtensionConnected(connected);
    },
  });
  const startEveryday = (context: ChromeContext): RunningChrome | null => {
    const current = extensions.current;
    return current === null ? null : everydayChrome(current, context);
  };
  // Chrome finds the host through this registration; it is rewritten on every start.
  const hostRegistration = {
    platform: process.platform,
    home: homedir(),
    userData: paths.userData,
    registry: systemRegistry,
  };
  await registerNativeHost({
    ...hostRegistration,
    command: hostCommand({
      packaged,
      platform: process.platform,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userData: paths.userData,
      ...(env.APPIMAGE === undefined ? {} : { appImage: env.APPIMAGE }),
      noSandbox: process.argv.includes('--no-sandbox'),
    }),
    ...(packaged ? {} : { env: { VEYQUO_DESKTOP_USER_DATA: paths.userData } }),
  }).catch((error: unknown) => {
    log.warn('native_host.register_failed', registrationFailure(error));
  });

  let window: BrowserWindow | null = null;
  const showWindow = (): void => {
    if (window === null) {
      const created = createStatusWindow({ buildDir, show: true });
      created.on('closed', () => {
        window = null;
      });
      window = created;
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const confirm = async (question: Confirmation): Promise<boolean> => {
    const copy = confirmations[question];
    const options = {
      type: 'warning' as const,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.confirm, copy.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const parent = window?.isVisible() === true ? window : null;
    const answer =
      parent === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(parent, options);
    return answer.response === 0;
  };

  const inform = async (message: 'removed_locally'): Promise<void> => {
    const copy = information[message];
    await dialog.showMessageBox({
      type: 'info',
      message: copy.message,
      detail: copy.detail,
      buttons: ['OK'],
      noLink: true,
    });
  };

  let cleanedUp = false;
  let nativeIpc: NativeIpcServer | null = null;
  let tray: AppTray | null = null;

  const pushState = (state: UiState): void => {
    agentOverlay.activity(state.activity);
    extensions.setActivity(
      state.activity.kind === 'idle'
        ? 'idle'
        : state.activity.takenOver
          ? 'taken_over'
          : 'applying',
    );
    tray?.update(state);
    if (window !== null && !window.isDestroyed()) window.webContents.send(ipcChannels.state, state);
  };

  const autostart = createAutostart({
    platform: process.platform,
    home: homedir(),
    execPath: process.execPath,
    ...(env.APPIMAGE === undefined ? {} : { appImage: env.APPIMAGE }),
    loginItems: app,
  });

  const controller = new DeviceController({
    paths,
    access,
    appVersion: app.getVersion(),
    os: osName,
    deviceName: hostname(),
    keystore: new Keystore({
      dir: paths.userData,
      storage: safeStorage,
      platform: process.platform,
      allowPlainTextLinux: insecureKeystore,
    }),
    api,
    locateChrome: locate,
    startChrome,
    startEveryday,
    unregisterNativeHost: () => unregisterNativeHost(hostRegistration),
    stopStaleChrome: () => launcher.terminateStale(),
    openSocket: (url, protocols) => {
      const socket = new WebSocket(url, protocols, {
        headers: access.socketHeaders(url),
        maxPayload: 64 * 1024 * 1024,
        handshakeTimeout: 15_000,
      });
      socket.on('unexpected-response', (_request, response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(key, value);
        }
        if (
          access.isChallenge(new Response(null, { status: response.statusCode ?? 502, headers }))
        ) {
          void access.required().catch(() => undefined);
        }
        response.resume();
        socket.terminate();
      });
      return socket;
    },
    openEgressSocket: (url, protocols) =>
      new WebSocket(url, protocols, {
        headers: access.socketHeaders(url),
        maxPayload: 64 * 1024 + 9,
        handshakeTimeout: 15_000,
      }),
    power: powerMonitor,
    openExternal: (url) => shell.openExternal(url),
    confirm,
    inform,
    autostart,
    registerAutostart: packaged || env.VEYQUO_DESKTOP_AUTOSTART === '1',
    onState: pushState,
    quit: () => {
      app.quit();
    },
    onRemoved: () => {
      log.silence();
      // The status page's own Chromium storage holds nothing private; cleared all the same.
      void session.defaultSession.clearStorageData().catch(() => undefined);
      void session.defaultSession.clearCache().catch(() => undefined);
    },
    log,
  });
  controllerRef = controller;

  const run = async (command: UiCommand): Promise<void> => {
    switch (command.name) {
      case 'access_sign_in':
        await controller.signInAccess();
        return;
      case 'access_cancel':
        controller.cancelAccess();
        return;
      case 'access_sign_out':
        await controller.signOutAccess();
        return;
      case 'pair':
        await controller.pair();
        return;
      case 'cancel_pairing':
        controller.cancelPairing();
        return;
      case 'take_over':
        await controller.takeOver();
        return;
      case 'hand_back':
        await controller.handBack();
        return;
      case 'set_visibility':
        await controller.setVisibility(command.visibility);
        return;
      case 'set_browser_mode':
        await controller.setBrowserMode(command.viewId, command.mode);
        return;
      case 'set_paused':
        await controller.setPaused(command.paused);
        return;
      case 'set_egress_enabled':
        await controller.setEgressEnabled(command.enabled);
        return;
      case 'stop_egress':
        controller.stopEgress();
        return;
      case 'remove':
        await controller.remove();
        return;
      default: {
        const unreachable: never = command;
        return unreachable;
      }
    }
  };

  const pageUrl = statusPageUrl(buildDir);
  ipcMain.handle(ipcChannels.getState, (event) => {
    if (!isOwnPage(event.senderFrame?.url, pageUrl)) throw new Error('not the status page');
    return controller.uiState;
  });
  ipcMain.handle(ipcChannels.command, async (event, raw: unknown) => {
    if (!isOwnPage(event.senderFrame?.url, pageUrl)) throw new Error('not the status page');
    const command = parseCommand(raw);
    if (command === null) throw new Error('not a command');
    // Pairing waits for the person; the window is told through state, not this call.
    void run(command).catch((error: unknown) => {
      log.error('command.failed', error, { command: command.name });
    });
    return Promise.resolve();
  });

  const onTray = (action: TrayAction, checked: boolean): void => {
    switch (action) {
      case 'open':
        showWindow();
        return;
      case 'take_over':
        void run({ name: 'take_over' });
        return;
      case 'hand_back':
        void run({ name: 'hand_back' });
        return;
      case 'pause':
        void run({ name: 'set_paused', paused: checked });
        return;
      case 'remove':
        void run({ name: 'remove' });
        return;
      case 'quit':
        app.quit();
        return;
      default: {
        const unreachable: never = action;
        return unreachable;
      }
    }
  };
  tray = new AppTray(buildDir, onTray);
  tray.update(controller.uiState);

  app.on('second-instance', () => {
    showWindow();
  });
  app.on('activate', () => {
    showWindow();
  });
  // A tray app: closing the window keeps it running.
  app.on('window-all-closed', () => {
    // Stay in the tray.
  });
  // Once, whatever asked to quit: close the connection, Chrome and the IPC endpoint.
  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    void (async () => {
      controller.shutdown();
      await controller.stopChrome().catch(() => undefined);
      extensions.close();
      await nativeIpc?.close().catch(() => undefined);
      tray.destroy();
      agentOverlay.close();
      log.info('app.quit');
      cleanedUp = true;
      app.exit(0);
    })();
  });

  if (!startHidden) showWindow();

  try {
    nativeIpc = await startNativeIpc(
      endpointFor(paths.userData),
      (connection) => {
        extensions.accept(connection);
      },
      { key: await createIpcKey(paths.nativeKey) },
    );
  } catch (error) {
    // Someone else may hold the endpoint's name (Windows pipe squatting): the everyday
    // profile stays off, and the person is told (Task 10 carry 2).
    log.error('native_ipc.start_failed', error);
    controller.nativeIpcFailed();
  }
  await controller.start();
  await checkForUpdates({ packaged, log });
}

/** Ids only: a crash records the error's class and redacted message, and never uploads. */
function installCrashHandlers(log: Logger): void {
  process.on('uncaughtException', (error) => {
    log.error('crash.uncaught_exception', error);
    app.exit(70);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('crash.unhandled_rejection', reason);
  });
  app.on('render-process-gone', (_event, _contents, details) => {
    log.warn('crash.renderer_gone', { reason: details.reason, exit_code: details.exitCode });
  });
  app.on('child-process-gone', (_event, details) => {
    log.warn('crash.child_gone', { type: details.type, reason: details.reason });
  });
}

if (smokeMode) {
  runAsSmoke();
} else if (nativeHostMode) {
  runAsNativeHost();
} else {
  main().catch((error: unknown) => {
    fileLogger(join(app.getPath('userData'), 'logs')).error('app.start_failed', error);
    app.exit(1);
  });
}
