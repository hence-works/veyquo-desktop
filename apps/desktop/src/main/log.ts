// The app's log: JSON lines under `userData/logs`, ids only (global constraints). Field
// values are ids, counts, op names and error types; every string goes through `redact`.
// The file is replaced by a fresh one past 5 MB, keeping one previous file.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { redact, redactError } from './redact.ts';

export type LogValue = string | number | boolean | null;
export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: Record<string, LogValue>): void;
  warn(event: string, fields?: Record<string, LogValue>): void;
  error(event: string, error: unknown, fields?: Record<string, LogValue>): void;
}

const maxBytes = 5 * 1024 * 1024;

export function logLine(
  level: LogLevel,
  event: string,
  fields: Record<string, LogValue>,
  options: { home?: string; now?: () => Date } = {},
): string {
  const clean: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    clean[key] = typeof value === 'string' ? redact(value, options) : value;
  }
  const at = (options.now?.() ?? new Date()).toISOString();
  return `${JSON.stringify({ at, level, event: redact(event), ...clean })}\n`;
}

export interface FileLogger extends Logger {
  /** Stops writing: after "Remove Veyquo from this computer", nothing is recreated. */
  silence(): void;
}

/** A logger writing to `dir/desktop.log` (and to stderr while developing). */
export function fileLogger(dir: string, options: { echo?: boolean } = {}): FileLogger {
  const home = homedir();
  let silenced = false;
  if (options.echo === true) {
    // A closed terminal must not turn every later log line into an uncaught EPIPE.
    process.stderr.on('error', () => undefined);
  }
  const file = join(dir, 'desktop.log');
  const write = (line: string): void => {
    if (silenced) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      } catch {
        // No log file yet: nothing to rotate.
      }
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // A full or read-only disk must not take the app down with it.
    }
    if (options.echo === true) process.stderr.write(line);
  };
  return {
    silence: () => {
      silenced = true;
    },
    info: (event, fields = {}) => {
      write(logLine('info', event, fields, { home }));
    },
    warn: (event, fields = {}) => {
      write(logLine('warn', event, fields, { home }));
    },
    error: (event, error, fields = {}) => {
      const { name, message } = redactError(error, { home });
      write(logLine('error', event, { ...fields, error: name, message }, { home }));
    },
  };
}

/** For tests and code paths with nowhere to write. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
