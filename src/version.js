// 版本号单源（server.js / mcp-server.js 共用）：优先最近 git tag（发版即打 tag，软件版本自动跟随，见 AGENTS.md「发版流程」）；
// 无 tag 回落 package.json；编译产物（无 .git、无 package.json）由 build.mjs 注入，此处保持 'unknown' 无操作。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = process.env.MOCK_SERVER_DIR || path.dirname(fileURLToPath(import.meta.url));

let _cached;

export async function getVersion(rootDir = ROOT_DIR) {
  // HTTP MCP 端点每请求都要 serverInfo：spawnSync git 不能每请求跑，缓存结果
  if (rootDir === ROOT_DIR && _cached !== undefined) return _cached;
  try {
    const gitVer = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8' });
    if (gitVer.status === 0 && gitVer.stdout?.trim()) {
      const v = gitVer.stdout.trim().replace(/^v/, '');
      if (rootDir === ROOT_DIR) _cached = v;
      return v;
    }
    const pkgPath = path.join(rootDir, 'package.json');
    const v = JSON.parse(await fs.readFile(pkgPath, 'utf8')).version;
    if (rootDir === ROOT_DIR) _cached = v;
    return v;
  } catch { /* keep 'unknown' — packaged mode already has version baked in by build.mjs */ }
  if (rootDir === ROOT_DIR) _cached = 'unknown';
  return 'unknown';
}
