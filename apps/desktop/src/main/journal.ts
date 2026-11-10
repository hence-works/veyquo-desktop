// The device's durable submit journal (desktop plan §6.2, §6.4), implementing
// `@veyquo/local-executor`'s `Journal`. JSON lines in `userData/journal.jsonl`:
//
//   {"journal_id": uuid, "device_id": uuid, "created_at": ms}      the header, always first
//   {"used": [grant ids]}                                          grants acknowledged or retired
//   {"record": JournalEntry, "at": ms}                             one grant's state
//   {"ack": [grant ids], "at": ms}                                 the cloud recorded these
//   {"taken_over": [application id, session id], "at": ms}         a local takeover
//
// Duties (local-executor `journal.ts`, Task 9 carry):
// - Every change is appended and fsynced before its call resolves, so `received` is durable
//   before the submit control is pressed. Creating, compacting and rotating write a new file
//   (fsync, rename) and fsync the directory.
// - An entry stays until `journal_ack` names it; an acknowledgement compacts the file. Its
//   grant id is kept as used, so a replay of that grant is still refused.
// - Each journal file has a random `journal_id`, sent in every hello. A journal whose oldest
//   unacknowledged entry is older than 30 days, or that holds `maxJournal` (256) of them,
//   is replaced on the next start by one with a fresh id: the cloud then infers nothing from
//   the old journal's silence (fail closed). Its grant ids stay used.
// - Takeovers are kept by (application, session); every id is stored lowercase.
// - A missing journal (while the device is paired), an unreadable line, a bad header or
//   another device's journal make `check` fail: the app says no hello under the device's
//   identity and asks the person to pair again. A final line torn by a crash mid-append is
//   dropped: the write never resolved, so nothing was pressed on its strength.

import { readFile, truncate } from 'node:fs/promises';
import type { JournalEntry } from '@veyquo/device-protocol';
import { maxJournal, type Journal, type JournalIntegrity } from '@veyquo/local-executor';

import { appendDurably, syncDirectory, writeFileDurably } from './durable-file.ts';

/** How long an entry may wait for the cloud's acknowledgement before the journal rotates. */
export const journalMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
/** Used grant ids kept to refuse replays; old grants are also stale by capture anyway. */
const maxUsed = 4096;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface Options {
  deviceId: string;
  now?: () => number;
  syncDir?: (dir: string) => Promise<void>;
}

interface Stored {
  entry: JournalEntry;
  at: number;
}

interface State {
  journalId: string;
  createdAt: number;
  entries: Map<string, Stored>;
  used: Set<string>;
  takenOver: Map<string, number>;
}

class CorruptJournalError extends Error {
  constructor(what: string) {
    super(`the journal is unreadable: ${what}`);
    this.name = 'CorruptJournalError';
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CorruptJournalError('a line is not an object');
  }
  return value as Record<string, unknown>;
}

function uuidOf(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value.toLowerCase())) {
    throw new CorruptJournalError('an id is not a UUID');
  }
  return value.toLowerCase();
}

function entryOf(value: unknown): JournalEntry {
  const raw = record(value);
  if (raw.state !== 'received' && raw.state !== 'clicked') {
    throw new CorruptJournalError('an entry has no state');
  }
  const signals = raw.signals_after;
  return {
    grant_id: uuidOf(raw.grant_id),
    application_id: uuidOf(raw.application_id),
    state: raw.state,
    // Written by this app from a validated entry; kept as it was.
    signals_after:
      typeof signals === 'object' && signals !== null
        ? (signals as JournalEntry['signals_after'])
        : null,
  };
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new CorruptJournalError('a list of ids is not a list');
  return value.map(uuidOf);
}

function takeoverKey(applicationId: string, sessionId: string): string {
  return `${applicationId.toLowerCase()}/${sessionId.toLowerCase()}`;
}

function apply(state: State, line: Record<string, unknown>): void {
  const at = typeof line.at === 'number' ? line.at : state.createdAt;
  if ('record' in line) {
    const entry = entryOf(line.record);
    const known = state.entries.get(entry.grant_id);
    if (!(known?.entry.state === 'clicked' && entry.state === 'received')) {
      state.entries.set(entry.grant_id, { entry, at: known?.at ?? at });
    }
  } else if ('ack' in line) {
    for (const id of idsOf(line.ack)) {
      if (state.entries.delete(id)) state.used.add(id);
    }
  } else if ('used' in line) {
    for (const id of idsOf(line.used)) state.used.add(id);
  } else if ('taken_over' in line) {
    const ids = idsOf(line.taken_over);
    if (ids.length !== 2) throw new CorruptJournalError('a takeover is not a pair');
    state.takenOver.set(takeoverKey(ids[0] ?? '', ids[1] ?? ''), at);
  } else {
    throw new CorruptJournalError('a line has no known change');
  }
}

export class DurableJournal implements Journal {
  private state: State;
  private readonly path: string;
  private readonly deviceId: string;
  private readonly now: () => number;
  private readonly syncDir: (dir: string) => Promise<void>;
  private readonly integrity: JournalIntegrity;
  /** One change at a time, in call order. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, options: Options, state: State, integrity: JournalIntegrity) {
    this.path = path;
    this.deviceId = options.deviceId.toLowerCase();
    this.now = options.now ?? Date.now;
    this.syncDir = options.syncDir ?? syncDirectory;
    this.state = state;
    this.integrity = integrity;
  }

  get journalId(): string {
    return this.state.journalId;
  }

  /** A new, empty journal with a fresh id for a newly paired device (replaces any file). */
  static async create(path: string, options: Options): Promise<DurableJournal> {
    const now = (options.now ?? Date.now)();
    const state: State = {
      journalId: crypto.randomUUID(),
      createdAt: now,
      entries: new Map(),
      used: new Set(),
      takenOver: new Map(),
    };
    const journal = new DurableJournal(path, options, state, { ok: true });
    await journal.rewrite();
    return journal;
  }

