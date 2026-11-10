// Launching the Veyquo-profile Chrome (desktop plan §4.3): the person's installed Chrome
// with `--remote-debugging-pipe --user-data-dir=<userData>/chrome-profile --no-first-run
// --no-default-browser-check` (from `chromeArgs`), CDP over fds 3/4 as a `PipeTransport`.
// No TCP port is opened. The PID is kept in `userData/chrome.pid`; a Chrome left running
// by an earlier app process (a crash) is terminated before a new one starts, because two
// cannot share the profile. A recorded PID is only ever killed when that process's command
// line names this profile, so a reused PID never takes down someone else's program.

import { readFile, rm } from 'node:fs/promises';

import type { CdpTransport } from '@veyquo/local-executor';
import type { PipeLaunchOptions } from '@veyquo/local-executor/pipe';

import { writeFileDurably } from '../durable-file.ts';
import type { ChromeLocation } from './locate.ts';

export class ChromeUnavailableError extends Error {
  readonly reason: 'missing' | 'too_old' | 'unknown_version' | 'failed_to_start';

  constructor(reason: ChromeUnavailableError['reason']) {
    const messages = {
      missing: 'Google Chrome is not installed on this computer.',
      too_old: 'Google Chrome needs updating: Veyquo needs version 136 or newer.',
      unknown_version: "Veyquo could not read this Chrome's version.",
      failed_to_start: 'Google Chrome did not start.',
    } as const;
    super(messages[reason]);
    this.name = 'ChromeUnavailableError';
    this.reason = reason;
  }
}

export interface Processes {
  isAlive(pid: number): boolean;
  /** The process's command line, or null when it cannot be read. */
  commandLine(pid: number): Promise<string | null>;
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
}

export interface LaunchedChrome {
  pid: number | undefined;
  transport: CdpTransport;
}

export interface ChromeLauncherDeps {
  locate: () => Promise<ChromeLocation>;
  userDataDir: string;
  pidFile: string;
  processes: Processes;
  launch: (options: PipeLaunchOptions) => Promise<LaunchedChrome>;
  sleep: (ms: number) => Promise<void>;
  headless?: boolean;
  args?: readonly string[];
}

export interface StartedChrome {
  transport: CdpTransport;
  version: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The command line passes exactly this profile: the path ends at a space, a quote or the
 * end of the line, so `chrome-profile-backup` or `chrome-profile2` never match. */
export function namesProfile(command: string, userDataDir: string): boolean {
  return new RegExp(`--user-data-dir=${escapeRegExp(userDataDir)}(?=$|[\\s"'])`, 'u').test(command);
}

const exitPolls = 20;
const exitPollMs = 100;

export class ChromeLauncher {
  private readonly deps: ChromeLauncherDeps;

  constructor(deps: ChromeLauncherDeps) {
    this.deps = deps;
  }

  async start(extraArgs: readonly string[] = []): Promise<StartedChrome> {
    const location = await this.deps.locate();
    if (!location.ok) throw new ChromeUnavailableError(location.reason);
    await this.terminateStale();
    let launched: LaunchedChrome;
    try {
      launched = await this.deps.launch({
        chromePath: location.path,
        userDataDir: this.deps.userDataDir,
        headless: this.deps.headless ?? false,
        args: [...(this.deps.args ?? []), ...extraArgs],
      });
    } catch {
      throw new ChromeUnavailableError('failed_to_start');
    }
    if (launched.pid !== undefined) {
      await writeFileDurably(this.deps.pidFile, `${String(launched.pid)}\n`);
      const pidFile = this.deps.pidFile;
      launched.transport.on('Transport.closed', () => {
        void rm(pidFile, { force: true });
      });
    }
    return { transport: launched.transport, version: location.version };
  }

  /** Ends a Chrome an earlier run of the app left on this profile. */
  async terminateStale(): Promise<void> {
    let pid: number;
    try {
      pid = Number((await readFile(this.deps.pidFile, 'utf8')).trim());
    } catch {
      return; // no PID recorded
    }
    const { processes } = this.deps;
    if (Number.isSafeInteger(pid) && pid > 1 && processes.isAlive(pid)) {
      const command = await processes.commandLine(pid);
      if (command !== null && namesProfile(command, this.deps.userDataDir)) {
        processes.kill(pid, 'SIGTERM');
        if (!(await this.exited(pid))) {
          processes.kill(pid, 'SIGKILL');
          await this.exited(pid);
        }
      }
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
