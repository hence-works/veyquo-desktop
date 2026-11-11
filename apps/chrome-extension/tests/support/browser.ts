// The extension's integration harness: Playwright's bundled Chromium (branded Chrome ignores
// --load-extension) with the built extension (dist/) loaded, a stub native host registered
// in the test's own user-data dir, and the test playing the desktop app on the other end of
// that host: a Unix socket whose connection is a `RelayLink`, so a real `LocalExecutor` can
// drive the person's Chrome through the extension, as the app does.
//
// Pages come from a local fixture server only. Needs a display: run under `xvfb-run -a`.

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import {
  RelayClosedError,
  extensionIds,
  nativeHostName,
  parseEvent,
  parseFrame,
  parseReply,
  type ExtensionEvent,
  type RelayFrame,
  type RelayLink,
  type RelayReply,
  type RelayRequest,
} from '@veyquo/local-executor/extension';

const appDir = join(import.meta.dirname, '..', '..');
export const extensionDir = join(appDir, 'dist');
export const extensionId = extensionIds[0];

function encode(frame: RelayFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** The test's end of the relay: what the desktop app's IPC connection is. */
export class SocketLink implements RelayLink {
  closed = false;
  readonly events: ExtensionEvent[] = [];
  private readonly socket: Socket;
  private readonly pending = new Map<string, (reply: RelayReply) => void>();
  private readonly eventHandlers = new Set<(event: ExtensionEvent) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private buffered = Buffer.alloc(0);
  private next = 1;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      while (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32LE(0);
        if (this.buffered.length < 4 + length) break;
        const text = this.buffered.subarray(4, 4 + length).toString('utf8');
        this.buffered = this.buffered.subarray(4 + length);
        this.receive(JSON.parse(text) as unknown);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const handler of [...this.closeHandlers]) handler();
    });
    socket.on('error', () => undefined);
  }

  request(request: RelayRequest): Promise<RelayReply> {
    if (this.closed) return Promise.reject(new RelayClosedError());
    const id = `t-${String(this.next++)}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.onClosed(() => {
        reject(new RelayClosedError());
      });
      this.socket.write(encode({ id, kind: request.kind, payload: request.payload }));
    });
  }

  /** A frame the app sends without an answer (`state`). */
  tell(kind: string, payload: unknown): void {
    this.socket.write(encode({ id: `t-${String(this.next++)}`, kind, payload }));
  }

  onEvent(handler: (event: ExtensionEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClosed(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** The first event of `kind` matching `match`, waiting for it if it has not come yet. */
  async waitFor<K extends ExtensionEvent['kind']>(
    kind: K,
    match: (event: Extract<ExtensionEvent, { kind: K }>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Extract<ExtensionEvent, { kind: K }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(
        (event): event is Extract<ExtensionEvent, { kind: K }> =>
          event.kind === kind && match(event as Extract<ExtensionEvent, { kind: K }>),
      );
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no ${kind} event arrived`);
  }

  close(): void {
    this.socket.destroy();
  }

  private receive(value: unknown): void {
    const frame = parseFrame(value);
    if (frame === null) return;
    if (frame.kind === 'reply') {
      const reply = parseReply(frame);
      const resolve = this.pending.get(frame.id);
      if (reply !== null && resolve !== undefined) {
        this.pending.delete(frame.id);
        resolve(reply);
      }
      return;
    }
    const event = parseEvent(frame);
    if (event === null) return;
    this.events.push(event);
    for (const handler of [...this.eventHandlers]) handler(event);
  }
}

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`: the "employer" origin. */
  origin: string;
  /** The same server as `http://localhost:<port>`: another origin. */
  otherOrigin: string;
  close(): Promise<void>;
}

export async function fixtureServer(): Promise<FixtureServer> {
  const fixtures = join(appDir, 'tests', 'fixtures');
  const server: HttpServer = createHttpServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]?.replace(/^\//u, '') ?? '';
    const name = path === '' ? 'form.html' : path;
    if (!/^[a-z-]+\.html$/u.test(name)) {
      response.writeHead(404).end();
      return;
    }
    readFile(join(fixtures, name)).then(
      (body) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
      },
      () => {
        response.writeHead(404).end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    otherOrigin: `http://localhost:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface Harness {
  context: BrowserContext;
  worker: Worker;
  link: SocketLink;
  close(): Promise<void>;
}

/** Chromium with the extension, connected through the stub host to a fresh `SocketLink`. */
export async function launch(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'vq-ext-'));
  const userData = join(dir, 'profile');
  const socketPath = join(dir, 'relay.sock');
  const hostDir = join(userData, 'NativeMessagingHosts');
  await mkdir(hostDir, { recursive: true });
  const wrapper = join(dir, 'stub-host.sh');
  const stub = join(appDir, 'tests', 'support', 'stub-host.ts');
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${stub}" "${socketPath}" "$@"\n`,
  );
  await chmod(wrapper, 0o700);
  await writeFile(
    join(hostDir, `${nativeHostName}.json`),
    JSON.stringify({
      name: nativeHostName,
      description: 'Veyquo test host',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }),
  );

  // The first host connection is the test's link. The extension reconnects whenever its
  // port closes (when the link closes at the end of a test, too): every socket is kept so
  // closing the harness can end them all.
  let accept: (socket: Socket) => void = () => undefined;
  const connected = new Promise<Socket>((resolve) => (accept = resolve));
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    accept(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker =
    context.serviceWorkers().find((w) => w.url().includes(extensionId)) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const link = new SocketLink(await connected);
  await link.waitFor('hello');
  link.tell('state', { activity: 'idle' }); // what the desktop app sends first
  return {
    context,
    worker,
    link,
    close: async () => {
      await context.close();
      link.close();
      const closed = new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The Chrome tab id of `page` (looked up by its URL, which the tests keep unique). */
export async function tabIdOf(worker: Worker, url: string): Promise<number> {
  const id = await worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)?.id ?? null;
  }, url);
  if (id === null) throw new Error('no tab shows that page');
  return id;
}

/** Opens the popup the way the toolbar button does, in its own small window, so the
 * person's tab stays the active tab of the last focused browser window. */
export async function openPopup(harness: Harness): Promise<Page> {
  const [popup] = await Promise.all([
    harness.context.waitForEvent('page'),
    harness.worker.evaluate(async () => {
      await chrome.windows.create({
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 800,
        height: 600,
      });
    }),
  ]);
  await popup.waitForLoadState();
  return popup;
}
