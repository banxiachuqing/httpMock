# 请求详情弹窗 — 设计

**日期**：2026-06-29
**状态**：待用户审查
**目标版本**：mock-server-webui v1 增量

---

## 1. 背景与目标

请求日志面板当前只显示一行压缩信息（时间 / 方法 / 路径 / 端口 / 状态 / 耗时 / IP / 匹配状态）。调试 POST/PUT 时，开发者经常需要看完整请求体、查询参数和请求头——这些目前**已经采集在 `LogBuffer` 里**（`requestHeaders` / `requestBodyPreview` / `query`），但前端没有暴露。

另外当前 `requestBodyPreview` 截在 2048 字节，POST JSON 经常超过。

**目标**：
1. 点击日志行 → 弹窗显示该请求的请求头、查询参数、请求体
2. 请求体取消 2048 字节截断，按实际大小存（受用户在 Settings 里配置的上限限制）
3. 把 body 上限做成 Settings 面板的可配置项（替代 `MOCK_MAX_BODY_PREVIEW` 环境变量）

**非目标（v1 故意不做）**：
- 不存响应体（`responseBodyPreview` 暂不加；如需另起 spec）
- 不复制按钮（浏览器自带选中复制即可）
- 不做 URL 同步（modal 状态不入 URL）
- 不做过滤/搜索（modal 之外的功能，不在这次范围）
- 不做模态打开时的视觉回归基线（v1 靠行为测试 + 手测）

---

## 2. 架构总览

```
┌──────────────────┐   push (含 body)   ┌─────────────────┐
│  MockEngine      │ ─────────────────► │  LogBuffer      │
│  (src/mock-      │                    │  (src/log-      │
│   engine.js)     │ ───── subscribe ──►│   buffer.js)    │
└──────────────────┘                    └─────────────────┘
                                                  │
                                                  │ 推送 + /api/logs 初始拉
                                                  ▼
                                          ┌─────────────────┐
                                          │  前端 state.logs│
                                          │  (≤500)         │
                                          └─────────────────┘
                                                  │
                                       state.logs.find(id)
                                                  │
                                                  ▼
                                          ┌─────────────────┐
                                          │  <dialog> 弹窗  │
                                          │  (public/)      │
                                          └─────────────────┘
```

**核心约束**：
- 后端零新 API 端点；详情数据全部已在 `state.logs` 内存里
- 后端改一个 `readBody` 函数 + log entry 加一个 `requestBodyTruncated` 字段
- 前端加一个 `<dialog>` + CodeMirror 只读 viewer（复用 `editor.js` 同一组件）
- `public/` 与 `embed-assets/public/` 必须**同步修改**（CLAUDE.md 第 5 条）

---

## 3. 数据模型变更

### 3.1 log entry 新增字段

```js
{
  id: crypto.randomUUID(),       // 已有
  timestamp: Date.now(),          // 已有
  method, path, query, port,      // 已有
  status, durationMs, matched,    // 已有
  endpointId, ip,                 // 已有
  requestHeaders,                 // 已有
  requestBodyPreview,             // 已有 — 现在按实际大小存
  requestBodyTruncated: boolean,  // 新增 — true 表示超出上限被截断
}
```

### 3.2 settings 新增字段

`data.json` 的 `settings` 块：

```jsonc
{
  "version": 1,
  "settings": {
    "uiPort": 5050,
    "storagePath": "...",
    "maxBodyBytes": 4194304   // 新增，默认 4 * 1024 * 1024 = 4 MiB
  },
  "endpoints": []
}
```

**约束**：
- 类型：正整数
- 默认：4194304（4 MiB）
- **无上限校验**——用户在 Settings 里填什么就是什么（用户明确要求）
- 旧 `data.json` 缺 `maxBodyBytes` 时：mock-engine 用 4194304 兜底；同时 `ConfigStore.update()` 在写入时如果不存在则补上（迁移）

### 3.3 mock-engine.js 改造

