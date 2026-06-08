import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import open from 'open';
import { ConfigStore } from './src/config-store.js';
import { LogBuffer } from './src/log-buffer.js';
import { MockEngine } from './src/mock-engine.js';
import { createApi } from './src/api.js';
import { defaultStoragePath, ensureDir } from './src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startServer({ storagePath, uiPort, openBrowser = true, host = '127.0.0.1', publicPath } = {}) {
  const finalStoragePath = storagePath || defaultStoragePath();
  ensureDir(finalStoragePath);

  const finalPublicPath = publicPath || path.join(__dirname, 'public');

  const configStore = new ConfigStore({ storagePath: finalStoragePath });
  await configStore.load();

  const logBuffer = new LogBuffer(500);
  const mockEngine = new MockEngine({ logBuffer });

  const app = createApi({ storagePath: finalStoragePath, configStore, logBuffer, mockEngine });
  app.use(express.static(finalPublicPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(finalPublicPath, 'index.html'));
  });

  const desired = uiPort ?? configStore.config.settings.uiPort ?? 5050;
  const server = await listenWithFallback(app, desired, host);

  if (openBrowser) {
    const url = `http://${host === '127.0.0.1' ? 'localhost' : host}:${server.address().port}`;
    open(url).catch(() => {});
  }

  return {
    configStore,
    logBuffer,
    mockEngine,
    server,
    port: server.address().port,
    async close() {
      await mockEngine.stop();
      await new Promise((r) => server.close(r));
    },
  };
}

function listenWithFallback(app, startPort, host) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      const s = app.listen(p, host);
      s.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && p < startPort + 50) {
          tryPort(p + 1);
        } else {
          reject(err);
        }
      });
      s.once('listening', () => resolve(s));
    };
    tryPort(startPort);
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer({ openBrowser: true }).catch((e) => {
    console.error('Failed to start:', e.message);
    process.exit(1);
  });
}
