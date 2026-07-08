import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import express from 'express';
import open from 'open';
import { ConfigStore } from './src/config-store.js';
import { LogBuffer } from './src/log-buffer.js';
import { MockEngine } from './src/mock-engine.js';
import { createApi } from './src/api.js';
import { defaultStoragePath, ensureDir } from './src/paths.js';

const __dirname = process.env.MOCK_SERVER_DIR || path.dirname(fileURLToPath(import.meta.url));

// Detect non-loopback IPv4 addresses for LAN access hints
function listLocalIPv4s() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push({ name, address: i.address });
    }
  }
  return out;
}

export async function startServer({ storagePath, uiPort, openBrowser = true, host, publicPath } = {}) {
  // Resolve bind host: param > MOCK_HOST env > 127.0.0.1
  const finalHost = host || process.env.MOCK_HOST || '127.0.0.1';

  const finalStoragePath = storagePath || defaultStoragePath();
  ensureDir(finalStoragePath);

  const finalPublicPath = publicPath || path.join(__dirname, 'public');

  const configStore = new ConfigStore({ storagePath: finalStoragePath });
  await configStore.load();

  const logBuffer = new LogBuffer(500);
  // MockEngine reads maxBodyBytes dynamically from configStore on every request
  const mockEngine = new MockEngine({ logBuffer, bindHost: finalHost, configStore });

  const app = createApi({ storagePath: finalStoragePath, configStore, logBuffer, mockEngine });
  // Serve CodeMirror ESM modules from node_modules
  for (const pkg of ['view', 'state', 'lang-json', 'lint', 'commands', 'language']) {
    app.use(`/vendor/codemirror/${pkg}`, express.static(path.join(__dirname, 'node_modules', `@codemirror/${pkg}`)));
  }
  // Serve CodeMirror transitive deps
  const transitiveMap = {
    'crelt': 'crelt',
    'style-mod': 'style-mod',
    'w3c-keyname': 'w3c-keyname',
    '@marijn/find-cluster-break': '@marijn/find-cluster-break',
    '@lezer/common': '@lezer/common',
    '@lezer/highlight': '@lezer/highlight',
    '@lezer/json': '@lezer/json',
    '@lezer/lr': '@lezer/lr',
  };
  for (const [route, pkg] of Object.entries(transitiveMap)) {
    app.use(`/vendor/${route}`, express.static(path.join(__dirname, 'node_modules', pkg)));
  }

  // Read package.json version once at startup and inject into index.html.
  // Replaces `{{VERSION}}` placeholder so the topbar shows the real version
  // in dev mode (build.mjs already does this for packaged builds).
  let pkgVersion = 'unknown';
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    pkgVersion = JSON.parse(await fs.readFile(pkgPath, 'utf8')).version;
  } catch { /* keep 'unknown' — packaged mode already has version baked in by build.mjs */ }
  const indexHtmlTemplate = await fs.readFile(path.join(finalPublicPath, 'index.html'), 'utf8');
  const indexHtml = indexHtmlTemplate.replaceAll('{{VERSION}}', pkgVersion);

  // Static files (no index fallback — index.html served explicitly below)
  app.use(express.static(finalPublicPath, { index: false }));

  // Serve index.html (with version) for / and SPA-style paths.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.type('html').send(indexHtml);
  });

  // 404 for /api/* unmatched
  app.use((req, res) => {
    res.status(404).json({ error: 'not found', code: 'NOT_FOUND' });
  });

  const desired = uiPort ?? configStore.config.settings.uiPort ?? 5050;
  const server = await listenWithFallback(app, desired, finalHost);
  const port = server.address().port;

  // Print connection hints
  console.log(`[mock-server] WebUI bound to http://${finalHost}:${port}`);
  if (finalHost === '127.0.0.1') {
    console.log('[mock-server]   → accessible at: http://127.0.0.1:' + port);
    const ips = listLocalIPv4s();
    if (ips.length > 0) {
      console.log('[mock-server]   → other devices on your LAN cannot reach 127.0.0.1.');
      console.log('[mock-server]   → to allow LAN access, restart with: MOCK_HOST=0.0.0.0 pnpm start');
      for (const { name, address } of ips) {
        console.log(`[mock-server]     (your ${name}: ${address})`);
      }
    }
  } else {
    console.log('[mock-server]   → accessible at: http://' + finalHost + ':' + port);
    for (const { name, address } of listLocalIPv4s()) {
      console.log(`[mock-server]     also: http://${address}:${port}  (${name})`);
    }
  }

  if (openBrowser) {
    const displayHost = finalHost === '127.0.0.1' ? 'localhost' : finalHost;
    const url = `http://${displayHost}:${port}`;
    open(url).catch(() => {});
  }

  return {
    configStore,
    logBuffer,
    mockEngine,
    server,
    port,
    host: finalHost,
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

const isMain = import.meta.url === `file://${process.argv[1]}` || !!process.env.MOCK_SERVER_DIR;
if (isMain) {
  startServer({ openBrowser: true }).catch((e) => {
    console.error('Failed to start:', e.message);
    process.exit(1);
  });
}
