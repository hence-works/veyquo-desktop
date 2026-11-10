// Upload documents on disk (desktop plan §4.1, §7): `userData/tmp/<session>/`, one private
// folder per session, deleted when the session closes or is cancelled (the executor calls
// `release`) and swept when the app starts.

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { TempFiles } from '@veyquo/local-executor';

const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export class AppTempFiles implements TempFiles {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private dir(sessionId: string): string {
    // A session id names a folder: only a lowercase UUID, never a path.
    if (!sessionPattern.test(sessionId)) throw new Error('a session id is a lowercase UUID');
    return join(this.root, sessionId);
  }

  async forSession(sessionId: string): Promise<string> {
    const dir = this.dir(sessionId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async release(sessionId: string): Promise<void> {
    if (!sessionPattern.test(sessionId)) return;
    await rm(this.dir(sessionId), { recursive: true, force: true, maxRetries: 3 });
  }

  async sweep(): Promise<void> {
    await rm(this.root, { recursive: true, force: true, maxRetries: 3 });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
}
