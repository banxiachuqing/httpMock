# 接口管理页布局改造 + Apple Liquid Glass 全局换皮 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HTTP 接口管理页操作按钮上移（删除固定最右、去掉底部按钮条、小窗口可滚动），全应用视觉换皮为 Apple Liquid Glass（双主题 token 重写 + 液态感动效）。

**Architecture:** 纯前端改动。布局只动 `public/index.html` 的 HTTP 编辑区 DOM（按钮 ID 不变，JS 零改动）；换皮只重写 `public/styles.css` 两个主题变量块（`:root` 暗色 / `:root[data-theme="light"]` 亮色）+ 少量共享组件（`.btn` 一族、backdrop-filter、光斑背景层、滚动容器）。CodeMirror 内部保持实底。

**Tech Stack:** 原生 ESM + 零构建前端、CSS 变量双主题（`data-theme`）、Playwright headed E2E、vitest。

**规格依据:** `docs/superpowers/specs/2026-08-16-liquid-glass-redesign-design.md`（commit 58a1518）
**视觉参照:** `.superpowers/brainstorm/368-1786887521/content/style-apple-glass.html`（已确认的亮/暗 mockup，颜色取值的最终依据）

## Global Constraints

- 按钮 ID 不得改变（`#deleteBtn`/`#revertBtn`/`#saveBtn`），`app.js` 零改动
- WS 详情页的 `.editor-footer` CSS 规则与 DOM 保留——只删 HTTP 表单的底部按钮条 DOM 节点
- CSS 变量名不改，只重写两个主题块的**值**；组件层规则除本计划列出的以外不动
- 编辑器内部实底（暗 `rgba(0,0,0,.35)` / 亮 `#FFFFFF`，token `--editor-bg`），不加玻璃、不加 hover 动效
- 每次修改 `public/` 后必须同步 `embed-assets/`（CLAUDE.md 不变量 #5），在 Task 5 统一执行
- E2E 必须前台运行（`playwright.config.js` 固定 `headless: false`，不得切 headless）
- 提交信息用 conventional commits（feat/fix/style/test/chore），不加 Attribution（全局禁用）
- `prefers-reduced-motion: reduce` 下关闭 transform/filter 动效
- 端口占用约定：E2E 新用例用 17508（17501–17507 已被 port-detail.spec.js 占用，18790 被 ws-happy-path 占用）

## File Structure

| 文件 | 改动 | 责任 |
|---|---|---|
| `public/index.html` | 修改 | HTTP 编辑区按钮 DOM 移动（Task 2） |
| `public/styles.css` | 修改 | 滚动容器 + `.header-sep`（Task 2）；双主题 token 块重写 + 光斑 + saturate + 编辑器实底（Task 3）；`.btn` 一族 + 液态 hover + reduced-motion（Task 4） |
| `public/editor.js` | 修改 | CodeMirror activeLine 色调跟随新主色（Task 3） |
| `test/e2e/port-detail.spec.js` | 修改 | 新增布局意图断言（Task 1） |
| `test/e2e/ws-happy-path.spec.js` | 修改 | 新增 WS 底部条守护断言（Task 1） |
| `embed-assets/public/{index.html,styles.css,editor.js}` | 同步 | 编译产物一致性（Task 5） |

`src/`（后端）与 `src-tauri/` 零改动。

---

### Task 1: E2E 布局意图断言（RED）

**Files:**
- Modify: `test/e2e/port-detail.spec.js`（追加一个 test）
- Modify: `test/e2e/ws-happy-path.spec.js`（插入一行断言）

**Interfaces:**
- Consumes: 无
- Produces: 两条失败用例，驱动 Task 2；用例名与断言点是 Task 2 的验收标准

- [ ] **Step 1: 在 port-detail.spec.js 末尾追加布局意图用例**

在 `test/e2e/port-detail.spec.js` 文件末尾（最后一个 `test(...)` 之后）追加：