```js
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    let truncated = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        truncated = true;
        return;          // 超出后停止累积，不再读
      }
      chunks.push(c);
    });
    req.on('end', () => {
      resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated });
    });
    req.on('error', () => resolve({ body: '', truncated: false }));
  });
}
```

构造函数改为接收 `configStore`：

```js
constructor({ logBuffer, bindHost = '127.0.0.1', configStore }) {
  this.logBuffer = logBuffer;
  this.bindHost = bindHost;
  this.configStore = configStore;
  this.servers = new Map();
  this.statuses = new Map();
}
```

每次请求动态读取上限：

```js
const max = this.configStore.config.settings.maxBodyBytes ?? 4 * 1024 * 1024;
const { body, truncated } = await readBody(req, max);
// ... 推 log entry 时加 requestBodyTruncated: truncated
```

`server.js` 的初始化：`new MockEngine({ bindHost, configStore })` 替换 `maxBodyPreview` 入参；删除 `MOCK_MAX_BODY_PREVIEW` 环境变量解析。

### 3.4 ConfigStore 迁移

`ConfigStore.load()` 解析失败时的默认值改为：

```js
this.config = {
  version: 1,
  settings: { storagePath: this.storagePath, uiPort: 5050, maxBodyBytes: 4 * 1024 * 1024 },
  endpoints: [],
};
```

**加载成功但缺 `settings.maxBodyBytes` 的旧文件**：不主动写回 `data.json`（避免每次启动都 rewrite）。所有读取点统一用 `?? 4 * 1024 * 1024` 兜底。Settings 面板首次保存时，新值会随其它设置一并持久化。

---

## 4. API 变更

### 4.1 `PATCH /api/config`

增加 `settings.maxBodyBytes` 字段处理：

```js
await configStore.update((cfg) => {
  if (settings.uiPort !== undefined) cfg.settings.uiPort = settings.uiPort;
  if (settings.storagePath !== undefined) cfg.settings.storagePath = settings.storagePath;
  if (settings.maxBodyBytes !== undefined) cfg.settings.maxBodyBytes = settings.maxBodyBytes;
  return cfg;
});
```

校验（`validatePatchConfig` 新函数，在 PATCH 入口调用）：

- `maxBodyBytes` 必须是正整数（`Number.isInteger` && `> 0`）
- 其它字段保持现状

### 4.2 不变

- `GET /api/logs`（带 `requestBodyTruncated` 字段自动随 entry 返回）
- `DELETE /api/logs`
- `GET /api/config`（已返回完整 `settings`，前端可直接读 `maxBodyBytes`）
- 所有 CRUD/runtime 路由

---

## 5. UI 变更

### 5.1 弹窗结构

```html
<dialog id="log-detail" class="log-detail">
  <header class="log-detail-header">
    <span class="log-detail-method" data-method="...">METHOD</span>
    <span class="log-detail-path">/api/...</span>
    <span class="log-detail-status" data-range="2xx">200</span>
    <button class="log-detail-close" aria-label="关闭">×</button>
  </header>

  <section class="log-detail-section">
    <h3>请求</h3>
    <dl class="log-detail-meta">
      <dt>时间</dt><dd>2026-06-29 14:23:11.234</dd>
      <dt>端口</dt><dd>8080</dd>
      <dt>耗时</dt><dd>12 ms</dd>
      <dt>IP</dt><dd>192.168.1.10</dd>
      <dt>路由</dt><dd>匹配 / 无路由</dd>
    </dl>
  </section>

  <section class="log-detail-section">
    <h3>查询参数 <span class="log-detail-count">2</span></h3>
    <table class="log-detail-table">
      <thead><tr><th>键</th><th>值</th></tr></thead>
      <tbody>...</tbody>
    </table>
    <p class="log-detail-empty">（无查询参数）</p>
  </section>

  <section class="log-detail-section">
    <h3>请求头 <span class="log-detail-count">5</span></h3>
    <table class="log-detail-table">...</table>
  </section>

  <section class="log-detail-section">
    <h3>请求体</h3>
    <div class="log-detail-body-warning" hidden>请求体已截断（超出配置上限）</div>
    <div class="log-detail-body cm-readonly-host"></div>
    <pre class="log-detail-body-plain" hidden></pre>
    <p class="log-detail-empty">（无请求体）</p>
  </section>
</dialog>
```

