# 消息通知（toast 气泡）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入顶部居中 toast 气泡组件，为改号/保存/删除/复制/新增 5 类操作提供成功与失败反馈，并统一替换全站失败 alert()。

**Architecture:** 新增零依赖 ESM 模块 `public/toast.js` 导出 `showToast({type, message})`，首次调用动态创建固定定位容器（不改 index.html）；各视图模块 `import { showToast }` 后在各操作成功/失败路径调用。样式新增到 `public/styles.css` 的 Toast 区块。

**Tech Stack:** 原生 ESM（项目零构建）、CSS 变量主题（Cinematic Dark Glass）、Pointer/DOM API。

## Global Constraints

- 零构建、纯 JavaScript（无 TS）、Node ≥18 —— 不引入任何新依赖
- 项目不变量 5：`public/` 的改动必须同步 `embed-assets/public/`（新增文件复制；修改文件同款编辑）
- `confirm()` 确认对话框全部保留，不替换
- 保存操作的既有就地反馈（`flash()` / `lastSaved`）保留，叠加气泡不删除
- E2E 必须以前台运行（`headless: false`），不要切 headless
- `views/` 子目录文件引用 toast.js 用相对路径 `../toast.js`；`app.js` 用 `./toast.js`

---

### Task 1: toast 组件 + 样式

**Files:**
- Create: `public/toast.js`
- Modify: `public/styles.css`（新增 Toast 区块，放在文件末尾 Editor/其他区块之后）

**Interfaces:**
- Produces: `showToast({ type, message })` — `type: 'success'|'error'|'info'`（未知回退 `info`），`message: string`。后续 Task 2/3 唯一依赖此签名。

- [ ] **Step 1: 创建 `public/toast.js`**

```js
// 消息通知 toast —— 顶部居中横幅（spec 2026-08-17）
const TOAST_DURATION = { success: 2500, error: 3500, info: 2500 };
const MARK = { success: "✓", error: "✗", info: "·" };

let container = null;
const timers = new Map(); // HTMLElement -> timeoutId

function ensureContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  container.setAttribute("aria-live", "polite");
  document.body.appendChild(container);
  return container;
}

function kindOf(el) {
  return el.classList.contains("toast-error")
    ? "error"
    : el.classList.contains("toast-success")
      ? "success"
      : "info";
}

function dismiss(el) {
  clearTimeout(timers.get(el));
  timers.delete(el);
  el.classList.remove("show");
  setTimeout(() => el.remove(), 200); // 匹配退场过渡时长
}

function scheduleDismiss(el) {
  clearTimeout(timers.get(el));
  const t = setTimeout(() => dismiss(el), TOAST_DURATION[kindOf(el)]);
  timers.set(el, t);
}

/**
 * @param {{ type?: 'success'|'error'|'info', message: string }} opts
 */
export function showToast({ type = "info", message } = {}) {
  if (!["success", "error", "info"].includes(type)) type = "info";
  const c = ensureContainer();

  // 同文案同类型已有气泡在显示：重置其计时，不新增叠加
  for (const other of c.querySelectorAll(".toast")) {
    if (
      kindOf(other) === type &&
      other.querySelector(".toast-msg")?.textContent === message
    ) {
      scheduleDismiss(other);
      return;
    }
  }

  const el = document.createElement("div");
  el.className = `toast toast-${type}`;

  const mark = document.createElement("span");
  mark.className = "toast-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = MARK[type];

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "✕";
  close.addEventListener("click", () => dismiss(el));

  el.append(mark, msg, close);
  el.addEventListener("mouseenter", () => clearTimeout(timers.get(el)));
  el.addEventListener("mouseleave", () => scheduleDismiss(el));

  c.appendChild(el);
  // 入场动画：下一帧补 .show 才有过渡效果
  requestAnimationFrame(() => el.classList.add("show"));
  scheduleDismiss(el);
}
```

- [ ] **Step 2: `public/styles.css` 末尾追加 Toast 样式**