```js
test('操作按钮在编辑区顶部，删除在最右', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await setup(page, 17508);
  await enterPortDetail(page, server.baseURL, 17508);
  await page.locator('.endpoint-item').first().dispatchEvent('click');

  // 意图 1+2：保存/删除落在顶部 .editor-header 区域内，且删除在保存右侧
  const headerBox = await page.locator('.editor-header').boundingBox();
  const saveBox = await page.locator('#saveBtn').boundingBox();
  const deleteBox = await page.locator('#deleteBtn').boundingBox();
  expect(headerBox).toBeTruthy();
  expect(saveBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
  expect(deleteBox.y).toBeGreaterThanOrEqual(headerBox.y);
  expect(deleteBox.y + deleteBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
  expect(deleteBox.x).toBeGreaterThan(saveBox.x);

  // 意图 3：HTTP 底部按钮条已移除
  await expect(page.locator('.editor-form > .editor-footer')).toHaveCount(0);
});
```

- [ ] **Step 2: 在 ws-happy-path.spec.js 插入 WS 底部条守护断言**

在 `test/e2e/ws-happy-path.spec.js` 中找到：

```js
  await page.waitForSelector('#wsEditorForm:not([hidden])');
```

在它**后面**插入一行：

```js
  // 守护：布局改造只删 HTTP 页底部条，WS 服务详情保留（spec 2026-08-16 §6）
  await expect(page.locator('.editor-footer')).toBeVisible();
```

- [ ] **Step 3: 运行新用例，确认 RED**

Run: `pnpm playwright test test/e2e/port-detail.spec.js -g "操作按钮在编辑区顶部"`
Expected: FAIL——`#saveBtn` 目前在底部 `.editor-footer` 里，boundingBox 不在 `.editor-header` 区域内。

Run: `pnpm playwright test test/e2e/ws-happy-path.spec.js`
Expected: PASS（WS 底部条现在就在，守护断言此刻就该绿——它防止后续任务误删 WS 的 DOM）。若此用例失败，说明插入位置错了（必须在 `#wsEditorForm` 可见之后）。

- [ ] **Step 4: Commit**

```bash
git add test/e2e/port-detail.spec.js test/e2e/ws-happy-path.spec.js
git commit -m "test: 接口管理页按钮布局意图断言 + WS 底部条守护（RED）"
```

---

### Task 2: 按钮上移 + 去底部条 + 小窗口滚动（GREEN）

**Files:**
- Modify: `public/index.html:193-201`（HTTP `.editor-header-right`）与 `public/index.html:290-295`（HTTP `.editor-footer`）
- Modify: `public/styles.css:804-809`（`.editor-form`）、`public/styles.css:811-820`（`.editor-header` 区）、`public/styles.css:885-891`（`.editor-body`）

**Interfaces:**
- Consumes: Task 1 的失败用例
- Produces: 布局改造完成；`app.js` 不感知（按钮 ID 不变）；Task 3/4 的 token 改动叠加在此 DOM 上

**注意（共享类的已知影响）：** `.editor-form` / `.editor-body` 类也被 WS 编辑表单使用，滚动行为会同样作用于 WS 表单——这是预期的一致性收益，WS 的 DOM 与底部按钮条不动。

- [ ] **Step 1: 移动 index.html 的 HTTP 编辑区按钮**

Edit `public/index.html`，替换：

```html
          <div class="editor-header-right">
            <span class="last-saved mono" id="lastSaved">已保存</span>
          </div>
```

为：

```html
          <div class="editor-header-right">
            <span class="last-saved mono" id="lastSaved">已保存</span>
            <button class="btn btn-ghost btn-sm" id="revertBtn">撤销</button>
            <button class="btn btn-primary btn-sm" id="saveBtn">保存</button>
            <span class="header-sep" aria-hidden="true"></span>
            <button class="btn btn-danger btn-sm" id="deleteBtn">删除</button>
          </div>
```

（该字符串在文件中唯一；WS 的 header-right 内容不同，不会误配。）

- [ ] **Step 2: 删除 HTTP 底部按钮条**

Edit `public/index.html`，删除整块（含前后空行收敛为一个）：

```html
        <div class="editor-footer">
          <button class="btn btn-danger" id="deleteBtn">删除</button>
          <div class="spacer"></div>
          <button class="btn btn-ghost" id="revertBtn">撤销</button>
          <button class="btn btn-primary" id="saveBtn">保存</button>
        </div>
```

该块在文件中唯一（WS 的 footer 里是 `wsDeleteOpBtn`/`wsRevertBtn`/`wsSaveOpBtn`，不同）。`.editor-footer` 的 CSS 规则**保留**（WS 在用）。

- [ ] **Step 3: styles.css 加 `.header-sep`**

