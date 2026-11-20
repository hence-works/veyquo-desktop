import { readFile, rm } from 'node:fs/promises';

import type { DeviceProxy } from '@veyquo/device-protocol';
import { WebSocketTransport } from '@veyquo/local-executor';
import { launchSunBrowserInProcess } from 'adspower-browser-cli';

import { ChromeUnavailableError, namesProfile, type Processes } from '../chrome/launch.ts';
import { cdpWebSocket } from '../chrome/websocket.ts';
import { writeFileDurably } from '../durable-file.ts';

export interface SunBrowserLauncherDeps {
  profileDir: string;
  pidFile: string;
  processes: Processes;
  sleep: (ms: number) => Promise<void>;
}

export interface StartedSunBrowser {
  pid: number;
  transport: WebSocketTransport;
  version: string;
}

function proxyUrl(proxy: DeviceProxy | null): string | undefined {
  if (proxy === null) return undefined;
  const url = new URL(proxy.endpoint);
  if (proxy.username !== null && proxy.password !== null) {
    url.username = proxy.username;
    url.password = proxy.password;
  }
  return url.toString();
}

const exitPolls = 30;
const exitPollMs = 100;

export class SunBrowserLauncher {
  private readonly deps: SunBrowserLauncherDeps;

  constructor(deps: SunBrowserLauncherDeps) {
    this.deps = deps;
  }

  async start(proxy: DeviceProxy | null): Promise<StartedSunBrowser> {
    await this.terminateStale();
    try {
      const launched = await launchSunBrowserInProcess({
        profileDir: this.deps.profileDir,
        ...(proxy === null ? {} : { proxyUrl: proxyUrl(proxy) }),
      });
      if (launched.protocol !== 'cdp') {
        this.deps.processes.kill(launched.pid, 'SIGTERM');
        throw new Error('SunBrowser returned a non-CDP endpoint');
      }
      const transport = await WebSocketTransport.connect(
        launched.webSocketDebuggerUrl,
        cdpWebSocket,
      );
      await writeFileDurably(this.deps.pidFile, `${String(launched.pid)}\n`);
      transport.on('Transport.closed', () => {
        void rm(this.deps.pidFile, { force: true });
      });
      return { pid: launched.pid, transport, version: launched.browser };
    } catch (error) {
      if (error instanceof ChromeUnavailableError) throw error;
      throw new ChromeUnavailableError('failed_to_start', 'SunBrowser did not start.');
    }
  }

  async stop(pid: number): Promise<void> {
    if (this.deps.processes.isAlive(pid)) {
      this.deps.processes.kill(pid, 'SIGTERM');
      if (!(await this.exited(pid))) this.deps.processes.kill(pid, 'SIGKILL');
    }
    await rm(this.deps.pidFile, { force: true });
  }

  async terminateStale(): Promise<void> {
    let pid: number;
    try {
      pid = Number((await readFile(this.deps.pidFile, 'utf8')).trim());
    } catch {
      return;
    }
    if (Number.isSafeInteger(pid) && pid > 1 && this.deps.processes.isAlive(pid)) {
      const command = await this.deps.processes.commandLine(pid);
      if (command !== null && namesProfile(command, this.deps.profileDir)) await this.stop(pid);
    }
    await rm(this.deps.pidFile, { force: true });
  }

  private async exited(pid: number): Promise<boolean> {
    for (let i = 0; i < exitPolls; i += 1) {
      if (!this.deps.processes.isAlive(pid)) return true;
      await this.deps.sleep(exitPollMs);
    }
    return !this.deps.processes.isAlive(pid);
  }
}