```css
/* ============================================================
   Toast 消息气泡（spec 2026-08-17）
   ============================================================ */
.toast-container {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-2);
  z-index: 2000;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  max-width: min(480px, calc(100vw - 48px));
  padding: var(--s-2) var(--s-3);
  font-size: 12.5px;
  color: var(--text-primary);
  background: rgba(14, 18, 30, 0.86);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px) saturate(1.2);
  -webkit-backdrop-filter: blur(12px) saturate(1.2);
  pointer-events: auto;
  opacity: 0;
  transform: translateY(-12px);
  transition: opacity 160ms var(--ease), transform 160ms var(--ease);
}
.toast.show { opacity: 1; transform: translateY(0); }
.toast-mark { font-size: 13px; font-weight: 700; flex-shrink: 0; }
.toast-success .toast-mark { color: var(--green); }
.toast-error .toast-mark { color: var(--red); }
.toast-info .toast-mark { color: var(--cyan); }
.toast-close {
  margin-left: 6px;
  padding: 2px 4px;
  font-size: 10px;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: 4px;
  border: none;
  background: none;
}
.toast-close:hover { color: var(--text-primary); background: var(--surface-3); }
@media (prefers-reduced-motion: reduce) {
  .toast { transition: none; }
  .toast.show { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: 手动冒烟验证组件**

Run: `pnpm start`，打开 WebUI 后在 devtools console 执行：
```js
import('/toast.js').then(m => {
  m.showToast({ type: 'success', message: '端口已改为 5002' });
  m.showToast({ type: 'error', message: '改号失败：端口被占用' });
  m.showToast({ type: 'error', message: '改号失败：端口被占用' }); // 应复用上一条，不叠加
  m.showToast({ type: 'info', message: '正在保存…' });
})
```
Expected: 顶部居中玻璃横幅依次滑入；相同 error 消息不重复；3.5s/2.5s 后自动消失；悬停暂停计时。

- [ ] **Step 4: Commit**

```bash
git add public/toast.js public/styles.css
git commit -m "feat: toast 消息气泡组件（顶部居中，成功/失败/信息三类）"
```

---

### Task 2: 5 类操作接入（app.js + port-detail.js）

**Files:**
- Modify: `public/app.js`（import + saveEndpoint + deleteEndpoint + copyEndpointById + createEndpoint + 排序失败）
- Modify: `public/views/port-detail.js`（import + 改号/删除端口/启用切换）

**Interfaces:**
- Consumes: `showToast({type, message})` from Task 1
- Produces: 五类操作成功/失败均有气泡反馈

- [ ] **Step 1: `public/app.js` 顶部 import（在现有 import 组之后追加）**

```js
import { showToast } from "./toast.js";
```

- [ ] **Step 2: `saveEndpoint()`（约 1097-1123 行）成功/失败加气泡**

成功分支（`flash("已保存", "green")` 之后）：
```js
    flash("已保存", "green");
    showToast({ type: "success", message: "已保存" });
```
失败分支（`catch (e)` 内）：
```js
    flash("✗ 保存失败", "red");
    showToast({ type: "error", message: "保存失败：" + (e?.message || "未知错误") });
```

- [ ] **Step 3: `deleteEndpoint()`（约 1125-1136 行）加 try/catch 与气泡**

将函数体重构为（保持原逻辑）：
```js
async function deleteEndpoint() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) return;
  if (!confirm(`确认删除 ${ep.method} ${ep.path}？`)) return;
  try {
    await api.deleteEndpoint(ep.id);
    state.endpoints = state.endpoints.filter((e) => e.id !== ep.id);
    state.selectedId = state.endpoints[0]?.id || null;
    state.dirty = false;
    renderEndpointList();
    renderEditor();
    renderStatus();
    showToast({ type: "success", message: `已删除 ${ep.method} ${ep.path}` });
  } catch (e) {
    showToast({ type: "error", message: "删除失败：" + (e?.message || "未知错误") });
  }
}
```

- [ ] **Step 4: `copyEndpointById()`（约 610-633 行）成功加气泡、失败替换 alert**

成功分支（`renderEditorForCreate(ep)` 之后）：
```js
    renderEditorForCreate(ep);
    showToast({ type: "success", message: `已复制 ${source.method} ${ep.path}` });