在 `public/styles.css` 的 `.endpoint-id { letter-spacing: 0.04em; }`（约 820 行）之后追加：

```css
/* 顶部操作区：常规操作与危险操作的分隔线（spec 2026-08-16 §3.1） */
.header-sep {
  width: 1px;
  height: 16px;
  background: var(--border-bright);
  margin: 0 var(--s-1);
}
```

- [ ] **Step 4: styles.css 小窗口滚动**

Edit `public/styles.css`，`.editor-form` 规则（约 804 行）：

```css
.editor-form {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
```

改为：

```css
.editor-form {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}
```

`.editor-body` 规则（约 885 行）：

```css
.editor-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: var(--s-4) var(--s-6);
  min-height: 0;
}
```

改为：

```css
.editor-body {
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  padding: var(--s-4) var(--s-6);
  /* 不低于可用编辑高度（toolbar ~35 + split min 360 + padding 32）；容器更矮时由 .editor-form 滚动 */
  min-height: 430px;
}
```

- [ ] **Step 5: 运行测试，确认 GREEN**

Run: `pnpm playwright test test/e2e/port-detail.spec.js`
Expected: 全部 PASS（新布局用例转绿；既有用例按 ID 点按钮，不受 DOM 位置影响）。

Run: `pnpm playwright test test/e2e/ws-happy-path.spec.js`
Expected: PASS（含 Task 1 的守护断言）。

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css
git commit -m "feat: 端点操作按钮上移编辑区顶部，删除固定最右，去除底部按钮条"
```

---

### Task 3: 双主题 token 重写（Apple Liquid Glass 质感）

**Files:**
- Modify: `public/styles.css:6-125`（`:root` 暗色块整体替换）
- Modify: `public/styles.css:1877-1957`（`:root[data-theme="light"]` 块整体替换）
- Modify: `public/styles.css:160-163`（body 光斑背景层加第 4 层）
- Modify: `public/styles.css` 全部 `backdrop-filter` 玻璃位点（加 saturate）
- Modify: `public/styles.css:940`（`.code-editor-wrap` 背景 → `--editor-bg`）+ 追加亮色输入控件补丁
- Modify: `public/editor.js:44,53`（activeLine 色调）

**Interfaces:**
- Consumes: Task 2 的 DOM（按钮已在顶部）
- Produces: `--glass-saturate` / `--editor-bg` / `--accent-fill` / `--accent-fill-shadow` / `--danger-fill-bg` / `--danger-fill-border` / `--blob-4` 等新 token，Task 4 的按钮族会消费它们

- [ ] **Step 1: 整体替换 `:root` 暗色块**

Edit `public/styles.css`，把从 `:root {`（第 6 行）到其闭合 `}`（第 125 行，`--ease-out` 之后的 `}`）整块替换为：

```css
:root {
  color-scheme: dark;

  /* Surfaces — Apple Liquid Glass（暗） */
  --bg: #101014;
  --bg-deep: #0a0a0e;
  --grid: rgba(255, 255, 255, 0.035);
  --surface-1: rgba(40, 40, 50, 0.45);   /* glass panel */
  --surface-2: rgba(48, 48, 60, 0.55);   /* elevated glass */
  --surface-3: rgba(58, 58, 72, 0.65);   /* hover glass */
  --surface-inset: rgba(0, 0, 0, 0.30);  /* inset field */
  --editor-bg: rgba(0, 0, 0, 0.35);      /* 编辑器实底（spec §4.2） */

  /* Borders — hairline */
  --border: rgba(255, 255, 255, 0.12);
  --border-bright: rgba(255, 255, 255, 0.22);
  --border-soft: rgba(255, 255, 255, 0.08);

  /* Text（Apple dark） */
  --text-primary: #F5F5F7;
  --text-secondary: #A1A1A6;
  --text-tertiary: #98989D;
  --text-faint: #6C6C70;

  /* Signal lights（iOS dark） */
  --green: #30D158;
  --green-dim: #248A3D;
  --amber: #FFD60A;
  --amber-dim: #B25000;
  --red: #FF453A;
  --red-dim: #C41E3A;

  /* Accents（Apple Blue / iOS 紫） */
  --cyan: #0A84FF;
  --magenta: #BF5AF2;

  /* Preview JSON syntax (semantic keys) */
  --ink: #F5F5F7;
  --pencil: #98989D;

  /* Method colors（iOS dark 色板） */
  --method-get: #30D158;
  --method-post: #0A84FF;
  --method-put: #FFD60A;
  --method-patch: #BF5AF2;
  --method-delete: #FF453A;
  --method-head: #98989D;
  --method-options: #98989D;

  /* Shadows / glows */
  --shadow-panel: 0 1px 0 rgba(255, 255, 255, 0.10) inset, 0 4px 18px rgba(0, 0, 0, 0.30);
  --shadow-modal: 0 24px 64px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.12);
  --glow-green: 0 0 8px rgba(48, 209, 88, 0.55);
  --glow-amber: 0 0 8px rgba(255, 214, 10, 0.45);
  --glow-red: 0 0 8px rgba(255, 69, 58, 0.50);
  --glow-cyan: 0 0 8px rgba(10, 132, 255, 0.55);

  /* Glass */
  --glass-blur: 20px;
  --glass-saturate: 180%;
  --glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.12);

  /* Accent fills（胶囊按钮用，Task 4 消费） */
  --accent-fill: #0A84FF;
  --accent-fill-shadow: rgba(10, 132, 255, 0.45);
  --danger-fill-bg: rgba(255, 69, 58, 0.14);
  --danger-fill-border: rgba(255, 69, 58, 0.40);

  /* Theme-sensitive composites (hoisted from component rules) */
  --bg-gradient: #101014;
  --blob-1: rgba(10, 132, 255, 0.28);
  --blob-2: rgba(191, 90, 242, 0.20);
  --blob-3: rgba(48, 209, 88, 0.12);
  --blob-4: rgba(255, 55, 95, 0.08);
  --blob-1-strong: rgba(10, 132, 255, 0.35);
  --blob-2-strong: rgba(191, 90, 242, 0.25);
  --topbar-bg: rgba(30, 30, 38, 0.5);
  --focus-ring: rgba(10, 132, 255, 0.40);
  --amber-wash-top: rgba(255, 214, 10, 0.16);
  --amber-wash-bottom: rgba(255, 214, 10, 0.08);
  --green-wash-top: rgba(48, 209, 88, 0.16);
  --green-wash-bottom: rgba(48, 209, 88, 0.08);
  --panel-bg: rgba(40, 40, 50, 0.45);
  --danger-wash: rgba(255, 69, 58, 0.12);
  --input-focus-bg: rgba(0, 0, 0, 0.40);
  --input-focus-ring: rgba(10, 132, 255, 0.45);
  --log-enter-bg: rgba(10, 132, 255, 0.18);
  --backdrop: rgba(0, 0, 0, 0.55);
  --modal-bg: rgba(28, 28, 34, 0.82);
  --ok-ring: rgba(48, 209, 88, 0.22);
  --err-ring: rgba(255, 69, 58, 0.22);
  --banner-bg: rgba(255, 69, 58, 0.07);
  --expr-error-bg: rgba(255, 69, 58, 0.10);
  --amber-ring: rgba(255, 214, 10, 0.18);
  --dialog-bg: rgba(28, 28, 34, 0.88);
  --dialog-backdrop: rgba(0, 0, 0, 0.55);
  --warning-wash: rgba(255, 214, 10, 0.12);
  --porthdr-bg: rgba(255, 255, 255, 0.06);
  --card-bg: rgba(40, 40, 50, 0.45);
  --card-hover: rgba(48, 48, 60, 0.58);

  /* Typography（Apple 系字体优先） */
  --font-sans: -apple-system, 'SF Pro Text', 'Inter', 'Noto Sans SC', system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

  /* Spacing */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 20px;
  --s-6: 24px;
  --s-8: 32px;
  --s-10: 40px;
  --s-12: 48px;

  /* Radii（Apple Glass 大圆角） */
  --r-0: 0;
  --r-1: 10px;
  --r-2: 14px;
  --r-3: 20px;

  /* Motion */
  --d-fast: 140ms;
  --d-norm: 220ms;
  --d-slow: 360ms;
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

