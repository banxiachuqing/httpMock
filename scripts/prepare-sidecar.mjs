// 构建本机 sidecar 并按 Tauri 约定放入 src-tauri/binaries/mockserver-<host-triple>
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.platform === 'win32' ? '.exe' : '';

// 显式映射本机平台 → bun target，不依赖 build.mjs 的无参默认值
// （build.mjs 第 37 行把无参默认硬编码为 bun-darwin-arm64，Windows/Intel Mac 上无参构建会产出错架构产物）
const BUN_TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'win32-x64': 'bun-windows-x64',
  'win32-arm64': 'bun-windows-arm64',
};

const bunTarget = BUN_TARGETS[`${process.platform}-${process.arch}`];
if (!bunTarget) {
  console.error(`[prepare-sidecar] 不支持的平台组合：${process.platform}/${process.arch}（仅支持 darwin arm64/x64、win32 x64/arm64）`);
  process.exit(1);
}

let triple;
try {
  triple = execSync('rustc --print host-tuple').toString().trim();
} catch {
  console.error('[prepare-sidecar] 未找到 rustc，请先安装 Rust：https://rustup.rs');
  process.exit(1);
}

const outfile = `mockserver${ext}`;
console.log(`[prepare-sidecar] bun build.mjs ${bunTarget} ${outfile} 构建本机 sidecar…`);
execSync(`bun build.mjs ${bunTarget} ${outfile}`, { cwd: root, stdio: 'inherit' });

const built = path.join(root, outfile);
if (!fs.existsSync(built)) {
  console.error(`[prepare-sidecar] 未找到构建产物 ${outfile}`);
  process.exit(1);
}

// 拷贝前校验：unix 用 file 命令确认产物存在且非空；Windows 跳过该检查
if (process.platform !== 'win32') {
  let info;
  try {
    info = execSync(`file ${JSON.stringify(built)}`).toString().trim();
  } catch {
    console.error(`[prepare-sidecar] file 校验失败，产物不可读：${path.relative(root, built)}`);
    process.exit(1);
  }
  if (info.endsWith(': empty')) {
    console.error(`[prepare-sidecar] 构建产物是空文件：${path.relative(root, built)}`);
    process.exit(1);
  }
  console.log(`[prepare-sidecar] ${info}`);
}

const destDir = path.join(root, 'src-tauri', 'binaries');
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, `mockserver-${triple}${ext}`);
fs.copyFileSync(built, dest);
console.log(`[prepare-sidecar] sidecar → ${path.relative(root, dest)}`);
