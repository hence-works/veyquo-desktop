import { WebSocket, type RawData } from 'ws';

import type { CdpWebSocketChannel, WebSocketObserver } from '@veyquo/local-executor';

/** Adapts the desktop app's existing `ws` client to the executor's dependency-free channel. */
export function cdpWebSocket(endpoint: string): CdpWebSocketChannel {
  const socket = new WebSocket(endpoint, { perMessageDeflate: false });
  return {
    get readyState() {
      return socket.readyState;
    },
    send(data) {
      socket.send(data);
    },
    close() {
      socket.close();
    },
    subscribe(observer: WebSocketObserver) {
      const open = (): void => {
        observer.open();
      };
      const message = (data: RawData): void => {
        observer.message(data);
      };
      const close = (): void => {
        observer.close();
      };
      const error = (): void => {
        observer.error();
      };
      socket.on('open', open);
      socket.on('message', message);
      socket.on('close', close);
      socket.on('error', error);
      return () => {
        socket.off('open', open);
        socket.off('message', message);
        socket.off('close', close);
        socket.off('error', error);
      };
    },
  };
}
