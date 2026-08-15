# 双主题系统 + 桌面标题栏一体化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 前端暗/亮双主题（设置面板三态选项，默认跟随系统）+ Tauri 窗口标题栏一体化（macOS Overlay 融合栏去标题文字，Windows 原生栏随主题染色）。

**Architecture:** `<html data-theme>` 属性 + CSS 变量双组（暗色为默认 `:root`，亮色为 `:root[data-theme="light"]` 覆盖）；主题设置持久化到 data.json settings（PATCH /api/config 白名单加 `theme`）；localStorage 缓存做防闪烁引导；CodeMirror 用 Compartment 热切换；壳侧 macOS Overlay 零联动，Windows 由前端调 `__TAURI__.app.setTheme`。

**Tech Stack:** 原生 ESM/CSS 变量 · CodeMirror 6 Compartment · vitest + supertest · Playwright headed · Tauri 2

**Spec:** `docs/superpowers/specs/2026-08-15-theme-system-design.md`（已获用户批准）

## Global Constraints

- 主题设置值严格三态：`'system' | 'light' | 'dark'`，默认 `'system'`；非法值 PATCH 返回 400 `INVALID_VALUE`
- 协议/信封不变：PATCH /api/config 仅加 `theme` 白名单键，不动其他任何 API 行为
- **`public/` 改动必须同步 `embed-assets/public/`**（关键不变量 #5）：`rsync -a --delete public/ embed-assets/public/`（只同步 public 子目录，vendor 不动）
- 变量名两主题共用；组件样式原则上不改选择器，只把硬编码颜色换成变量
- 壳内嵌页面（loading.html / overlay_js）读不到应用设置，统一 `@media (prefers-color-scheme: …)` 跟随系统
- 提交信息用中文，格式 `<type>: <描述>`；E2E 保持 headed
- 每个 Task 完成后按该 Task 的 commit 步骤单独提交

---

### Task 1: 后端 theme 设置（白名单 + 默认值 + 集成测试）

**Files:**
- Modify: `src/config-store.js`（初始 settings 默认值，约 :45）
- Modify: `src/api.js`（PATCH /api/config handler，:83-108）
- Test: `test/integration/api-config.test.js`（加用例；先读该文件现有模式）

**Interfaces:**
- Consumes: 现有 `configStore.update(mutator)`、`AppError(400, code, message)`
- Produces: `settings.theme` 合法键（三态字符串）；新配置默认 `theme: 'system'`。Task 5 的前端按此读写。

- [ ] **Step 1: 写失败的测试**

读 `test/integration/api-config.test.js` 现有用例结构（buildApp/tempDir 模式），在文件末尾追加：

```js
  it('PATCH /api/config 接受合法 theme 并持久化', async () => {
    const res = await request.patch('/api/config').send({ settings: { theme: 'light' } });
    expect(res.status).toBe(200);
    const cfg = await request.get('/api/config');
    expect(cfg.body.settings.theme).toBe('light');
  });

  it('PATCH /api/config 拒绝非法 theme 值', async () => {
    const res = await request.patch('/api/config').send({ settings: { theme: 'neon' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALUE');
  });

  it('新配置默认 theme 为 system', async () => {
    const cfg = await request.get('/api/config');
    expect(cfg.body.settings.theme).toBe('system');
  });
```

（用例名 `request`/`app` 等以该文件现有局部变量为准适配；断言语义不得变。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-config.test.js`
Expected: FAIL — 前两个新用例失败（theme 未持久化、无 400）；第三个视现有默认值实现而定

- [ ] **Step 3: 实现**

`src/config-store.js` 初始 settings（:45 附近）改为：

```js
        settings: { storagePath: this.storagePath, uiPort: 5050, maxBodyBytes: 4 * 1024 * 1024, theme: 'system' },
```

`src/api.js` PATCH handler：在 maxBodyBytes 校验块后加：

```js
      if (settings.theme !== undefined) {
        if (!['system', 'light', 'dark'].includes(settings.theme)) {
          throw new AppError(400, 'INVALID_VALUE', "theme must be one of 'system' | 'light' | 'dark'");
        }
      }
```

`configStore.update` 的 mutator 里加：

```js
        if (settings.theme !== undefined) cfg.settings.theme = settings.theme;
```

存量 data.json 无 `theme` 键时读取侧不做迁移（前端 `?? 'system'` 兜底，见 Task 5）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/integration/api-config.test.js`
Expected: PASS（新旧用例全过）

- [ ] **Step 5: Commit**

```bash
git add src/config-store.js src/api.js test/integration/api-config.test.js
git commit -m "feat: 设置白名单新增 theme 三态项（默认跟随系统）"
```

---

### Task 2: theme.js 模块 + 防闪烁引导 + 单测

**Files:**
- Create: `public/theme.js`
- Modify: `public/index.html`（`<head>` 内加内联引导脚本）
- Test: `test/unit/theme.test.js`（新建）

**Interfaces:**
- Consumes: 无（不依赖其他任务）
- Produces（Task 5 依赖，不得改名）:
  - `resolveTheme(setting: 'system'|'light'|'dark', prefersDark: boolean) -> 'light'|'dark'`（纯函数）
  - `applyTheme(setting: string) -> void` — 解析 → 设 `document.documentElement.dataset.theme` → system 模式挂 matchMedia 监听 → Tauri 环境加 `tauri` class 并调 `__TAURI__.app.setTheme(resolved)`
  - `onThemeChange(fn: (resolved: 'light'|'dark') => void) -> void` — 主题实际生效值变化时回调（Task 5 用它联动 CodeMirror）
  - localStorage 缓存键：`mockserver.theme`

