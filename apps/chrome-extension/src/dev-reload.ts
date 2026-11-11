// Bundled only by `yarn dev`. Chrome's packaged extension runs no remote JavaScript.
declare const __VEYQUO_BUILD_ID__: string;
declare const __VEYQUO_WS_TOKEN__: string;

const socketUrl = `ws://127.0.0.1:5187/?token=${encodeURIComponent(__VEYQUO_WS_TOKEN__)}`;
function connect(): void {
  const socket = new WebSocket(socketUrl, 'vite-hmr');
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        type: 'custom',
        event: 'veyquo:extension:hello',
        data: { buildId: __VEYQUO_BUILD_ID__ },
      }),
    );
    // A message within 30 seconds keeps a Chrome MV3 worker alive (Chrome 116+).
    heartbeat = setInterval(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
  });
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data)) as {
        type?: string;
        event?: string;
        data?: { buildId?: string };
      };
      if (
        message.type === 'custom' &&
        message.event === 'veyquo:extension:reload' &&
        message.data?.buildId !== __VEYQUO_BUILD_ID__
      ) {
        chrome.runtime.reload();
      }
    } catch {
      // Ignore unrelated Vite HMR messages.
    }
  });
  socket.addEventListener('close', () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    setTimeout(connect, 1_000);
  });
  socket.addEventListener('error', () => {
    socket.close();
  });
}

connect();
