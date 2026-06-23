// build.mjs - 用 Bun 打包 mock-server-webui 为单文件可执行
// 用法：
//   bun build.mjs                                    # 当前平台 (Mac arm64)
//   bun build.mjs bun-darwin-x64 mockserver-intel   # Mac x64
//   bun build.mjs bun-windows-x64 mockserver.exe    # Windows x64
//   bun build.mjs bun-windows-arm64 mockserver-arm.exe  # Windows ARM
//
// 改动要求：
//   1. server.js 第 11 行 __dirname 接受 MOCK_SERVER_DIR 环境变量
//   2. 把 public/ 复制到 ./embed-assets/public/
//   3. 把需要嵌入的 vendor 资源复制到 ./embed-assets/vendor/

import { readdirSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ALLOW_EXT = new Set(['.js', '.css', '.html', '.svg', '.json']);
const SKIP_DIRS = new Set(['.github', 'test', 'tests', '__tests__']);

function scan(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...scan(full, base));
    } else {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot) : '';
      if (ALLOW_EXT.has(ext)) {
        files.push({ abs: full, rel: relative(base, full) });
      }
    }
  }
  return files;
}

const target = process.argv[2] || 'bun-darwin-arm64';
const outfile = process.argv[3] || 'mockserver';

const files = scan('./embed-assets');
console.log(`Embedding ${files.length} files...`);

// 读 package.json 的版本号，注入到带 {{VERSION}} 占位符的文件
const pkg = JSON.parse(await Bun.file('./package.json').text());
const VERSION = pkg.version;
console.log(`Version: ${VERSION}`);

const STAGING = './embed-staging';
if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });
mkdirSync(STAGING, { recursive: true });

for (const f of files) {
  const stagedPath = join(STAGING, f.rel + '.txt');
  mkdirSync(join(stagedPath, '..'), { recursive: true });
  if (f.rel.endsWith('.html') || f.rel.endsWith('.json')) {
    // 替换 {{VERSION}} 占位符
    let content = await Bun.file(f.abs).text();
    content = content.replaceAll('{{VERSION}}', VERSION);
    await Bun.write(stagedPath, content);
  } else {
    copyFileSync(f.abs, stagedPath);
  }
}

const lines = files.map((f) => {
  const stagedPath = './' + join(STAGING, f.rel + '.txt');
  return `  ${JSON.stringify(f.rel)}: () => import(${JSON.stringify(stagedPath)})`;
});

const launcher = `// Auto-generated launcher (dynamic import) with file trace
import { writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';

// File trace to bypass stdout issues on Windows
const TRACE = join(homedir(), 'Documents', 'mock-server-webui-trace.log');
const trace = (msg) => {
  try { appendFileSync(TRACE, new Date().toISOString() + ' ' + msg + '\\n'); } catch (e) {}
};
trace('=== LAUNCHER START ===');
trace('typeof Bun=' + typeof Bun);
try { trace('Bun.version=' + (Bun && Bun.version)); } catch(e) { trace('Bun.version err'); }
try { trace('Bun.main=' + (Bun && Bun.main)); } catch(e) { trace('Bun.main err'); }
try { trace('Bun.embeddedFiles=' + JSON.stringify(Bun && Bun.embeddedFiles ? Bun.embeddedFiles.length : 'undef')); } catch(e) { trace('Bun.embeddedFiles err'); }
trace('process.execPath=' + process.execPath);
trace('process.argv[0]=' + process.argv[0]);

const assetLoaders = {
${lines.join(',\n')}
};

// isCompiled: launcher ONLY runs in compiled binary (dev mode runs server.js directly)
const isCompiled = true;
trace('isCompiled=' + isCompiled + ', tmpdir=' + tmpdir());

if (isCompiled) {
  const TMP = join(tmpdir(), 'mock-server-webui-v1');
  try {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    let count = 0;
    for (const [relPath, loader] of Object.entries(assetLoaders)) {
      const mod = await loader();
      let destRel = relPath.startsWith('vendor/') ? 'node_modules/' + relPath.slice(7) : relPath;
      const dest = join(TMP, destRel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, mod.default);
      count++;
    }
    trace('extracted ' + count + ' files to ' + TMP);
    process.env.MOCK_SERVER_DIR = TMP;
    trace('MOCK_SERVER_DIR set');
  } catch (err) {
    trace('EXTRACT FAILED: ' + (err && err.stack || err));
    throw err;
  }
}

trace('about to import server.js');
try {
  await import('./server.js');
  trace('server.js imported OK');
} catch (err) {
  trace('IMPORT FAILED: ' + (err && err.stack || err));
  throw err;
}
`;

writeFileSync('./launcher.js', launcher);

const result = await Bun.build({
  entrypoints: ['./launcher.js'],
  compile: { target, outfile },
  plugins: [{
    name: 'text-loader',
    setup(build) {
      build.onLoad({ filter: /\.txt$/ }, async (args) => {
        const text = await Bun.file(args.path).text();
        return { contents: `export default ${JSON.stringify(text)};`, loader: 'js' };
      });
    },
  }],
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`✅ Built: ${outfile} (target: ${target})`);
