import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FrameDecoder,
  createIpcKey,
  FrameTooLargeError,
  encodeFrame,
  ipcProof,
  maxFrameBytes,
  maxPreAdmissionBytes,
  nativeEndpoint,
  startNativeIpc,
  type IpcFrame,
} from '../../src/main/native-ipc.ts';

const frame: IpcFrame = { id: 'f-1', kind: 'cdp.send', payload: { method: 'Page.enable', é: '✓' } };

describe('native IPC framing', () => {
  it('a frame is a 4-byte little-endian length and UTF-8 JSON', () => {
    const bytes = encodeFrame(frame);
    const body = Buffer.from(JSON.stringify(frame), 'utf8');
    expect(bytes.readUInt32LE(0)).toBe(body.length);
    expect(bytes.subarray(4).equals(body)).toBe(true);
  });

  it('decodes frames split across chunks and several in one chunk', () => {
    const decoder = new FrameDecoder();
    const two = Buffer.concat([encodeFrame(frame), encodeFrame({ ...frame, id: 'f-2' })]);
    const out: IpcFrame[] = [];
    for (let i = 0; i < two.length; i += 3) out.push(...decoder.push(two.subarray(i, i + 3)));
    expect(out.map((f) => f.id)).toEqual(['f-1', 'f-2']);
    expect(out[0]).toEqual(frame);
  });

  it.each([
    { case: 'not JSON', body: 'nope' },
    { case: 'not an object', body: '[1]' },
    { case: 'without an id', body: '{"kind":"x","payload":null}' },
    { case: 'with a non-string kind', body: '{"id":"a","kind":3,"payload":null}' },
    {
      case: 'with an overlong id',
      body: JSON.stringify({ id: 'x'.repeat(200), kind: 'k', payload: 1 }),
    },
  ])('skips a frame $case', ({ body }) => {
    const bytes = Buffer.from(body, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length);
    const decoder = new FrameDecoder();
    expect(decoder.push(Buffer.concat([header, bytes, encodeFrame(frame)]))).toEqual([frame]);
  });

  it('refuses a frame longer than the limit before buffering it', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(maxFrameBytes + 1);
    expect(() => new FrameDecoder().push(header)).toThrow(FrameTooLargeError);
  });

  it('names the endpoint per platform', () => {
    expect(
      nativeEndpoint({ platform: 'linux', userData: '/home/ana/.config/Veyquo', username: 'ana' }),
    ).toBe('/home/ana/.config/Veyquo/native.sock');
    expect(nativeEndpoint({ platform: 'win32', userData: 'C:\\x', username: 'Ana Lopez' })).toBe(
      '\\\\.\\pipe\\veyquo-desktop-Ana Lopez',
    );
  });
});

const key = 'a'.repeat(64);
const nonce = 'c'.repeat(64);