### 5.2 行为

| 场景 | 行为 |
|---|---|
| 点击 `.log-entry` | `dialog.showModal()`；根据 entry 填四个 section |
| ESC | `dialog.close()`（原生行为）|
| 点击遮罩 | 关闭（监听 `click`，判定 `event.target === dialog`）|
| 点击 × 按钮 | 关闭 |
| `requestBodyTruncated === true` | 顶部红字 "请求体已截断（X.X MB 上限）" |
| Body 是合法 JSON | CodeMirror 渲染（read-only，lang-json）|
| Body 是纯文本 / 解析失败 | `<pre>` 纯文本展示 |
| Body 为空字符串 | 显示 "（无请求体）" |
| Query 为空 | 显示 "（无查询参数）" |
| 点击 `resolver-warn` 条目（无 method） | 不可点；行不带 cursor: pointer，不响应 click |
| `state.logs` 找不到 id（被 500 截断后）| 静默 noop |

### 5.3 editor.js 改造

暴露 `mountReadonlyEditor(parent, text)` 工厂：

```js
export function mountReadonlyEditor(parent, text) {
  const state = EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      json(),
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.theme({ /* 与现有编辑区主题一致 */ }),
    ],
  });
  return new EditorView({ state, parent });
}
```

`window.mountReadonlyEditor` 暴露给 `app.js` 使用。

### 5.4 app.js 改造

```js
function renderLogEntry(entry) {
  const row = document.createElement('div');
  // ... 现有 markup
  if (entry.method) {  // 过滤 resolver-warn 条目
    row.classList.add('clickable');
    row.addEventListener('click', () => openLogDetail(entry.id));
  }
  return row;
}

function openLogDetail(id) {
  const entry = state.logs.find((e) => e.id === id);
  if (!entry || !entry.method) return;
  renderLogDetail(entry);
  els.logDetail.showModal();
}

let logDetailCM = null;  // modal 关闭时 destroy，避免内存累积

function closeLogDetail() {
  els.logDetail.close();
  // 清理 CM instance（避免内存累积）
  if (logDetailCM) { logDetailCM.destroy(); logDetailCM = null; }
}

function renderLogDetail(entry) {
  // 1. Header
  els.logDetailMethod.textContent = entry.method;
  els.logDetailMethod.dataset.method = entry.method;
  els.logDetailPath.textContent = entry.path;
  els.logDetailStatus.textContent = entry.status;
  els.logDetailStatus.dataset.range = `${Math.floor(entry.status / 100)}xx`;

  // 2. Meta
  // ... 填 dl

  // 3. Query 表格
  const queryParams = new URLSearchParams(entry.query);
  // ... 填 table

  // 4. Headers 表格
  // ... 填 table

  // 5. Body
  const body = entry.requestBodyPreview;
  if (!body) {
    els.logDetailEmpty.hidden = false;
  } else {
    els.logDetailEmpty.hidden = true;
    els.logDetailBodyWarning.hidden = !entry.requestBodyTruncated;
    let parsed;
    try { parsed = JSON.parse(body); } catch {}
    if (parsed !== undefined) {
      const formatted = JSON.stringify(parsed, null, 2);
      els.logDetailBody.hidden = false;
      els.logDetailBodyPlain.hidden = true;
      logDetailCM = window.mountReadonlyEditor(els.logDetailBody, formatted);
    } else {
      els.logDetailBody.hidden = true;
      els.logDetailBodyPlain.hidden = false;
      els.logDetailBodyPlain.textContent = body;
    }
  }
}

// 新事件绑定
els.logDetailClose.addEventListener('click', closeLogDetail);
els.logDetail.addEventListener('click', (e) => {
  if (e.target === els.logDetail) closeLogDetail();  // 点遮罩
});
els.logDetail.addEventListener('close', () => {
  if (logDetailCM) { logDetailCM.destroy(); logDetailCM = null; }
});
```

