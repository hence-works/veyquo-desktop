import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DurableJournal, journalMaxAgeMs } from '../../src/main/journal.ts';

const deviceId = '6f1c2b8e-0d5a-4c33-9d0e-2a1b3c4d5e6f';
const appId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const grant = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'veyquo-journal-'));
  path = join(dir, 'journal.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function lines(): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0);
}

describe('DurableJournal', () => {
  it('survives crash between received and clicked', async () => {
    const journal = await DurableJournal.create(path, { deviceId });
    await journal.record({
      grant_id: grant(1).toUpperCase(),
      application_id: appId.toUpperCase(),
      state: 'received',
      signals_after: null,
    });
    // The process dies here: nothing is closed or flushed beyond what `record` did.

    const reopened = await DurableJournal.open(path, { deviceId });
    expect(await reopened.check()).toEqual({ ok: true });
    expect(reopened.journalId).toBe(journal.journalId);
    expect(await reopened.unacknowledged()).toEqual([
      { grant_id: grant(1), application_id: appId, state: 'received', signals_after: null },
    ]);
    expect(await reopened.has(grant(1).toUpperCase())).toBe(true);
  });

  it('compacts on ack', async () => {
    const journal = await DurableJournal.create(path, { deviceId });
    for (const n of [1, 2, 3]) {
      await journal.record({
        grant_id: grant(n),
        application_id: appId,
        state: 'received',
        signals_after: null,
      });
      await journal.record({
        grant_id: grant(n),
        application_id: appId,
        state: 'clicked',
        signals_after: null,
      });
    }
    expect(await lines()).toHaveLength(7);

    await journal.acknowledge([grant(1), grant(2).toUpperCase()]);
    // Rewritten: the header, the one live entry and the used ids, not the whole history.
    const compacted = await lines();
    expect(compacted.length).toBeLessThan(7);
    expect(compacted.join('\n')).not.toContain('"state":"received"');

    const reopened = await DurableJournal.open(path, { deviceId });
    expect((await reopened.unacknowledged()).map((e) => e.grant_id)).toEqual([grant(3)]);
    // An acknowledged grant was still used: a replay of it is refused.
    expect(await reopened.has(grant(1))).toBe(true);
    expect(await reopened.has(grant(2))).toBe(true);
    expect(reopened.journalId).toBe(journal.journalId);
  });

  it('a new journal has a fresh random id and is durable, directory included', async () => {
    const syncDir = vi.fn(() => Promise.resolve());
    const first = await DurableJournal.create(path, { deviceId, syncDir });
    const second = await DurableJournal.create(path, { deviceId, syncDir });
    expect(first.journalId).toMatch(uuidPattern);
    expect(second.journalId).not.toBe(first.journalId);
    expect(syncDir).toHaveBeenCalledWith(dir);
    expect(await second.unacknowledged()).toEqual([]);
  });

  it('record resolves only after the line is on disk', async () => {
    const journal = await DurableJournal.create(path, { deviceId });
    await journal.record({
      grant_id: grant(1),
      application_id: appId,
      state: 'received',
      signals_after: null,
    });
    expect((await lines()).at(-1)).toContain(grant(1));
  });

  it('a later received never replaces clicked', async () => {
    const journal = await DurableJournal.create(path, { deviceId });
    const entry = { grant_id: grant(1), application_id: appId, signals_after: null };
    await journal.record({ ...entry, state: 'clicked' });
    await journal.record({ ...entry, state: 'received' });
    const reopened = await DurableJournal.open(path, { deviceId });
    expect((await reopened.unacknowledged()).map((e) => e.state)).toEqual(['clicked']);
  });

  it('keeps takeovers per (application, session) across restarts, lowercased', async () => {
    const session = '11111111-2222-4333-8444-555555555555';
    const journal = await DurableJournal.create(path, { deviceId });
    await journal.markTakenOver(appId.toUpperCase(), session.toUpperCase());
    const reopened = await DurableJournal.open(path, { deviceId });
    expect(await reopened.wasTakenOver(appId, session)).toBe(true);
    expect(await reopened.wasTakenOver(appId, '99999999-2222-4333-8444-555555555555')).toBe(false);
  });

  it.each([
    { case: 'missing', setup: () => Promise.resolve(), reason: 'missing' },
    { case: 'not JSON', setup: () => writeFile(path, 'garbage\n{}\n'), reason: 'corrupt' },
    {
      case: 'without a journal id',
      setup: () => writeFile(path, '{"device_id":"x"}\n'),
      reason: 'corrupt',
    },
    {
      case: 'a broken line in the middle',
      setup: async () => {
        const journal = await DurableJournal.create(path, { deviceId });
        await journal.markTakenOver(appId, appId);
        await appendFile(path, '{"record":\n');
        await journal.markTakenOver(appId, appId);
      },
      reason: 'corrupt',
    },
    {
      case: "another device's",
      setup: async () => {
        await DurableJournal.create(path, { deviceId: appId });
      },
      reason: 'corrupt',
    },
  ])('a journal that is $case cannot be used', async ({ setup, reason }) => {
    await setup();
    const journal = await DurableJournal.open(path, { deviceId });
    expect(await journal.check()).toEqual({ ok: false, reason });
    await expect(
      journal.record({
        grant_id: grant(1),
        application_id: appId,
        state: 'received',
        signals_after: null,
      }),
    ).rejects.toThrow(/journal/u);
  });

  it('a line torn by a crash mid-write is dropped: its write never resolved', async () => {
    const journal = await DurableJournal.create(path, { deviceId });
    await journal.record({
      grant_id: grant(1),
      application_id: appId,
      state: 'received',
      signals_after: null,
    });
    await appendFile(path, '{"record":{"grant_id":"0000');
    const reopened = await DurableJournal.open(path, { deviceId });
    expect(await reopened.check()).toEqual({ ok: true });
    expect(await reopened.unacknowledged()).toHaveLength(1);
    await reopened.record({
      grant_id: grant(2),
      application_id: appId,
      state: 'received',
      signals_after: null,
    });
    const again = await DurableJournal.open(path, { deviceId });
    expect(await again.unacknowledged()).toHaveLength(2);
  });

  it('a journal holding entries never acknowledged for 30 days starts afresh, used ids kept', async () => {
    let now = Date.UTC(2026, 0, 1);
    const syncDir = vi.fn(() => Promise.resolve());
    const journal = await DurableJournal.create(path, { deviceId, now: () => now });
    await journal.record({
      grant_id: grant(1),
      application_id: appId,
      state: 'clicked',
      signals_after: null,
    });
    now += journalMaxAgeMs + 1;
    const rotated = await DurableJournal.open(path, { deviceId, now: () => now, syncDir });
    expect(await rotated.check()).toEqual({ ok: true });
    expect(rotated.journalId).not.toBe(journal.journalId);
    expect(rotated.journalId).toMatch(uuidPattern);
    expect(await rotated.unacknowledged()).toEqual([]);
    expect(await rotated.has(grant(1))).toBe(true);
    expect(syncDir).toHaveBeenCalledWith(dir);
  });

  it('a full journal (256 unacknowledged) starts afresh on the next start', async () => {
    const journal = await DurableJournal.create(path, { deviceId });
    for (let n = 1; n <= 256; n += 1) {
      await journal.record({
        grant_id: grant(n),
        application_id: appId,
        state: 'received',
        signals_after: null,
      });
    }
    const rotated = await DurableJournal.open(path, { deviceId });
    expect(rotated.journalId).not.toBe(journal.journalId);
    expect(await rotated.unacknowledged()).toEqual([]);
    expect(await rotated.has(grant(200))).toBe(true);
  });
});