- [ ] **Step 2: 整体替换亮色覆盖块**

Edit `public/styles.css`，把 `:root[data-theme="light"] {`（约 1877 行）到其闭合 `}`（约 1957 行）整块替换为：

```css
:root[data-theme="light"] {
  color-scheme: light;

  /* Surfaces — Apple Liquid Glass（亮） */
  --bg: #F5F5F7;
  --bg-deep: #ECECF0;
  --grid: rgba(15, 15, 20, 0.045);
  --surface-1: rgba(255, 255, 255, 0.50);
  --surface-2: rgba(255, 255, 255, 0.62);
  --surface-3: rgba(255, 255, 255, 0.78);
  --surface-inset: rgba(255, 255, 255, 0.80);
  --editor-bg: #FFFFFF;

  /* 面板/卡片用白亮边（mockup）；输入控件的浅黑边见本块末尾补丁 */
  --border: rgba(255, 255, 255, 0.65);
  --border-bright: rgba(255, 255, 255, 0.90);
  --border-soft: rgba(15, 15, 20, 0.07);

  --text-primary: #1D1D1F;
  --text-secondary: #48484A;
  --text-tertiary: #6E6E73;
  --text-faint: #8E8E93;

  --green: #34C759;
  --green-dim: #248A3D;
  --amber: #FF9500;
  --amber-dim: #B25000;
  --red: #FF3B30;
  --red-dim: #C41E3A;

  --cyan: #0071E3;
  --magenta: #AF52DE;

  --ink: #1D1D1F;
  --pencil: #6E6E73;

  --method-get: #34C759;
  --method-post: #0071E3;
  --method-put: #FF9500;
  --method-patch: #AF52DE;
  --method-delete: #FF3B30;
  --method-head: #6E6E73;
  --method-options: #6E6E73;

  --shadow-panel: 0 1px 0 rgba(255, 255, 255, 0.70) inset, 0 4px 16px rgba(0, 0, 0, 0.06);
  --shadow-modal: 0 24px 64px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(255, 255, 255, 0.60);
  --glow-green: 0 0 8px rgba(52, 199, 89, 0.35);
  --glow-amber: 0 0 8px rgba(255, 149, 0, 0.30);
  --glow-red: 0 0 8px rgba(255, 59, 48, 0.30);
  --glow-cyan: 0 0 8px rgba(0, 113, 227, 0.30);

  --glass-highlight: inset 0 1px 0 rgba(255, 255, 255, 0.70);

  --bg-gradient: #F5F5F7;
  --blob-1: rgba(0, 122, 255, 0.22);
  --blob-2: rgba(255, 45, 85, 0.13);
  --blob-3: rgba(88, 86, 214, 0.18);
  --blob-4: rgba(52, 199, 89, 0.12);
  --blob-1-strong: rgba(0, 122, 255, 0.20);
  --blob-2-strong: rgba(255, 45, 85, 0.14);
  --topbar-bg: rgba(255, 255, 255, 0.55);
  --focus-ring: rgba(0, 113, 227, 0.30);
  --amber-wash-top: rgba(255, 149, 0, 0.14);
  --amber-wash-bottom: rgba(255, 149, 0, 0.07);
  --green-wash-top: rgba(52, 199, 89, 0.14);
  --green-wash-bottom: rgba(52, 199, 89, 0.07);
  --panel-bg: rgba(255, 255, 255, 0.50);
  --danger-wash: rgba(255, 59, 48, 0.10);
  --input-focus-bg: rgba(255, 255, 255, 0.90);
  --input-focus-ring: rgba(0, 113, 227, 0.35);
  --log-enter-bg: rgba(0, 113, 227, 0.10);
  --backdrop: rgba(0, 0, 0, 0.25);
  --modal-bg: rgba(255, 255, 255, 0.82);
  --ok-ring: rgba(52, 199, 89, 0.25);
  --err-ring: rgba(255, 59, 48, 0.22);
  --banner-bg: rgba(255, 59, 48, 0.06);
  --expr-error-bg: rgba(255, 59, 48, 0.08);
  --amber-ring: rgba(255, 149, 0, 0.22);
  --dialog-bg: rgba(255, 255, 255, 0.90);
  --dialog-backdrop: rgba(0, 0, 0, 0.20);
  --warning-wash: rgba(255, 149, 0, 0.12);
  --porthdr-bg: rgba(255, 255, 255, 0.50);
  --card-bg: rgba(255, 255, 255, 0.50);
  --card-hover: rgba(255, 255, 255, 0.70);

  --accent-fill: #0071E3;
  --accent-fill-shadow: rgba(0, 113, 227, 0.35);
  --danger-fill-bg: rgba(255, 59, 48, 0.10);
  --danger-fill-border: rgba(255, 59, 48, 0.30);
}

/* 亮色主题：输入控件保留浅黑细边（面板用白亮边，见 --border；spec §4.3） */
:root[data-theme="light"] .input,
:root[data-theme="light"] .select {
  border-color: rgba(15, 15, 20, 0.08);
}
:root[data-theme="light"] .select option {
  background: #ffffff;
}
```