### 5.5 Settings 面板

`index.html` 的 Settings 弹窗加一个 input：

```html
<div class="settings-row">
  <label for="settingsMaxBody">请求体大小上限 (bytes)</label>
  <input id="settingsMaxBody" type="number" min="1" step="1" />
  <span class="settings-hint" id="settingsMaxBodyHint">4.0 MB</span>
</div>
```

`app.js` 的 `openSettings` 多读一项：

```js
els.maxBody.value = state.config.settings.maxBodyBytes ?? 4194304;
els.maxBodyHint.textContent = formatBytes(Number(els.maxBody.value));
els.maxBody.addEventListener('input', () => {
  els.maxBodyHint.textContent = formatBytes(Number(els.maxBody.value)) || '—';
});
```

`saveSettings`：

```js
async function saveSettings() {
  const newMax = Number(els.maxBody.value);
  if (!Number.isInteger(newMax) || newMax < 1) {
    flash('请求体大小上限必须是正整数', 'red');
    return;
  }
  const needsRestart = els.storagePath.value.trim() !== state.config.settings.storagePath
                    || Number(els.uiPort.value) !== state.config.settings.uiPort;
  await api.patchConfig({
    storagePath: els.storagePath.value.trim(),
    uiPort: Number(els.uiPort.value),
    maxBodyBytes: newMax,
  });
  state.config = await api.getConfig();
  closeSettings();
  flash(needsRestart ? '已保存 · 重启后生效' : '已保存 · 立即生效', 'green');
}
```

`formatBytes(n)` 工具函数：

```js
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
```

### 5.6 styles.css 关键样式

```css
.log-entry {
  cursor: pointer;
  transition: background-color 80ms ease;
}
.log-entry:hover { background: var(--surface-hover, rgba(255,255,255,0.04)); }
.log-entry.clickable { cursor: pointer; }

dialog.log-detail {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  border-radius: 8px;
  max-width: 720px;
  width: 90vw;
  max-height: 80vh;
  padding: 0;
  box-shadow: 0 12px 48px rgba(0,0,0,0.4);
}
dialog.log-detail::backdrop {
  background: rgba(8, 14, 24, 0.6);
  backdrop-filter: blur(2px);
}
.log-detail-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.log-detail-section { padding: 14px 18px; border-bottom: 1px solid var(--border); }
.log-detail-section:last-child { border-bottom: none; overflow: auto; }
.log-detail-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); margin: 0 0 8px; }
.log-detail-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.log-detail-table th, .log-detail-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border-soft); }
.log-detail-table th { color: var(--text-dim); font-weight: 500; width: 30%; }
.log-detail-body { max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; }
.log-detail-body-warning {
  background: var(--amber-soft, rgba(255,170,0,0.1));
  color: var(--amber, #fa8);
  padding: 6px 10px; border-radius: 4px; font-size: 12px;
  margin-bottom: 8px;
}
```

---

## 6. 数据流（一次点击）

```
用户点 .log-entry
  → openLogDetail(entry.id)
    → state.logs.find(e => e.id === id)
    → renderLogDetail(entry)  [同步，无网络]
      ├─ 填 header / meta / query 表格 / headers 表格
      └─ body: JSON 解析?
          ├─ 成功 → mountReadonlyEditor(parent, formatted)  [CodeMirror 创建]
          └─ 失败 → <pre>.textContent = body
    → dialog.showModal()
```

modal 打开时 SSE 继续推送新 log，但 modal 是**只读快照**，不响应新数据。

modal 关闭时 `destroy()` CodeMirror 实例（避免 4MB body 文档的内存累积）。

---

## 7. 边界与错误

