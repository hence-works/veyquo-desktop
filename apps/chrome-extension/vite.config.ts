import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';

import { defineConfig, type Plugin, type WebSocketClient } from 'vite';

import { buildExtension, extensionRoot } from './scripts/build.ts';

function extensionReload(): Plugin {
  const buildSession = randomUUID();
  let buildNumber = 0;
  let currentBuildId = '';
  let pending: ReturnType<typeof setTimeout> | undefined;
  let buildQueue = Promise.resolve();
  const watched = [
    join(extensionRoot, 'src'),
    join(extensionRoot, 'icons'),
    join(extensionRoot, 'manifest.json'),
    join(extensionRoot, '../../packages/local-executor/src'),
    join(extensionRoot, '../../packages/device-protocol/src'),
    join(extensionRoot, '../../packages/ui/src'),
  ];
  const shouldBuild = (path: string): boolean =>
    watched.some((entry) => path === entry || path.startsWith(`${entry}${sep}`));

  return {
    name: 'veyquo-extension-reload',
    async configureServer(server) {
      const rebuild = async (): Promise<void> => {
        const buildId = `${buildSession}-${String(++buildNumber)}`;
        try {
          // Vite's browser HMR client cannot run inside an MV3 extension's packaged-code CSP.
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- authenticated local HMR socket is the supported dev-only bridge here
          await buildExtension({ buildId, webSocketToken: server.config.webSocketToken });
          currentBuildId = buildId;
          server.ws.send('veyquo:extension:reload', { buildId });
          server.config.logger.info(`[extension] rebuilt dist/ (${buildId})`);
        } catch (error) {
          server.config.logger.error('[extension] rebuild failed; fix the source and save again', {
            error: error instanceof Error ? error : undefined,
          });
        }
      };

      await rebuild();
      server.ws.on('veyquo:extension:hello', (data: unknown, client: WebSocketClient) => {
        const buildId =
          typeof data === 'object' && data !== null && 'buildId' in data ? data.buildId : undefined;
        if (buildId !== currentBuildId) {
          client.send('veyquo:extension:reload', { buildId: currentBuildId });
        }
      });
      server.watcher.add(watched);
      server.watcher.on('all', (event, path) => {
        if (!['add', 'change', 'unlink'].includes(event) || !shouldBuild(path)) return;
        if (pending !== undefined) clearTimeout(pending);
        pending = setTimeout(() => {
          buildQueue = buildQueue.then(rebuild);
        }, 100);
      });
      server.httpServer?.once('close', () => {
        if (pending !== undefined) clearTimeout(pending);
      });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [extensionReload()],
  server: {
    port: 5187,
    strictPort: true,
  },
});