（第二条补丁修复既有硬编码 `.select option { background: #12121a }` 在亮色下的下拉黑底问题。）

- [ ] **Step 3: body 光斑背景层扩为 4 层**

Edit `public/styles.css`（约 160-163 行），替换：

```css
  background-image:
    radial-gradient(ellipse 60% 40% at 15% 0%, var(--blob-1), transparent 60%),
    radial-gradient(ellipse 50% 35% at 90% 10%, var(--blob-2), transparent 60%),
    radial-gradient(ellipse 55% 45% at 70% 100%, var(--blob-3), transparent 60%);
```

为：

```css
  background-image:
    radial-gradient(ellipse 60% 40% at 15% 0%, var(--blob-1), transparent 60%),
    radial-gradient(ellipse 50% 35% at 90% 10%, var(--blob-2), transparent 60%),
    radial-gradient(ellipse 55% 45% at 70% 100%, var(--blob-3), transparent 60%),
    radial-gradient(ellipse 45% 35% at 10% 90%, var(--blob-4), transparent 60%);
```

- [ ] **Step 4: 所有玻璃位点加 saturate**

对 `public/styles.css` 执行 4 次全文替换（Edit `replace_all: true`）：

1. `backdrop-filter: blur(var(--glass-blur));` → `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));`（5 处：topbar 288、sidebar 544、logs 999、port-card 区 1728/1753）
2. `-webkit-backdrop-filter: blur(var(--glass-blur));` → `-webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));`（同 5 处）
3. `backdrop-filter: blur(24px);` → `backdrop-filter: blur(24px) saturate(var(--glass-saturate));`（2 处：modal 1210、dialog 1605）
4. `-webkit-backdrop-filter: blur(24px);` → `-webkit-backdrop-filter: blur(24px) saturate(var(--glass-saturate));`（同 2 处）

