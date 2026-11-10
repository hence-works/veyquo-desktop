// The operating system's view of a process, for terminating a Chrome an earlier run of the
// app left behind (`launch.ts`). Command lines are only compared against the profile path,
// never logged: they can carry URLs.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import type { Processes } from './launch.ts';

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`${file} exited with ${String(error.code ?? 'an error')}`));
    });
  });
}

export function systemProcesses(platform: NodeJS.Platform): Processes {
  return {
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // ESRCH: gone. EPERM: another user's process, so not the Chrome this app started.
        return false;
      }
    },
    async commandLine(pid) {
      try {
        if (platform === 'linux') {
          return (await readFile(`/proc/${String(pid)}/cmdline`, 'utf8')).replaceAll('\0', ' ');
        }
        if (platform === 'darwin') {
          return await run('/bin/ps', ['-o', 'command=', '-p', String(pid)]);
        }
        if (platform === 'win32') {
          return await run('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`,
          ]);
        }
      } catch {
        // Unreadable: treated as not ours, so it is never killed.
      }
      return null;
    },
    kill(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    },
  };
}

/** Runs a program for `locateChrome` and resolves with its stdout. */
export const runProgram = run;
