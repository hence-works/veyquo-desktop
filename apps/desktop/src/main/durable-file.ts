// Durable writes: the data is fsynced, and so is the directory entry that names it, so a
// power loss right after a write cannot lose the file. Windows cannot open a directory
// for fsync; NTFS journals the metadata itself, so that step is skipped there.

import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** fsyncs a directory, so a file created or renamed in it survives a power loss. */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes `data` to `path` atomically (temporary file, fsync, rename, fsync directory). */
export async function writeFileDurably(
  path: string,
  data: string | Uint8Array,
  options: { syncDir?: (dir: string) => Promise<void> } = {},
): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await (options.syncDir ?? syncDirectory)(dirname(path));
}

/** Appends one line and fsyncs it before resolving. */
export async function appendDurably(path: string, line: string): Promise<void> {
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.write(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