**不要动** `blur(4px)` 的两处（1199/1618）——那是遮罩层，不需要 saturate。

- [ ] **Step 5: 编辑器实底**

Edit `public/styles.css` 的 `.code-editor-wrap`（约 937-946 行）中的：

```css
  background: var(--surface-inset);
```

改为：

```css
  background: var(--editor-bg);
```

（该字符串在文件中应只出现这一次；如有多处，仅改 `.code-editor-wrap` 块内的。）

Edit `public/editor.js`，两次全文替换：

1. `rgba(94,106,210,0.08)` → `rgba(10,132,255,0.08)`（暗色 activeLine 跟随新主色 Apple 蓝）
2. `rgba(79,70,229,0.08)` → `rgba(0,113,227,0.08)`（亮色 activeLine）

- [ ] **Step 6: 回归验证**

Run: `pnpm test`
Expected: PASS（无后端改动，门槛验证）。

Run: `pnpm test:e2e`
Expected: 全部 PASS（含 theme.spec.js 的双主题切换断言——token 重写不得破坏 `data-theme` 机制）。

- [ ] **Step 7: Commit**

```bash
git add public/styles.css public/editor.js
git commit -m "style: 双主题 token 重写为 Apple Liquid Glass 质感"
```

---

### Task 4: 胶囊按钮族 + 液态感动效

**Files:**
- Modify: `public/styles.css:439-525`（`.btn` 一族整体替换）
- Modify: `public/styles.css` 文件末尾（追加液态 hover 与 reduced-motion 区块）

**Interfaces:**
- Consumes: Task 3 的 `--accent-fill` / `--accent-fill-shadow` / `--danger-fill-bg` / `--danger-fill-border` / `--glass-highlight` / `--shadow-panel`
- Produces: 最终按钮形态与动效；Task 5 同步后即为交付状态

- [ ] **Step 1: 整体替换 `.btn` 一族**

