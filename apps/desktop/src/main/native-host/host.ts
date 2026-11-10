// The native-messaging host (desktop plan §4.2): Chrome starts the packaged app with
// `--native-host` (through the launcher `register.ts` writes) when the Veyquo extension calls
// `connectNative("works.hence.veyquo")`. It relays Chrome's frames (stdin/stdout, a 4-byte
// little-endian length and UTF-8 JSON) to the running app's IPC endpoint and back, unchanged,
// and ends when Chrome closes stdin or the app closes the connection.
//
// Before relaying anything it checks that the endpoint is the app (`native-ipc.ts`, mutual
// handshake): a frame from the extension never reaches a process that cannot prove this
// run's key. Frames Chrome sends during the handshake wait for it.
//
// stdout carries native-messaging frames only. Nothing is logged: Chrome reads stdout, and
// frames hold page content.

import type { Duplex, Readable, Writable } from 'node:stream';

import { maxMessageToExtensionBytes } from '@veyquo/local-executor/extension-protocol';

import {
  FrameDecoder,
  encodeFrame,
  helloTimeoutMs,
  ipcProof,
  maxFrameBytes,
  maxPreAdmissionBytes,
  newNonce,
  sameHex,
  type IpcFrame,
} from '../native-ipc.ts';

export interface NativeHostIo {
  stdin: Readable;
  stdout: Writable;
  /** Opens the app's IPC endpoint (the Unix socket or the named pipe). */
  connect: () => Duplex;
  /** This run's key, from `<userData>/native-ipc.key`. */
  readKey: () => Promise<string>;
  timeoutMs?: number;
}

/** Why the host ended. Every case but `stdin_closed` and `app_closed` exits non-zero. */
export type NativeHostExit =
  | 'stdin_closed'
  | 'app_closed'
  | 'app_unreachable'
  | 'app_unverified'
  | 'no_key'
  | 'timeout'
  | 'broken_frame';

export function exitCode(exit: NativeHostExit): number {
  return exit === 'stdin_closed' || exit === 'app_closed' ? 0 : 1;
}

/** Chrome refuses a message over 1 MiB from a host; the app's request is answered instead. */
function tooLarge(frame: IpcFrame): IpcFrame {
  return {
    id: frame.id,
    kind: 'reply',
    payload: {
      ok: false,
      error: { code: 'unavailable', message: 'the request is too large for Chrome' },
    },
  };
}

export async function runNativeHost(io: NativeHostIo): Promise<NativeHostExit> {
  let key: string;
  try {
    key = (await io.readKey()).trim();
  } catch {
    return 'no_key';
  }
  if (key.length === 0) return 'no_key';

  return new Promise<NativeHostExit>((resolve) => {
    const socket = io.connect();
    const fromChrome = new FrameDecoder();
    // Until the app has proved the key, its frames are handshake-sized.
    const fromApp = new FrameDecoder(maxPreAdmissionBytes);
    const waiting: IpcFrame[] = [];
    const hostNonce = newNonce();
    let stage: 'welcome' | 'admitted' | 'relaying' = 'welcome';
    let ended = false;

    const end = (exit: NativeHostExit): void => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      socket.destroy();
      io.stdin.pause();
      resolve(exit);
    };
    const deadline = setTimeout(() => {
      end('timeout');
    }, io.timeoutMs ?? helloTimeoutMs);
    const toApp = (frame: IpcFrame): void => {
      socket.write(encodeFrame(frame));
    };
    const toChrome = (frame: IpcFrame): void => {
      const bytes = encodeFrame(frame);
      if (bytes.length - 4 > maxMessageToExtensionBytes) {
        toApp(tooLarge(frame));
        return;
      }
      io.stdout.write(bytes);
    };

    const fromAppFrame = (frame: IpcFrame): void => {
      if (stage === 'relaying') {
        toChrome(frame);
        return;
      }
      if (stage === 'welcome') {
        const payload = (frame.payload ?? {}) as { proof?: unknown; nonce?: unknown };
        const proof = typeof payload.proof === 'string' ? payload.proof : '';
        const appNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
        if (
          frame.kind !== 'welcome' ||
          !/^[0-9a-f]{64}$/u.test(appNonce) ||
          !sameHex(proof, ipcProof(key, 'app', hostNonce))
        ) {
          end('app_unverified');
          return;
        }
        stage = 'admitted';
        toApp({ id: 'auth', kind: 'auth', payload: { proof: ipcProof(key, 'host', appNonce) } });
        return;
      }
      if (frame.kind !== 'admitted') {
        end('app_unverified');
        return;
      }
      stage = 'relaying';
      fromApp.limit = maxFrameBytes;
      clearTimeout(deadline);
      for (const queued of waiting.splice(0)) toApp(queued);
    };

    socket.on('connect', () => {
      toApp({ id: 'hello', kind: 'hello', payload: { nonce: hostNonce } });
    });
    socket.on('data', (chunk: Buffer) => {
      let frames: IpcFrame[];
      try {
        frames = fromApp.push(chunk);
      } catch {
        end('broken_frame');
        return;
      }
      for (const frame of frames) {
        if (ended) return;
        fromAppFrame(frame);
      }
    });
    socket.on('error', () => {
      end(stage === 'welcome' ? 'app_unreachable' : 'app_closed');
    });
    socket.on('close', () => {
      end(stage === 'welcome' ? 'app_unreachable' : 'app_closed');
    });

    io.stdin.on('data', (chunk: Buffer) => {
      let frames: IpcFrame[];
      try {
        frames = fromChrome.push(chunk);
      } catch {
        end('broken_frame');
        return;
      }
      for (const frame of frames) {
        if (stage === 'relaying') toApp(frame);
        else waiting.push(frame);
      }
    });
    io.stdin.on('end', () => {
      end('stdin_closed');
    });
    io.stdin.on('error', () => {
      end('stdin_closed');
    });
  });
}