| 场景 | 行为 |
|---|---|
| GET 无 body | `requestBodyPreview = ''`, `truncated = false`；显示 "（无请求体）" |
| Body 是合法 JSON | CodeMirror 只读 + lang-json |
| Body 是纯文本 / 解析失败 | `<pre>` 纯文本 |
| Body 超 `maxBodyBytes` | 4MB 后停读；`truncated = true`；warning 可见 |
| Body 是二进制 / 非 UTF-8 | 仍按 UTF-8 解码，乱码显示（同现状） |
| Resolver warn 条目（`level: 'warn'`，无 method） | 不可点；cursor 不变 pointer |
| `state.logs` 找不到 id（500 截断） | 静默 noop |
| Modal 打开时新 log 进来 | 不影响 modal（只读快照） |
| Modal 打开时再次点击另一行 | 关闭旧 modal，开新 modal（`<dialog>` 互斥）|
| 多个 modal 互斥 | `showModal()` 自带栈处理 |
| `maxBodyBytes` 非正整数 | PATCH 返回 400；前端 flash 红色错误，不保存 |
| `maxBodyBytes` 极大（如 1 GB）| 接受；警告日志 "max body size is 1GB, memory pressure risk"（不阻塞） |

---

## 8. 测试

### 8.1 Unit（vitest）

- `test/unit/mock-engine.test.js` 改：
  - body < max：完整存储，`truncated: false`
  - body = max：完整存储，`truncated: false`
  - body > max：截断到 max 字节，`truncated: true`
  - GET 无 body：`body = ''`, `truncated: false`
  - 缺 `settings.maxBodyBytes` 时用 4194304 兜底
  - 修改 `settings.maxBodyBytes` 后下次请求立即生效（不需重启）

### 8.2 Integration（vitest + supertest）

- `test/integration/api-config.test.js` 改：
  - `PATCH /api/config` 接受 `{ settings: { maxBodyBytes: 1000000 } }`，返回更新后的 config
  - `PATCH /api/config` 拒绝 `{ maxBodyBytes: 0 }` / `-1` / `1.5`，返回 400 + `INVALID_VALUE`
  - `GET /api/config` 返回的 settings 含 `maxBodyBytes`
- `test/integration/api-logs.test.js` 改：
  - 旧 fixture 写入 log entry 后，`GET /api/logs` 返回的 entry 含 `requestBodyTruncated` 字段（默认 `false`）

### 8.3 E2E（Playwright headed, `test/e2e/log-detail-modal.spec.js`）

新增文件：

1. **基本流程**：起 POST mock → 触发 1KB JSON 请求 → 点 log row → dialog 出现，4 section 全在
2. **Body 格式化**：body 是合法 JSON → CodeMirror `.cm-content` 存在
3. **Body 纯文本**：body 不是 JSON → `<pre>` 可见，CodeMirror 不可见
4. **ESC 关闭**：dialog 打开 → 按 ESC → dialog 关闭
5. **点遮罩关闭**：dialog 打开 → 点 backdrop → dialog 关闭
6. **GET 无 body**：触发 GET → dialog 出现，body section 显示 "（无请求体）"
7. **大 body 截断**：mock engine 上限设为 1KB，发送 4KB body → dialog 出现，warning "请求体已截断（1.0 KB 上限）"
8. **Query 解析**：GET `/api/x?a=1&b=2` → query section 表格有 a / b 两行
9. **Settings 保存**：改 `maxBodyBytes` → 保存 → flash "立即生效"（storagePath/uiPort 未改时）→ reload 后值保留
10. **设置迁移**：data.json 缺 `maxBodyBytes` → mock engine 兜底 4MB

### 8.4 手工验收（headed）

- 视觉：modal 居中、四个 section 排布合理、CodeMirror 主题与现有编辑区一致
- 交互：modal 打开时主面板仍可滚动（modal 是原生 dialog，遮罩层覆盖，主面板事件被阻挡——这是正确的）
- 复制：选中 body / header 内容复制可正常工作
- 性能：4MB body 打开 modal < 200ms