Edit `public/styles.css`，把从 `.btn {`（约 439 行）到 `.btn-danger:hover { ... }`（约 525 行）整块替换为（保留紧随其后的 `.plus { ... }` 不动）：

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  height: 30px;
  padding: 0 var(--s-3);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  background: var(--surface-2);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 999px; /* Apple Glass 胶囊按钮（spec §4.4） */
  transition: background var(--d-fast) var(--ease), border-color var(--d-fast) var(--ease), color var(--d-fast) var(--ease), transform var(--d-fast) var(--ease), filter var(--d-fast) var(--ease), box-shadow var(--d-fast) var(--ease);
  white-space: nowrap;
}
.btn:hover { background: var(--surface-3); border-color: var(--border-bright); transform: scale(1.02); }
.btn:active { transform: scale(0.97); }
.btn:focus-visible {
  border-color: var(--cyan);
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.btn-sm { height: 24px; padding: 0 var(--s-2); font-size: 11px; }

.btn-ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text-secondary);
}
.btn-ghost:hover { color: var(--text-primary); background: var(--surface-2); }

.btn-icon {
  width: 30px;
  padding: 0;
  background: transparent;
  color: var(--text-secondary);
  border-color: var(--border);
}
.btn-icon:hover { color: var(--text-primary); background: var(--surface-2); }

/* 主操作：实心蓝胶囊；data-state 变体（启动/停止按钮三态）保留 wash 样式覆盖之 */
.btn-primary {
  background: var(--accent-fill);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
  box-shadow: 0 1px 4px var(--accent-fill-shadow);
  position: relative;
  overflow: hidden;
}
.btn-primary:hover { background: var(--accent-fill); border-color: transparent; filter: brightness(1.08); }
.btn-primary .btn-led {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.6);
}
.btn-primary[data-state="stopped"] {
  background: linear-gradient(to bottom, var(--amber-wash-top), var(--amber-wash-bottom));
  border-color: var(--amber-dim);
  color: var(--amber);
  box-shadow: none;
}
.btn-primary[data-state="stopped"] .btn-led { background: var(--amber); box-shadow: var(--glow-amber); }
.btn-primary[data-state="stopped"]:hover { border-color: var(--amber); filter: brightness(1.05); }

.btn-primary[data-state="starting"] {
  background: linear-gradient(to bottom, var(--amber-wash-top), var(--amber-wash-bottom));
  border-color: var(--amber);
  color: var(--amber);
  box-shadow: none;
}
.btn-primary[data-state="starting"] .btn-led {
  animation: ledPulse 0.5s ease-in-out infinite;
}

.btn-primary[data-state="running"] {
  background: linear-gradient(to bottom, var(--green-wash-top), var(--green-wash-bottom));
  border-color: var(--green-dim);
  color: var(--green);
  box-shadow: none;
}
.btn-primary[data-state="running"] .btn-led { background: var(--green); box-shadow: var(--glow-green); animation: ledPulse 2s ease-in-out infinite; }
.btn-primary[data-state="running"]:hover { border-color: var(--green); filter: brightness(1.05); }

/* 危险操作：红色玻璃胶囊 */
.btn-danger {
  color: var(--red);
  background: var(--danger-fill-bg);
  border-color: var(--danger-fill-border);
}
.btn-danger:hover { background: var(--danger-fill-bg); border-color: var(--red); filter: brightness(1.1); }
```

- [ ] **Step 2: 文件末尾追加液态 hover 与 reduced-motion 区块**

在 `public/styles.css` 文件末尾追加：

```css
/* ============================================================
   Liquid Glass hover（spec 2026-08-16 §5）
   面板/卡片/列表项：亮度 + 高光边 + 微浮起。
   编辑器内部（.editor-pane / .code-editor-wrap）不加，避免干扰长文编辑。
   ============================================================ */
.port-card,
.endpoint-item {
  transition: background var(--d-norm) var(--ease), border-color var(--d-norm) var(--ease), box-shadow var(--d-norm) var(--ease), transform var(--d-norm) var(--ease), filter var(--d-norm) var(--ease);
}
.port-card:hover,
.endpoint-item:hover {
  filter: brightness(1.03);
  transform: translateY(-1px);
  box-shadow: var(--glass-highlight), var(--shadow-panel);
}

/* ============================================================
   Reduced motion（spec 2026-08-16 §5）
   保留颜色变化，关闭位移/亮度动效与背景漂移
   ============================================================ */