/** A client on `path` that collects every frame and notices when the app hangs up. */
function client(path: string) {
  const socket = connect(path);
  const decoder = new FrameDecoder();
  const frames: IpcFrame[] = [];
  let hungUp = false;
  const closed = new Promise<void>((resolve) => {
    socket.on('close', () => {
      hungUp = true;
      resolve();
    });
  });
  socket.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  socket.on('error', () => undefined);
  const next = async (): Promise<IpcFrame> => {
    for (let i = 0; i < 200; i += 1) {
      const frame = frames.shift();
      if (frame !== undefined) return frame;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('no frame arrived');
  };
  return {
    socket,
    next,
    closed,
    frames,
    hungUp: () => hungUp,
    send: (frame: IpcFrame) => socket.write(encodeFrame(frame)),
  };
}

/** The native host's side of the handshake, done right. */
async function admit(peer: ReturnType<typeof client>, withKey = key): Promise<void> {
  peer.send({ id: 'h', kind: 'hello', payload: { nonce } });
  const welcome = await peer.next();
  expect(welcome.kind).toBe('welcome');
  const { proof, nonce: appNonce } = welcome.payload as { proof: string; nonce: string };
  expect(proof).toBe(ipcProof(withKey, 'app', nonce));
  peer.send({ id: 'a', kind: 'auth', payload: { proof: ipcProof(withKey, 'host', appNonce) } });
  expect(await peer.next()).toEqual({ id: 'a', kind: 'admitted', payload: null });
}

describe('native IPC endpoint', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'veyquo-ipc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('admits a host that proves the key, and proves it back, on a socket only its owner can open', async () => {
    const path = join(dir, 'native.sock');
    const server = await startNativeIpc(
      path,
      (connection) => {
        connection.onFrame((incoming) => {
          connection.send({ id: incoming.id, kind: 'pong', payload: incoming.payload });
        });
      },
      { key },
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const peer = client(path);
    await admit(peer);
    peer.send({ id: 'p1', kind: 'ping', payload: { n: 1 } });
    expect(await peer.next()).toEqual({ id: 'p1', kind: 'pong', payload: { n: 1 } });
    peer.socket.destroy();
    await server.close();
  });

  it('never sends the key: the welcome proves it for this nonce only', async () => {
    const path = join(dir, 'native.sock');
    const server = await startNativeIpc(path, () => undefined, { key });
    const first = client(path);
    first.send({ id: 'h', kind: 'hello', payload: { nonce } });
    const welcome = await first.next();
    expect(JSON.stringify(welcome)).not.toContain(key);
    const other = client(path);
    other.send({ id: 'h', kind: 'hello', payload: { nonce: 'd'.repeat(64) } });
    const second = await other.next();
    expect((second.payload as { proof: string }).proof).not.toBe(
      (welcome.payload as { proof: string }).proof,
    );
    expect((second.payload as { nonce: string }).nonce).not.toBe(
      (welcome.payload as { nonce: string }).nonce,
    );
    first.socket.destroy();
    other.socket.destroy();
    await server.close();
  });

  it.each([
    { case: 'a frame before the hello', frames: [{ id: 'p', kind: 'ping', payload: null }] },
    { case: 'a hello without a nonce', frames: [{ id: 'h', kind: 'hello', payload: null }] },
    {
      case: 'a hello with a short nonce',
      frames: [{ id: 'h', kind: 'hello', payload: { nonce: 'ab' } }],
    },
    {
      case: 'the old key-in-hello',
      frames: [{ id: 'h', kind: 'hello', payload: { key } }],
    },
    {
      case: 'a wrong proof',
      frames: [
        { id: 'h', kind: 'hello', payload: { nonce } },
        { id: 'a', kind: 'auth', payload: { proof: 'f'.repeat(64) } },
      ],
    },
    {
      case: 'a frame instead of the proof',
      frames: [
        { id: 'h', kind: 'hello', payload: { nonce } },
        { id: 'p', kind: 'ping', payload: null },
      ],
    },
  ])('hangs up on $case, and nothing reaches the app', async ({ frames }) => {
    const path = join(dir, 'native.sock');
    const seen: IpcFrame[] = [];
    let connections = 0;
    const server = await startNativeIpc(
      path,
      (connection) => {
        connections += 1;
        connection.onFrame((incoming) => seen.push(incoming));
      },
      { key },
    );
    const peer = client(path);
    for (const frame of frames) peer.send(frame);
    peer.send({ id: 'p2', kind: 'ping', payload: null });
    await peer.closed;
    expect(seen).toEqual([]);
    expect(connections).toBe(0);
    await server.close();
  });

  it('hangs up on a client that says nothing within the hello deadline', async () => {
    const path = join(dir, 'native.sock');
    const server = await startNativeIpc(path, () => undefined, { key, helloTimeoutMs: 50 });
    const silent = client(path);
    await silent.closed;
    expect(silent.hungUp()).toBe(true);
    // A host that is admitted in time stays connected past the deadline.
    const prompt = client(path);
    await admit(prompt);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(prompt.hungUp()).toBe(false);
    prompt.socket.destroy();
    await server.close();
  });

  it('hangs up on a frame over 16 KiB before admission, and carries large ones after', async () => {
    const path = join(dir, 'native.sock');
    const seen: IpcFrame[] = [];
    const server = await startNativeIpc(
      path,
      (connection) => {
        connection.onFrame((incoming) => seen.push(incoming));
      },
      { key },
    );
    const early = client(path);
    early.send({
      id: 'h',
      kind: 'hello',
      payload: { nonce, padding: 'x'.repeat(maxPreAdmissionBytes) },
    });
    await early.closed;
    expect(early.frames).toEqual([]);
    const admitted = client(path);
    await admit(admitted);
    const big = { id: 'b', kind: 'cdp.event', payload: { data: 'y'.repeat(200 * 1024) } };
    admitted.send(big);
    await expect.poll(() => seen.length).toBe(1);
    expect(seen[0]).toEqual(big);
    admitted.socket.destroy();
    await server.close();
  });

  it('the app sees the admitted connection close', async () => {
    const path = join(dir, 'native.sock');
    let closed = false;
    const server = await startNativeIpc(
      path,
      (connection) => {
        connection.onClose(() => {
          closed = true;
        });
      },
      { key },
    );
    const peer = client(path);
    await admit(peer);
    peer.socket.destroy();
    await expect.poll(() => closed).toBe(true);
    await server.close();
  });

  it('writes a fresh private key file for each start', async () => {
    const file = join(dir, 'native-ipc.key');
    const first = await createIpcKey(file);
    const second = await createIpcKey(file);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).not.toBe(first);
    expect((await readFile(file, 'utf8')).trim()).toBe(second);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('refuses a socket path longer than the OS allows instead of failing obscurely', async () => {
    await expect(
      startNativeIpc(join(dir, 'x'.repeat(120), 'native.sock'), () => undefined, { key }),
    ).rejects.toThrow(/longer than the OS allows/u);
  });

  it('replaces a stale socket file left by a crash', async () => {
    const path = join(dir, 'native.sock');
    await writeFile(path, ''); // what a crashed run leaves behind blocks listen()
    const server = await startNativeIpc(path, () => undefined, { key });
    expect((await stat(path)).isSocket()).toBe(true);
    await server.close();
  });
});