```
失败分支替换：
```js
  } catch (e) {
    showToast({ type: "error", message: "复制失败：" + (e?.message || "未知错误") });
  }
```

- [ ] **Step 5: `createEndpoint()`（约 1058-1073 行）包 try/catch 并加气泡**

```js
async function createEndpoint() {
  if (state.route.view !== "port") return;
  try {
    const ep = await api.createEndpoint({
      method: "GET",
      port: state.route.port,
      path: "/api/new",
      statusCode: 200,
      response: { code: 200, msg: "操作成功", data: null, success: true },
      enabled: true,
    });
    state.endpoints.push(ep);
    state.selectedId = ep.id;
    // Force the form to fully reset, ignoring the !state.dirty guard.
    renderEndpointList();
    renderEditorForCreate(ep);
    showToast({ type: "success", message: `已创建 ${ep.method} ${ep.path}` });
  } catch (e) {
    showToast({ type: "error", message: "创建失败：" + (e?.message || "未知错误") });
  }
}
```

- [ ] **Step 6: 排序失败 alert 替换（约 588 行）**

```js
    alert("排序失败：" + (err?.message || "未知错误"));
```
改为：
```js
    showToast({ type: "error", message: "排序失败：" + (err?.message || "未知错误") });
```

- [ ] **Step 7: `public/views/port-detail.js` 顶部 import**

```js
import { showToast } from "../toast.js";
```

- [ ] **Step 8: `port-detail.js` 改号按钮（约 28-47 行）接入**

前置校验两处 alert 替换：
```js
      return showToast({ type: "error", message: "端口号必须是 1–65535 的整数" });
```
```js
      return showToast({ type: "error", message: `端口 ${newPort} 已存在` });
```
成功分支（`navigate` 之后）：
```js
      await refreshAll();
      navigate(`#/port/${newPort}`);
      showToast({ type: "success", message: `端口已改为 ${newPort}` });
```
失败分支替换：
```js
    } catch (e) {
      showToast({ type: "error", message: "改号失败：" + (e?.message || "未知错误") });
    }
```

- [ ] **Step 9: `port-detail.js` 删除端口（约 49-65 行）加 try/catch 与气泡**

```js
  try {
    await api.deletePort(port);
    await refreshAll();
    navigate('#/');
    showToast({ type: "success", message: `已删除端口 ${port}` });
  } catch (e) {
    showToast({ type: "error", message: "删除失败：" + (e?.message || "未知错误") });
  }
```

- [ ] **Step 10: `port-detail.js` 启用开关失败（约 24 行）替换**

```js
      alert('切换失败：' + (e?.message || '未知错误'));
```
改为：
```js
      showToast({ type: "error", message: "切换失败：" + (e?.message || "未知错误") });
```

- [ ] **Step 11: 手动验证 5 类操作**

Run: `pnpm start`，在端口详情页依次：
1. 改号 5001→5002：绿条「端口已改为 5002」；重复改号撞已存在端口：红条「端口 5002 已存在」（无 alert）
2. 编辑响应体后保存：绿条「已保存」（lastSaved 就地反馈仍正常）
3. 删除接口：绿条「已删除 GET /a」
4. 复制接口：绿条「已复制 GET /a-copy」
5. 新建接口：绿条「已创建 GET /api/new」
6. 删除端口：绿条「已删除端口 5002」
7. 停止全部服务后再保存：红条「保存失败：…」

- [ ] **Step 12: Commit**

```bash
git add public/app.js public/views/port-detail.js
git commit -m "feat: 接口管理操作接入成功/失败 toast（改号/保存/删除/复制/新增）"
```

---

### Task 3: 其余失败 alert 统一替换

**Files:**
- Modify: `public/views/port-cards.js`、`public/views/ws-detail.js`、`public/views/ws-services.js`

**Interfaces:**
- Consumes: `showToast({type, message})` from Task 1；views 子目录相对路径 `../toast.js`

- [ ] **Step 1: `views/port-cards.js` 顶部 import + 切换失败替换（约 75 行）**

```js
import { showToast } from "../toast.js";
```
```js
      alert('切换失败：' + (e?.message || '未知错误'));