@media (prefers-reduced-motion: reduce) {
  .blobs::before,
  .blobs::after { animation: none; }
  [data-reveal] { animation: none; opacity: 1; transform: none; }
  .btn,
  .port-card,
  .endpoint-item {
    transition-property: background, border-color, color, box-shadow;
  }
  .btn:hover,
  .btn:active,
  .port-card:hover,
  .endpoint-item:hover {
    transform: none;
    filter: none;
  }
}
```

**注意：** `.endpoint-item`（约 600 行）与 `.port-card`（约 1748 行）已有各自的 `transition` 声明——上面区块里的 transition 会覆盖它们（同特异性后声明者胜，文件末尾追加即生效）。若实现时发现原规则含 `!important` 或更高特异性选择器，以「hover 三件套（brightness/translateY/box-shadow）生效」为准调整。

- [ ] **Step 3: 回归验证**

Run: `pnpm test:e2e`
Expected: 全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add public/styles.css
git commit -m "style: 胶囊按钮族与液态感 hover 动效"
```

---

### Task 5: embed-assets 同步 + 全量回归 + 手工验收

**Files:**
- Modify（覆盖同步）: `embed-assets/public/index.html`、`embed-assets/public/styles.css`、`embed-assets/public/editor.js`

**Interfaces:**
- Consumes: Task 2-4 的全部 `public/` 产物
- Produces: 编译产物一致性（CLAUDE.md 不变量 #5）；交付状态

- [ ] **Step 1: 同步三个文件**

```bash
cp public/index.html public/styles.css public/editor.js embed-assets/public/
```

- [ ] **Step 2: 验证同步无漂移**

Run: `git diff --stat embed-assets/`
Expected: 恰好 3 个文件变化（index.html / styles.css / editor.js），且 `diff public/styles.css embed-assets/public/styles.css` 无输出（完全一致）。

- [ ] **Step 3: 全量自动化回归**

Run: `pnpm test`
Expected: PASS。

Run: `pnpm test:e2e`
Expected: 全部 PASS（headed，勿切 headless）。

- [ ] **Step 4: 手工验收（启动 `pnpm start`，逐项过）**

1. 暗/亮双主题（设置面板切换）下玻璃质感：彩色背景透出、面板半透、顶部高光边可见
2. 接口管理页：保存/撤销在顶部，删除红色在最右、有分隔线；底部无按钮条
3. 小窗口（把浏览器窗口压到 ~700px 高）：编辑列出现滚动条，响应体编辑器不被截掉
4. hover 动效：首页卡片/接口列表项微浮起提亮；按钮 hover 提亮缩放，无卡顿
5. 顶栏启动→运行中→停止：按钮三态（琥珀/绿 LED + wash）在新胶囊样式下清晰
6. 亮色主题走查：首页卡片、端口详情、弹窗（新建接口/设置）、日志面板无深色残留；下拉框（方法选择）展开为白底
7. WS 端口详情→服务详情：底部按钮条仍在（删除|撤销 保存），布局未被波及
8. 系统开启「减少动态效果」时（可选）：无浮起/漂移动画

任何一项不过：回到对应 Task 修复并重跑 Step 3，不得静默跳过（规则 11）。

- [ ] **Step 5: Commit**

```bash
git add embed-assets/public/index.html embed-assets/public/styles.css embed-assets/public/editor.js
git commit -m "chore: embed-assets 同步（布局改造 + Apple Liquid Glass 换皮）"
```

---

## Self-Review 记录

- **规格覆盖**：§3.1 按钮上移（Task 2）✓；§3.2 兼容（Task 2 Step 1/2 唯一性说明）✓；§3.3 滚动（Task 2 Step 4）✓；§4.2/4.3/4.4 token（Task 3）✓；§5 动效（Task 4）✓；§6 WS 不动 + 已知不一致（Task 1 守护断言 + Task 2 注意框）✓；§7.1 embed-assets（Task 5）✓；§7.2 意图断言（Task 1）✓；§7.3 手工验收（Task 5 Step 4）✓
- **Placeholder 扫描**：无 TBD/TODO；所有代码步骤含完整代码
- **类型/命名一致性**：新 token（`--accent-fill`、`--editor-bg`、`--danger-fill-*`、`--blob-4`、`--glass-saturate`）在 Task 3 定义、Task 4 消费，名称一致；E2E 端口 17508 无冲突