---

## 9. 迁移 & 兼容

- **旧 `data.json`**（无 `maxBodyBytes`）：mock-engine 兜底 4MB，不主动写回
- **旧 `MOCK_MAX_BODY_PREVIEW` 环境变量**：**完全删除**（用户已确认不要环境变量方案）；CLAUDE.md 同步删除该行
- **旧 API 调用**：`PATCH /api/config` 不传 `maxBodyBytes` 时，行为不变（其它字段照常更新）
- **前端旧版本**：新加的 `requestBodyTruncated` 字段缺失时，前端 `entry.requestBodyTruncated ?? false` 兜底
- **后端旧版本（理论上不存在）**：不写考虑

---

## 10. 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 用户设 `maxBodyBytes = 1GB` | 高 | 接受；mock-engine 启动时不警告；500 条 × 1GB = 500GB 内存——用户自己负责 |
| SSE 流量放大（4MB body × 5 个连接 = 20MB 推送） | 中 | 接受；如果以后真出问题，再加 SSE body 截断（保留 LogBuffer 完整 body，单独 API 取）|
| CodeMirror 渲染 4MB 文档卡顿 | 中 | 用户控制上限；modal 关闭 destroy 实例 |
| `<dialog>` 浏览器兼容性 | 低 | 现代浏览器（Chrome 37+, Firefox 98+, Safari 15.4+）全支持 |
| 旧 fixture log entry 缺 `requestBodyTruncated` | 低 | 前端 `?? false` 兜底 |

---

## 11. 文件清单

```
src/mock-engine.js                 改 readBody + 构造函数 + entry 字段
src/config-store.js                改 load() 默认值（含 maxBodyBytes）
src/api.js                         改 PATCH /api/config 加 maxBodyBytes 处理 + 校验
server.js                          改：删除 MOCK_MAX_BODY_PREVIEW 解析 + MockEngine 入参
CLAUDE.md                          改：删除 MOCK_MAX_BODY_PREVIEW 文档

public/index.html                  改：加 <dialog id="log-detail"> 结构 + Settings 加 maxBodyBytes input
public/app.js                      改：renderLogEntry click + openLogDetail/closeLogDetail/renderLogDetail + openSettings/saveSettings 加 maxBodyBytes
public/editor.js                   改：暴露 mountReadonlyEditor
public/styles.css                  改：加 .log-entry:hover + dialog 样式 + 表格样式

embed-assets/public/index.html     同步
embed-assets/public/app.js         同步
embed-assets/public/editor.js      同步
embed-assets/public/styles.css     同步

test/unit/mock-engine.test.js      改：加 truncated 边界用例
test/integration/api-config.test.js  改：加 maxBodyBytes 校验用例
test/integration/api-logs.test.js  改：加 truncated 字段验证
test/e2e/log-detail-modal.spec.js  新建
```

---

## 12. 实施顺序（参考）

1. 后端：mock-engine readBody + entry 字段 + configStore 入参（**可独立 PR**）
2. 后端：ConfigStore 迁移 + api.js PATCH 校验（依赖 1）
3. 前端：Settings UI 加 maxBodyBytes + saveSettings（依赖 2）
4. 前端：log-detail dialog 结构 + styles（**可与 3 并行**）
5. 前端：openLogDetail/renderLogDetail + editor.js mountReadonlyEditor（依赖 4）
6. 测试：unit → integration → E2E（每步跟着前面）
7. 同步 `embed-assets/public/`
8. 文档更新（CLAUDE.md）

---

**自审**：
- ✅ 无占位符 / TBD / TODO
- ✅ 数据模型 / 行为 / 测试三处描述一致
- ✅ 范围聚焦（响应体、URL 同步、复制按钮明确非目标）
- ✅ 模糊点已澄清：truncation 算法（停止读后续 chunk，但已读到的保留）、modal 互斥行为、warn 条目处理、设置生效范围、§10 风险表已剔除与"无固定上限"矛盾的 hint 文案