```
改为：
```js
      showToast({ type: "error", message: "切换失败：" + (e?.message || "未知错误") });
```

- [ ] **Step 2: `views/ws-detail.js` 顶部 import + 4 处失败 alert 替换**

import 同上。替换点（行号以文件为准，用现有代码串匹配）：
- 约 263 行 `alert("切换失败：" + ...)` → `showToast({ type: "error", message: "切换失败：" + ... })`
- 约 299 行 `alert("删除失败：" + ...)` → `showToast({ type: "error", message: "删除失败：" + ... })`
- 约 318 行 `alert("新建操作失败：" + ...)` → `showToast({ type: "error", message: "新建操作失败：" + ... })`
- 约 402 行 `alert("删除失败：" + ...)` → `showToast({ type: "error", message: "删除失败：" + ... })`

- [ ] **Step 3: `views/ws-services.js` 顶部 import + 删除服务失败替换（约 71 行）**

```js
      alert('删除失败：' + (e?.message || '未知错误'));
```
改为：
```js
      showToast({ type: "error", message: "删除失败：" + (e?.message || "未知错误") });
```

- [ ] **Step 4: 确认全站无残留 alert**

Run: `grep -rn "alert(" public/ --include="*.js"`
Expected: 无输出（`confirm(` 保留属预期，不替换）。

- [ ] **Step 5: Commit**

```bash
git add public/views/
git commit -m "refactor: 全站操作失败提示统一替换 alert 为 toast（WS 服务/端口卡片等）"
```

---

### Task 4: embed-assets 同步 + 全量验证

**Files:**
- Create: `embed-assets/public/toast.js`（复制 public/toast.js）
- Modify: `embed-assets/public/styles.css`、`embed-assets/public/app.js`、`embed-assets/public/views/port-detail.js`、`embed-assets/public/views/port-cards.js`、`embed-assets/public/views/ws-detail.js`、`embed-assets/public/views/ws-services.js`（与 public/ 同款改动）

**Interfaces:**
- Consumes: 全部前序改动

- [ ] **Step 1: 复制 toast.js 并同步静态样式**

```bash
cp public/toast.js embed-assets/public/toast.js
```
对 `embed-assets/public/styles.css` 执行与 Task 1 Step 2 相同的追加；`diff public/styles.css embed-assets/public/styles.css` 应无输出。

- [ ] **Step 2: 同步其余 5 个 JS 文件**

对 embed-assets 下对应文件执行与 Task 2 Step 1-10、Task 3 Step 1-3 相同的编辑（内容应与 public/ 完全一致）。
Verify: `diff public/app.js embed-assets/public/app.js && diff -r public/views embed-assets/public/views` 无输出。

- [ ] **Step 3: 全量测试**

Run: `pnpm test`
Expected: 263 用例全过（26 文件）。toast 为纯 UI 改动，现有测试不覆盖该行为，跑通即无回归。

- [ ] **Step 4: E2E 冒烟（删除端口流程，覆盖 confirm 保留）**

Run: `pnpm playwright test test/e2e/port-detail.spec.js`
Expected: 通过（port-detail E2E 依赖 confirm dialog 的用例不受影响）。

- [ ] **Step 5: Commit**

```bash
git add embed-assets/
git commit -m "chore: embed-assets 同步（toast 组件与接入）"
```