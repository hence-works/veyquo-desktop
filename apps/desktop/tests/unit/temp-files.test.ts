import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppTempFiles } from '../../src/main/temp-files.ts';

const session = '11111111-2222-4333-8444-555555555555';
let root: string;
beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'veyquo-temp-')), 'tmp');
});
afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('AppTempFiles', () => {
  it('sweeps every leftover on start', async () => {
    await mkdir(join(root, session), { recursive: true });
    await writeFile(join(root, session, 'resume.pdf'), 'pdf');
    await new AppTempFiles(root).sweep();
    expect(await readdir(root)).toEqual([]);
  });

  it('gives a session a private folder and deletes it on release', async () => {
    const files = new AppTempFiles(root);
    const dir = await files.forSession(session);
    expect(dir).toBe(join(root, session));
    if (process.platform !== 'win32') expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await writeFile(join(dir, 'cover-letter.pdf'), 'pdf');
    await files.release(session);
    expect(await readdir(root)).toEqual([]);
  });

  it('never takes a path for a session id', async () => {
    const files = new AppTempFiles(root);
    await expect(files.forSession('../../etc')).rejects.toThrow(/UUID/u);
    await expect(files.release('../..')).resolves.toBeUndefined();
  });
});