- [ ] **Step 1: 写失败的测试**

`test/unit/theme.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { resolveTheme } from '../../public/theme.js';

describe('resolveTheme', () => {
  it('system 跟随 prefersDark', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('显式 light/dark 覆盖系统偏好', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('非法值按 system 处理', () => {
    expect(resolveTheme('neon', true)).toBe('dark');
    expect(resolveTheme(undefined, false)).toBe('light');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/theme.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 theme.js**

`public/theme.js`（注意：`window`/`document` 必须函数内惰性访问，保证 vitest 可在 node 环境 import）：

```js
// 主题系统：system / light / dark → 解析生效值 → data-theme + Tauri 壳联动
// spec: docs/superpowers/specs/2026-08-15-theme-system-design.md
const VALID = new Set(['system', 'light', 'dark']);
const CACHE_KEY = 'mockserver.theme';

let current = 'system';
let media = null;
const listeners = new Set();

/**
 * 纯函数：设置值 + 系统偏好 → 生效主题
 * @param {string} setting
 * @param {boolean} prefersDark
 * @returns {'light'|'dark'}
 */
export function resolveTheme(setting, prefersDark) {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/** 注册主题生效值变化回调（如 CodeMirror 联动） */
export function onThemeChange(fn) {
  listeners.add(fn);
}

function mediaQuery() {
  if (!media) media = window.matchMedia('(prefers-color-scheme: dark)');
  return media;
}

function applyResolved(resolved) {
  document.documentElement.dataset.theme = resolved;
  if (window.__TAURI__) {
    document.documentElement.classList.add('tauri');
    try {
      window.__TAURI__.app.setTheme(resolved);
    } catch {
      /* 壳不支持时忽略（浏览器模式 / 旧壳） */
    }
  }
  listeners.forEach((fn) => fn(resolved));
}

/**
 * 应用主题设置。system 模式下挂 matchMedia change 监听跟随系统。
 * @param {string} setting
 */
export function applyTheme(setting) {
  current = VALID.has(setting) ? setting : 'system';
  const mq = mediaQuery();
  applyResolved(resolveTheme(current, mq.matches));
  try {
    localStorage.setItem(CACHE_KEY, current);
  } catch {
    /* 隐私模式等场景忽略 */
  }
  mq.onchange = () => {
    if (current !== 'system') return;
    applyResolved(resolveTheme(current, mq.matches));
  };
}

/** 当前设置值（三态） */
export function currentSetting() {
  return current;
}
```

- [ ] **Step 4: index.html 防闪烁引导**

在 `public/index.html` 的 `<head>` 内、importmap `<script type="importmap">` **之前**插入：

```html
  <script>
    // 主题防闪烁：首帧前按缓存/系统偏好设置 data-theme；app.js 加载后以服务端设置调和
    (function () {
      var s = 'system';
      try { s = localStorage.getItem('mockserver.theme') || 'system'; } catch (e) {}
      var dark = s === 'dark' || (s !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    })();
  </script>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run test/unit/theme.test.js`
Expected: PASS（3 个用例）

- [ ] **Step 6: Commit**

```bash
git add public/theme.js public/index.html test/unit/theme.test.js
git commit -m "feat: 主题模块 theme.js 与首帧防闪烁引导"
```

---

### Task 3: styles.css 变量提升 + 亮色变量组

**Files:**
- Modify: `public/styles.css`（`:root` 新增变量、36 处硬编码颜色替换、末尾追加亮色覆盖块）

**Interfaces:**
- Consumes: Task 2 的 `data-theme` 属性机制
- Produces: `:root[data-theme="light"]` 亮色变量组；暗色保持视觉不变（纯重构式替换）

**原则：暗色主题为回归基准——本任务完成后暗色下任何像素不应变化。** 替换全是"字面值 → 同名变量"的等价搬移。

- [ ] **Step 1: `:root` 追加暗色新变量**

在 `public/styles.css` 的 `:root` 块 `--glass-highlight` 行（:62）之后追加：

```css
  /* Theme-sensitive composites (hoisted from component rules) */
  --bg-gradient: linear-gradient(160deg, #0a0a0f 0%, #05060a 55%, #020203 100%);
  --blob-1: rgba(94, 106, 210, 0.16);
  --blob-2: rgba(176, 106, 240, 0.10);
  --blob-3: rgba(52, 209, 123, 0.08);
  --blob-1-strong: rgba(94, 106, 210, 0.35);
  --blob-2-strong: rgba(176, 106, 240, 0.22);
  --topbar-bg: rgba(10, 10, 15, 0.55);
  --focus-ring: rgba(94, 106, 210, 0.35);
  --amber-wash-top: rgba(245, 184, 76, 0.14);
  --amber-wash-bottom: rgba(245, 184, 76, 0.08);
  --green-wash-top: rgba(52, 209, 123, 0.14);
  --green-wash-bottom: rgba(52, 209, 123, 0.07);
  --panel-bg: rgba(255, 255, 255, 0.04);
  --danger-wash: rgba(200, 48, 42, 0.1);
  --input-focus-bg: rgba(10, 10, 15, 0.6);
  --input-focus-ring: rgba(94, 106, 210, 0.4);
  --log-enter-bg: rgba(94, 106, 210, 0.18);
  --backdrop: rgba(0, 0, 0, 0.6);
  --modal-bg: rgba(18, 18, 26, 0.82);
  --ok-ring: rgba(26, 135, 84, 0.18);
  --err-ring: rgba(200, 48, 42, 0.18);
  --banner-bg: rgba(200, 48, 42, 0.05);
  --expr-error-bg: rgba(200, 48, 42, 0.08);
  --amber-ring: rgba(184, 120, 10, 0.15);
  --dialog-bg: rgba(18, 18, 26, 0.88);
  --dialog-backdrop: rgba(4, 6, 12, 0.6);
  --warning-wash: rgba(255, 170, 0, 0.12);
  --porthdr-bg: rgba(255, 255, 255, 0.06);
  --card-bg: rgba(255, 255, 255, 0.05);
  --card-hover: rgba(255, 255, 255, 0.08);
```

- [ ] **Step 2: 逐站点替换硬编码颜色为变量**

按下表替换（行号为替换前现状，替换后行号会漂移，以内容定位为准）：

| 位置 | 旧（字面值） | 新 |
|---|---|---|
| :104 `html, body` background | `linear-gradient(160deg, #0a0a0f 0%, #05060a 55%, #020203 100%)` | `var(--bg-gradient)` |
| :127 body 光斑 1 | `rgba(94, 106, 210, 0.16)` | `var(--blob-1)` |
| :128 body 光斑 2 | `rgba(176, 106, 240, 0.10)` | `var(--blob-2)` |
| :129 body 光斑 3 | `rgba(52, 209, 123, 0.08)` | `var(--blob-3)` |
| :200 `.blobs` 子元素 1 | `rgba(94, 106, 210, 0.35)` | `var(--blob-1-strong)` |
| :208 `.blobs` 子元素 2 | `rgba(176, 106, 240, 0.22)` | `var(--blob-2-strong)` |
| :253 `.topbar` background | `rgba(10, 10, 15, 0.55)` | `var(--topbar-bg)` |
| :427 `.btn:focus-visible` box-shadow | `0 0 0 2px rgba(94, 106, 210, 0.35)` | `0 0 0 2px var(--focus-ring)` |
| :463 / :471 启动按钮 stopped 渐变 | `rgba(245, 184, 76, 0.14)` / `rgba(245, 184, 76, 0.08)` | `var(--amber-wash-top)` / `var(--amber-wash-bottom)` |
| :480 启动按钮 running 渐变 | `rgba(52, 209, 123, 0.14)` / `rgba(52, 209, 123, 0.07)` | `var(--green-wash-top)` / `var(--green-wash-bottom)` |
| :509 `.sidebar` background | `rgba(255, 255, 255, 0.04)` | `var(--panel-bg)` |
| :682 `.endpoint-delete:hover` background | `rgba(200, 48, 42, 0.1)` | `var(--danger-wash)` |
| :823 `.input:focus, .select:focus` background | `rgba(10, 10, 15, 0.6)` | `var(--input-focus-bg)` |
| :824 同上 box-shadow | `0 0 0 1px rgba(94, 106, 210, 0.4)` | `0 0 0 1px var(--input-focus-ring)` |
| :964 `.logs` background | `rgba(255, 255, 255, 0.04)` | `var(--panel-bg)` |
| :1114 `@keyframes logEnter` from 背景 | `rgba(94, 106, 210, 0.18)` | `var(--log-enter-bg)` |
| :1164 `.modal-backdrop` background | `rgba(0, 0, 0, 0.6)` | `var(--backdrop)` |
| :1175 `.modal-panel` background | `rgba(18, 18, 26, 0.82)` | `var(--modal-bg)` |
| :1285 preview resolved dot 环 | `0 0 0 2px rgba(26, 135, 84, 0.18)` | `0 0 0 2px var(--ok-ring)` |
| :1289 preview error dot 环 | `0 0 0 2px rgba(200, 48, 42, 0.18)` | `0 0 0 2px var(--err-ring)` |
| :1309 `.preview-banner` background | `rgba(200, 48, 42, 0.05)` | `var(--banner-bg)` |
| :1311 同上 border-bottom | `1px solid rgba(200, 48, 42, 0.18)` | `1px solid var(--err-ring)` |
| :1322 banner 相关 3px 环 | `0 0 0 3px rgba(200, 48, 42, 0.18)` | `0 0 0 3px var(--err-ring)` |
| :1354 `.expr-error` background | `rgba(200, 48, 42, 0.08)` | `var(--expr-error-bg)` |
| :1521 `.gen-args` focus 环 | `0 0 0 2px rgba(184, 120, 10, 0.15)` | `0 0 0 2px var(--amber-ring)` |
| :1570 `dialog.log-detail` background | `rgba(18, 18, 26, 0.88)` | `var(--dialog-bg)` |
| :1583 `dialog.log-detail::backdrop` background | `rgba(4, 6, 12, 0.6)` | `var(--dialog-backdrop)` |
| :1650 `.log-detail-body-warning` background | `rgba(255, 170, 0, 0.12)` | `var(--warning-wash)` |
| :1693 `.port-header` background | `rgba(255, 255, 255, 0.06)` | `var(--porthdr-bg)` |
| :1718 `.port-card` background | `rgba(255, 255, 255, 0.05)` | `var(--card-bg)` |
| :1733 `.port-card:hover` background | `rgba(255, 255, 255, 0.08)` | `var(--card-hover)` |

**不动**的站点（两主题通用）：:175-176 grid mask（mask 只吃 alpha 通道）、:910 inset 阴影 `rgba(0,0,0,0.06)`。

- [ ] **Step 3: 追加亮色覆盖块**

在 `styles.css` 末尾追加（浅色玻璃调色板，语义色按亮底加深）：

```css
/* ============================================================
   Light theme — 浅色玻璃（与暗色互为姊妹）
   ============================================================ */
:root[data-theme="light"] {
  color-scheme: light;

  --bg: #f4f6fb;
  --bg-deep: #e9edf5;
  --grid: rgba(15, 23, 42, 0.05);
  --surface-1: rgba(255, 255, 255, 0.55);
  --surface-2: rgba(255, 255, 255, 0.72);
  --surface-3: rgba(255, 255, 255, 0.85);
  --surface-inset: rgba(15, 23, 42, 0.05);

  --border: rgba(15, 23, 42, 0.10);
  --border-bright: rgba(15, 23, 42, 0.20);
  --border-soft: rgba(15, 23, 42, 0.06);

  --text-primary: #1a2233;
  --text-secondary: #455064;
  --text-tertiary: #6b7688;
  --text-faint: #98a1b0;

  --green: #15803d;
  --green-dim: #16a34a;
  --amber: #b45309;
  --amber-dim: #d97706;
  --red: #dc2626;
  --red-dim: #b91c1c;

  --cyan: #4f46e5;
  --magenta: #9333ea;

  --ink: #1a2233;
  --pencil: #6b7688;

  --method-get: #15803d;
  --method-post: #4f46e5;
  --method-put: #b45309;
  --method-patch: #9333ea;
  --method-delete: #dc2626;
  --method-head: #6b7688;
  --method-options: #6b7688;

  --shadow-panel: 0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 8px 24px rgba(15, 23, 42, 0.10);
  --shadow-modal: 0 24px 64px rgba(15, 23, 42, 0.18), 0 0 0 1px rgba(15, 23, 42, 0.06);
  --glow-green: 0 0 8px rgba(21, 128, 61, 0.25);
  --glow-amber: 0 0 8px rgba(180, 83, 9, 0.25);
  --glow-red: 0 0 8px rgba(220, 38, 38, 0.25);
  --glow-cyan: 0 0 8px rgba(79, 70, 229, 0.25);

  --glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.65);

  --bg-gradient: linear-gradient(160deg, #f6f8fc 0%, #eef1f7 55%, #e6ebf4 100%);
  --blob-1: rgba(79, 70, 229, 0.10);
  --blob-2: rgba(147, 51, 234, 0.07);
  --blob-3: rgba(22, 163, 74, 0.06);
  --blob-1-strong: rgba(79, 70, 229, 0.16);
  --blob-2-strong: rgba(147, 51, 234, 0.12);
  --topbar-bg: rgba(246, 248, 252, 0.65);
  --focus-ring: rgba(79, 70, 229, 0.30);
  --amber-wash-top: rgba(217, 119, 6, 0.10);
  --amber-wash-bottom: rgba(217, 119, 6, 0.05);
  --green-wash-top: rgba(22, 163, 74, 0.10);
  --green-wash-bottom: rgba(22, 163, 74, 0.05);
  --panel-bg: rgba(255, 255, 255, 0.50);
  --danger-wash: rgba(220, 38, 38, 0.08);
  --input-focus-bg: rgba(255, 255, 255, 0.8);
  --input-focus-ring: rgba(79, 70, 229, 0.35);
  --log-enter-bg: rgba(79, 70, 229, 0.12);
  --backdrop: rgba(15, 23, 42, 0.35);
  --modal-bg: rgba(255, 255, 255, 0.82);
  --ok-ring: rgba(22, 163, 74, 0.20);
  --err-ring: rgba(220, 38, 38, 0.18);
  --banner-bg: rgba(220, 38, 38, 0.06);
  --expr-error-bg: rgba(220, 38, 38, 0.08);
  --amber-ring: rgba(217, 119, 6, 0.20);
  --dialog-bg: rgba(255, 255, 255, 0.90);
  --dialog-backdrop: rgba(15, 23, 42, 0.30);
  --warning-wash: rgba(217, 119, 6, 0.10);
  --porthdr-bg: rgba(15, 23, 42, 0.04);
  --card-bg: rgba(255, 255, 255, 0.55);
  --card-hover: rgba(255, 255, 255, 0.75);
}
```

另在暗色 `:root` 块开头（`--bg` 之前）加一行 `color-scheme: dark;`（原生控件/滚动条配色提示）。

- [ ] **Step 4: 验证暗色零回归 + 亮色生效**

Run: `pnpm start`，浏览器开 `http://localhost:5050`：
- 无 `data-theme` 或 `dark` 时：界面与改动前**完全一致**（对照截图/肉眼核对首页卡片、详情页、日志面板）
- DevTools 执行 `document.documentElement.dataset.theme = 'light'`：界面整体变亮，无残存深色块（重点看：顶栏、侧边栏、日志面板、端口卡片、设置弹窗、modal 遮罩）
完成后 Ctrl+C。

- [ ] **Step 5: 回归测试**

Run: `pnpm test`
Expected: 全部 PASS（本任务是纯 CSS，测试不应感知）

- [ ] **Step 6: Commit**

```bash
git add public/styles.css
git commit -m "feat: 样式变量提升 + 浅色玻璃亮色变量组"
```

---

### Task 4: editor.js CodeMirror 双主题

**Files:**
- Modify: `public/editor.js`（提取主题对象、加亮色高亮、Compartment 热切换）

**Interfaces:**
- Consumes: 无任务依赖（`@codemirror/state` 的 `Compartment` 已在依赖中）
- Produces（Task 5 依赖）:
  - `setEditorTheme(theme: 'light'|'dark') -> void` — 主编辑器 Compartment 热切换 + 记录当前值供后续 mountReadonlyEditor 使用
  - `mountEditor` / `mountReadonlyEditor` 签名不变

- [ ] **Step 1: 重构 editor.js**

整文件替换 `public/editor.js`：

```js
// CodeMirror 6 bootstrap（双主题：暗色/亮色随应用主题切换）
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';

const host = document.getElementById('responseEditorHost');
let view = null;

// 暗色 JSON 语法高亮（配合 Cinematic Dark Glass 主题；defaultHighlightStyle 是浅色配色）
const darkHighlight = HighlightStyle.define([
  { tag: t.bool, color: '#F5B84C' },
  { tag: t.null, color: '#F87171', fontStyle: 'italic' },
  { tag: t.number, color: '#F5B84C' },
  { tag: t.string, color: '#4ADE80' },
  { tag: t.propertyName, color: '#5E6AD2' },
  { tag: t.punctuation, color: '#5A5F6A' },
]);

// 亮色 JSON 语法高亮（浅色玻璃，与亮底语义色同族加深）
const lightHighlight = HighlightStyle.define([
  { tag: t.bool, color: '#b45309' },
  { tag: t.null, color: '#dc2626', fontStyle: 'italic' },
  { tag: t.number, color: '#b45309' },
  { tag: t.string, color: '#16a34a' },
  { tag: t.propertyName, color: '#4f46e5' },
  { tag: t.punctuation, color: '#98a1b0' },
]);

const darkEditorTheme = {
  '&': { height: '100%', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '13px', lineHeight: '1.65' },
  '.cm-content': { padding: '12px 16px' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(255,255,255,0.08)', color: '#5A5F6A' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8A8F98' },
  '.cm-activeLine': { backgroundColor: 'rgba(94,106,210,0.08)' },
  '.cm-diagnostic-error': { borderLeft: '3px solid #ff5c5c' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid #ffc857' },
};

const lightEditorTheme = {
  ...darkEditorTheme,
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(15,23,42,0.10)', color: '#98a1b0' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#6b7688' },
  '.cm-activeLine': { backgroundColor: 'rgba(79,70,229,0.08)' },
  '.cm-diagnostic-error': { borderLeft: '3px solid #dc2626' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid #d97706' },
};

const darkReadonlyTheme = {
  '&': { backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '12px', lineHeight: '1.6' },
  '.cm-content': { padding: '8px 12px' },
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(255,255,255,0.08)', color: '#5A5F6A' },
};

const lightReadonlyTheme = {
  ...darkReadonlyTheme,
  '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid rgba(15,23,42,0.10)', color: '#98a1b0' },
};

function themeExtensions(theme, readonly) {
  const dark = theme !== 'light';
  return [
    syntaxHighlighting(dark ? darkHighlight : lightHighlight),
    EditorView.theme(dark ? (readonly ? darkReadonlyTheme : darkEditorTheme) : (readonly ? lightReadonlyTheme : lightEditorTheme), { dark }),
  ];
}

// 主编辑器主题热切换；只读查看器（log 详情弹窗）在挂载时取当前值
const themeCompartment = new Compartment();
let currentEditorTheme = 'dark';

/**
 * @param {'light'|'dark'} theme
 */
export function setEditorTheme(theme) {
  currentEditorTheme = theme === 'light' ? 'light' : 'dark';
  if (view) {
    view.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(currentEditorTheme, false)) });
  }
}

/**
 * @param {{ initialValue?: string, onChange?: (text: string) => void, onSelectionChange?: (state: any) => void }} opts
 */
export function mountEditor({ initialValue = '', onChange, onSelectionChange } = {}) {
  if (view) return view;
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && !window.__editorProgrammatic) onChange?.(u.state.doc.toString());
    if (u.selectionSet || u.docChanged) onSelectionChange?.(u.state);
  });

  const state = EditorState.create({
    doc: initialValue,
    extensions: [
      lineNumbers(),
      history(),
      bracketMatching(),
      indentOnInput(),
      json(),
      linter(jsonParseLinter(), { delay: 200 }),
      lintGutter(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      themeCompartment.of(themeExtensions(currentEditorTheme, false)),
      updateListener,
    ],
  });

  view = new EditorView({ state, parent: host });
  return view;
}

export function getValue() {
  return view ? view.state.doc.toString() : '';
}

export function setValue(text) {
  if (!view) return;
  window.__editorProgrammatic = true;
  try {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  } finally {
    queueMicrotask(() => { window.__editorProgrammatic = false; });
  }
}

export function getEditorView() {
  return view;
}

/**
 * Read-only CodeMirror viewer for log detail body. Same lang-json + theme
 * as mountEditor, but no editing surface. Caller is responsible for
 * calling .destroy() on the returned view to free memory.
 *
 * @param {HTMLElement} parent
 * @param {string} text
 * @returns {EditorView}
 */
export function mountReadonlyEditor(parent, text) {
  const state = EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      json(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      ...themeExtensions(currentEditorTheme, true),
    ],
  });
  return new EditorView({ state, parent });
}

window.mountReadonlyEditor = mountReadonlyEditor;
```

- [ ] **Step 2: 验证编辑器双主题**

Run: `pnpm start`，开 `http://localhost:5050`：
- 默认（暗色）：编辑器、日志详情弹窗的 JSON 查看器与改动前一致
- DevTools 执行 `document.documentElement.dataset.theme='light'` + 控制台执行不了 setEditorTheme（模块作用域）——改在 DevTools console 验证挂载期行为：刷新页面前先 `localStorage` 无关，本步只验证暗色零回归；亮色联动在 Task 5 接线后由 Task 7 E2E 断言
Expected: 暗色编辑器视觉无变化，JSON lint/编辑功能正常

- [ ] **Step 3: 回归**

Run: `pnpm test` 与 `pnpm playwright test test/e2e/json-editor.spec.js`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add public/editor.js
git commit -m "feat: CodeMirror 双主题（Compartment 热切换 + 亮色高亮）"
```

---

### Task 5: 设置弹窗主题项 + app.js 接线

**Files:**
- Modify: `public/index.html`（设置弹窗加主题下拉）
- Modify: `public/app.js`（els、openSettings、saveSettings、boot 接线）

**Interfaces:**
- Consumes: Task 1 的 `settings.theme` 持久化；Task 2 的 `applyTheme` / `onThemeChange`；Task 4 的 `setEditorTheme`
- Produces: 设置弹窗 `#settingsTheme` 下拉（值 `system|light|dark`）；保存后 `applyTheme` + PATCH + localStorage 缓存

- [ ] **Step 1: index.html 设置弹窗加主题下拉**

在 `public/index.html` 设置弹窗 `.modal-body` 内、「存储路径」`.field` **之前**插入：

```html
        <div class="field">
          <label for="settingsTheme">主题</label>
          <select id="settingsTheme" class="input">
            <option value="system">跟随系统</option>
            <option value="light">亮色</option>
            <option value="dark">暗色</option>
          </select>
          <p class="field-hint">立即生效。「跟随系统」随系统外观自动切换。</p>
        </div>
```

- [ ] **Step 2: app.js 接线**

`public/app.js`（现有单引号风格保持一致）：

1. 文件顶部 import 区加：

```js
import { applyTheme, onThemeChange } from './theme.js';
import { setEditorTheme } from './editor.js';
```

（若 `editor.js` 的既有 import 已存在，把 `setEditorTheme` 并入该条 import，不重复 import 同模块。）

2. `els` 对象加（紧跟 `maxBodyHint` 行后）：

```js
  theme: $('#settingsTheme'),
```

3. `openSettings()` 在 `els.maxBody.value = ...` 行前加：

```js
  els.theme.value = state.config.settings.theme ?? 'system';
```

4. `saveSettings()` 的 `api.patchConfig({...})` 调用参数加 `theme: els.theme.value`；`state.config = await api.getConfig();` 之后、`closeSettings();` 之前加：

```js
  applyTheme(state.config.settings.theme ?? 'system');
```

5. boot 接线：找到首次加载配置的 `state.config = await api.getConfig();`（init/boot 函数内），在其后加：

```js
  onThemeChange((resolved) => setEditorTheme(resolved));
  applyTheme(state.config.settings.theme ?? 'system');
```

- [ ] **Step 3: 手工验证**

Run: `pnpm start`，开 `http://localhost:5050`：
- 设置 → 主题选「亮色」→ 保存：界面立即变亮（含编辑器）、`document.documentElement.dataset.theme === 'light'`、`localStorage.getItem('mockserver.theme') === 'light'`
- 刷新页面：保持亮色（缓存引导 + 服务端调和）
- 选「跟随系统」保存：macOS 系统外观切换深浅时界面跟随
- 选「暗色」：回到暗色且与 Task 3 之前视觉一致
完成后 Ctrl+C。

- [ ] **Step 4: 回归**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: 设置面板主题选项与主题应用接线"
```

---

### Task 6: 壳一体化（Overlay 标题栏 + 顶栏适配 + 壳内页亮色）

**Files:**
- Modify: `src-tauri/tauri.conf.json`（窗口配置，:11-21）
- Modify: `src-tauri/capabilities/default.json`（加权限）
- Modify: `public/index.html`（顶栏拖拽区）
- Modify: `public/styles.css`（tauri 安全区 + spacer 样式，追加即可）
- Modify: `src-tauri/ui/loading.html`（亮色 media query）
- Modify: `src-tauri/src/sidecar.rs`（overlay_js 改 class + style 块，含 1 个新断言的 cargo 测试更新）

**Interfaces:**
- Consumes: Task 2 的 `html.tauri` class 机制；Task 3 的 styles.css 变量层
- Produces: macOS Overlay 融合栏（无标题文字、红绿灯悬浮）；`core:app:allow-set-theme` 权限（Task 2 的 `__TAURI__.app.setTheme` 依赖它）

- [ ] **Step 1: tauri.conf.json 窗口配置**

`src-tauri/tauri.conf.json` 的 windows 数组项整项替换为：

```json
      {
        "label": "main",
        "title": "",
        "url": "loading.html",
        "width": 1280,
        "height": 800,
        "minWidth": 960,
        "minHeight": 600,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true
      }
```

（`titleBarStyle`/`hiddenTitle` 为 macOS 专用键，Windows 构建忽略，无害。）

- [ ] **Step 2: capabilities 加权限**

`src-tauri/capabilities/default.json` 的 permissions 数组加一条（与 `core:default` 并列）：

```json
    "core:app:allow-set-theme",
```

- [ ] **Step 3: 顶栏拖拽区（index.html）**

`public/index.html` 顶栏：`<div class="brand">` 开标签加 `data-tauri-drag-region` 属性；`.brand` 与 `.topbar-actions` 之间插入：

```html
    <div class="topbar-spacer" data-tauri-drag-region></div>
```

- [ ] **Step 4: 顶栏 CSS（styles.css 末尾追加）**

```css
/* Tauri 桌面壳：Overlay 标题栏融合（红绿灯安全区 + 拖拽区） */
.topbar-spacer {
  flex: 1;
  align-self: stretch;
}

html.tauri .topbar {
  padding-left: 78px;
}

html.tauri .brand {
  align-self: stretch;
  display: flex;
  align-items: center;
}
```

- [ ] **Step 5: loading.html 亮色分支**

`src-tauri/ui/loading.html` 内联 `<style>` 末尾（`pre {…}` 规则之后）追加：

```css
  @media (prefers-color-scheme: light) {
    body { background: #f4f6fb; color: #1a2233; }
    .spinner { border-color: #d5dbea; border-top-color: #4f46e5; }
    .sub { color: #6b7688; }
    pre { color: #455064; background: #e9edf5; }
  }
```

- [ ] **Step 6: sidecar.rs overlay_js 改 class + style 块**

`src-tauri/src/sidecar.rs` 的 `overlay_js` 函数整函数替换为（内联 style 属性无法写 media query，改 class + `<style>` 块）：

```rust
/// 在当前页面（任意 origin）内嵌一个全屏错误/状态覆盖层
/// 覆盖层读不到应用设置，跟随系统外观（spec §6）
pub fn overlay_js(title: &str, detail: &str) -> String {
    let html = format!(
        "<div class=\"mock-overlay\"><h1>{}</h1><pre>{}</pre><p>可从系统托盘菜单「重启服务」恢复</p></div>\
<style>\
.mock-overlay{{font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0b1020;color:#e6e9f2;text-align:center;padding:24px;box-sizing:border-box}}\
.mock-overlay h1{{font-size:20px;margin:0 0 12px}}\
.mock-overlay pre{{max-width:80%;max-height:40vh;overflow:auto;white-space:pre-wrap;color:#9aa3b2;font-size:12px;text-align:left;background:#11162a;padding:12px;border-radius:8px}}\
.mock-overlay p{{color:#9aa3b2;font-size:13px}}\
@media (prefers-color-scheme: light){{\
.mock-overlay{{background:#f4f6fb;color:#1a2233}}\
.mock-overlay pre{{color:#455064;background:#e9edf5}}\
.mock-overlay p{{color:#6b7688}}\
}}\
</style>",
        html_escape(title),
        html_escape(detail)
    );
    format!("document.body.innerHTML = {};", serde_json::to_string(&html).unwrap())
}
```

在 `overlay_js_escapes_injected_content` 测试后追加一个用例：

```rust
    #[test]
    fn overlay_js_includes_light_media_query() {
        let js = overlay_js("t", "d");
        assert!(js.contains("prefers-color-scheme: light"));
    }
```

- [ ] **Step 7: 验证**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS（8 个测试，原有 7 个不受影响——starts_with/转义断言仍成立）

Run: `pnpm tauri dev`
Expected（macOS）：窗口无标题文字；红绿灯悬浮在顶栏左上（顶栏 logo 不被遮挡，左侧已留 78px）；拖动 logo 区/中部空白可移动窗口；右侧按钮（启动/设置）正常点击不触发拖拽；设置里切亮色 → 整窗含顶端栏区一起变亮；切暗色 → 整体变暗。确认后 Ctrl+C。

- [ ] **Step 8: 回归**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 9: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/capabilities/default.json public/index.html public/styles.css src-tauri/ui/loading.html src-tauri/src/sidecar.rs
git commit -m "feat: macOS Overlay 融合标题栏 + 壳内嵌页面亮色适配"
```

---

### Task 7: E2E 主题测试 + embed-assets 同步 + 全量回归 + 桌面验收

**Files:**
- Create: `test/e2e/theme.spec.js`
- Sync: `embed-assets/public/`（rsync 自 `public/`）

**Interfaces:**
- Consumes: Task 1-6 全部（设置持久化、applyTheme、亮色 CSS、editor 双主题、壳一体化）
- Produces: 无新接口；交付物 = 全绿测试套件 + 同步后的 embed-assets + 桌面手工验收记录

- [ ] **Step 1: 写 E2E**

先读 `test/e2e/helpers.js`（bootServer 用法）与 `test/e2e/port-cards.spec.js`（设置面板/页面断言的既有模式），然后新建 `test/e2e/theme.spec.js`：

```js
import { test, expect } from '@playwright/test';
import { bootServer } from './helpers.js';

let server;

test.beforeAll(async () => {
  server = await bootServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

async function setTheme(page, value) {
  await page.click('#settingsBtn');
  await page.selectOption('#settingsTheme', value);
  await page.click('#settingsSave');
  await page.waitForSelector('#settingsModal', { state: 'hidden' });
}

test('设置面板切换亮色/暗色并写入缓存', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });

  await setTheme(page, 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('mockserver.theme'))).toBe('light');
  // CodeMirror 联动：gutter 边框切换为亮色值
  const gutterBorder = await page.evaluate(() => {
    const g = document.querySelector('.cm-gutters');
    return g ? getComputedStyle(g).borderRightColor : null;
  });
  expect(gutterBorder).toBe('rgba(15, 23, 42, 0.1)');

  await setTheme(page, 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('mockserver.theme'))).toBe('dark');
});

test('跟随系统：emulateMedia 切换系统外观时界面跟随', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await setTheme(page, 'system');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('刷新后主题保持（服务端持久化 + 缓存引导）', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await setTheme(page, 'dark');
  await page.reload({ waitUntil: 'load' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // 还原为 system，避免影响同文件其他用例与本地状态
  await setTheme(page, 'system');
});
```

- [ ] **Step 2: 跑 E2E 确认通过**

Run: `pnpm playwright test test/e2e/theme.spec.js`
Expected: PASS（3 个用例，headed）

注：用例 1 的 gutter 断言要求页面上编辑器已挂载（详情页才有编辑器）。若首页无 `.cm-gutters`，先在测试里进入一个端口详情页（参考 `test/e2e/port-detail.spec.js` 的 `enterPortDetail` helper 用法），或断言降级为 `document.querySelector('.cm-gutters')` 存在性 + 主题切换后再断言颜色。以实现时页面实际结构为准，但「亮色下 gutter 边框为 rgba(15, 23, 42, 0.1)」这个行为断言必须保留（它验证 editor 联动真实生效）。

- [ ] **Step 3: embed-assets 同步（关键不变量 #5）**

Run: `rsync -a --delete public/ embed-assets/public/ && git status --short embed-assets | head -20`
Expected: embed-assets/public 下 styles.css / index.html / app.js / editor.js / theme.js 与 public/ 一致（`diff -r public embed-assets/public` 无输出）

- [ ] **Step 4: 全量回归**

Run: `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml`
Expected: vitest 全过、cargo 8/8

Run: `pnpm test:e2e`
Expected: 全部 E2E PASS（headed，含新 theme.spec.js）

- [ ] **Step 5: 桌面手工验收**

Run: `pnpm sidecar:prepare && pnpm tauri dev`，逐项验收（对应 spec §7）：

1. Overlay 栏：无标题文字、红绿灯悬浮、不遮挡 logo 与按钮
2. 拖拽：logo 区/中部空白可拖动窗口；启动/设置按钮正常点击
3. 主题切换：设置 → 亮色 → 整窗（含顶端栏区、编辑器、弹窗）一致变亮；暗色同理
4. 跟随系统：选「跟随系统」后切换 macOS 系统外观，窗口（含 loading 页）跟随
5. 亮色巡查：首页卡片、详情页、日志面板、日志详情弹窗、设置弹窗、生成器面板无残存深色块
6. 关窗隐藏 → 托盘恢复 → 主题状态保持
7. `pnpm build:desktop` 出 dmg 冒烟一次（确认 embed-assets 同步进包）

- [ ] **Step 6: Commit**

```bash
git add test/e2e/theme.spec.js embed-assets/public
git commit -m "test: 主题系统 E2E + embed-assets 同步"
```

---

## 自查记录（plan 作者填写）

- **Spec 覆盖**：§3 主题架构 → Task 2/3；§3.3 theme.js → Task 2；§4.1 后端 → Task 1；§4.2 弹窗 → Task 5；§4.3 防闪烁 → Task 2 Step 4；§5.1 Overlay → Task 6 Step 1；§5.2 顶栏适配 → Task 6 Step 3/4；§5.3 Windows 染色权限 → Task 6 Step 2（setTheme 调用在 Task 2 theme.js 内）；§5.4 零联动 → 无 backgroundColor/command（计划全文未引入，符合）；§6 壳内页 → Task 6 Step 5/6；§7 测试 → Task 1/2 单测集成、Task 7 E2E 与手工清单；不变量 #5 同步 → Task 7 Step 3
- **spec 外发现已纳入**：editor.js 硬编码暗色 CodeMirror 主题（spec 未提，漏了亮色下编辑器仍是深色）→ Task 4 + Task 7 E2E 的 gutter 断言
- **类型一致性**：`resolveTheme(setting, prefersDark)`、`applyTheme(setting)`、`onThemeChange(fn)`、`setEditorTheme(theme)` 在 Task 2/4 定义，Task 5 按此调用；localStorage 键 `mockserver.theme` 三处（theme.js / index.html 引导 / E2E 断言）一致