  /** The paired device's journal. It is never created here: a missing one is unusable. */
  static async open(path: string, options: Options): Promise<DurableJournal> {
    const unusable = (reason: 'missing' | 'corrupt'): DurableJournal =>
      new DurableJournal(
        path,
        options,
        {
          journalId: crypto.randomUUID(), // never said: `check` stops the hello
          createdAt: 0,
          entries: new Map(),
          used: new Set(),
          takenOver: new Map(),
        },
        { ok: false, reason },
      );
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unusable('missing');
      throw error;
    }
    const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    let state: State;
    try {
      state = DurableJournal.parse(complete, options.deviceId.toLowerCase());
    } catch (error) {
      if (error instanceof CorruptJournalError || error instanceof SyntaxError) {
        return unusable('corrupt');
      }
      throw error;
    }
    if (complete.length < text.length) {
      // A torn final line: its append never resolved. Cut it so the next append starts clean.
      await truncate(path, Buffer.byteLength(complete));
    }
    const journal = new DurableJournal(path, options, state, { ok: true });
    await journal.rotateIfStale();
    return journal;
  }

  private static parse(text: string, deviceId: string): State {
    const lines = text.split('\n').filter((line) => line.length > 0);
    const header = record(JSON.parse(lines[0] ?? 'null'));
    const journalId = uuidOf(header.journal_id);
    if (uuidOf(header.device_id) !== deviceId) {
      throw new CorruptJournalError("the journal is another device's");
    }
    const state: State = {
      journalId,
      createdAt: typeof header.created_at === 'number' ? header.created_at : 0,
      entries: new Map(),
      used: new Set(),
      takenOver: new Map(),
    };
    for (const line of lines.slice(1)) apply(state, record(JSON.parse(line)));
    return state;
  }

  private async rotateIfStale(): Promise<void> {
    const entries = [...this.state.entries.values()];
    const oldest = Math.min(...entries.map((stored) => stored.at));
    const full = entries.length >= maxJournal;
    if (!full && !(entries.length > 0 && this.now() - oldest > journalMaxAgeMs)) return;
    for (const id of this.state.entries.keys()) this.state.used.add(id);
    this.state = {
      ...this.state,
      journalId: crypto.randomUUID(),
      createdAt: this.now(),
      entries: new Map(),
    };
    await this.rewrite();
  }

  /** The whole journal as a fresh file: header, used ids, live entries, recent takeovers. */
  private async rewrite(): Promise<void> {
    const cutoff = this.now() - journalMaxAgeMs;
    for (const [key, at] of this.state.takenOver) {
      if (at < cutoff) this.state.takenOver.delete(key);
    }
    const used = [...this.state.used].slice(-maxUsed);
    this.state.used = new Set(used);
    const lines: object[] = [
      {
        journal_id: this.state.journalId,
        device_id: this.deviceId,
        created_at: this.state.createdAt,
      },
    ];
    if (used.length > 0) lines.push({ used });
    for (const { entry, at } of this.state.entries.values()) lines.push({ record: entry, at });
    for (const [key, at] of this.state.takenOver) lines.push({ taken_over: key.split('/'), at });
    const text = lines.map((line) => JSON.stringify(line)).join('\n');
    await writeFileDurably(this.path, `${text}\n`, { syncDir: this.syncDir });
  }

  private change<T>(work: () => Promise<T>): Promise<T> {
    if (!this.integrity.ok) {
      return Promise.reject(new Error(`the device journal is ${this.integrity.reason}`));
    }
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private append(line: object): Promise<void> {
    return appendDurably(this.path, `${JSON.stringify(line)}\n`);
  }

  record(entry: JournalEntry): Promise<void> {
    const lower: JournalEntry = {
      ...entry,
      grant_id: entry.grant_id.toLowerCase(),
      application_id: entry.application_id.toLowerCase(),
    };
    return this.change(async () => {
      const at = this.now();
      await this.append({ record: lower, at });
      apply(this.state, { record: lower, at });
    });
  }

  has(grantId: string): Promise<boolean> {
    const id = grantId.toLowerCase();
    return Promise.resolve(this.state.entries.has(id) || this.state.used.has(id));
  }

  unacknowledged(): Promise<JournalEntry[]> {
    return Promise.resolve(
      [...this.state.entries.values()].sort((a, b) => a.at - b.at).map((stored) => stored.entry),
    );
  }

  acknowledge(grantIds: readonly string[]): Promise<void> {
    const ids = grantIds.map((id) => id.toLowerCase());
    return this.change(async () => {
      if (!ids.some((id) => this.state.entries.has(id))) return;
      apply(this.state, { ack: ids });
      await this.rewrite();
    });
  }

  markTakenOver(applicationId: string, sessionId: string): Promise<void> {
    const pair = [applicationId.toLowerCase(), sessionId.toLowerCase()];
    return this.change(async () => {
      const at = this.now();
      await this.append({ taken_over: pair, at });
      apply(this.state, { taken_over: pair, at });
    });
  }

  wasTakenOver(applicationId: string, sessionId: string): Promise<boolean> {
    return Promise.resolve(this.state.takenOver.has(takeoverKey(applicationId, sessionId)));
  }

  check(): Promise<JournalIntegrity> {
    return Promise.resolve(this.integrity);
  }
}
