// 构建本机 sidecar 并按 Tauri 约定放入 src-tauri/binaries/mockserver-<host-triple>
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.platform === 'win32' ? '.exe' : '';

let triple;
try {
  triple = execSync('rustc --print host-tuple').toString().trim();
} catch {
  console.error('[prepare-sidecar] 未找到 rustc，请先安装 Rust：https://rustup.rs');
  process.exit(1);
}

console.log('[prepare-sidecar] bun build.mjs 构建本机 sidecar…');
execSync('bun build.mjs', { cwd: root, stdio: 'inherit' });

const built = [path.join(root, `mockserver${ext}`), path.join(root, 'mockserver')].find((p) => fs.existsSync(p));
if (!built) {
  console.error('[prepare-sidecar] 未找到构建产物 mockserver');
  process.exit(1);
}

const destDir = path.join(root, 'src-tauri', 'binaries');
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, `mockserver-${triple}${ext}`);
fs.copyFileSync(built, dest);
console.log(`[prepare-sidecar] sidecar → ${path.relative(root, dest)}`);
