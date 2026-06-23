// Mock//Server — production UI
// Talks to /api/* and /events.

import { mountEditor, getValue, setValue, getEditorView } from './editor.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ============================================================
// API client
// ============================================================
const api = {
  async getConfig() { return (await fetch('/api/config')).json(); },
  async patchConfig(settings) {
    return (await fetch('/api/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }) })).json();
  },
  async listEndpoints() { return (await fetch('/api/endpoints')).json(); },
  async createEndpoint(body) {
    return (await fetch('/api/endpoints', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  },
  async updateEndpoint(id, body) {
    return (await fetch(`/api/endpoints/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  },
  async deleteEndpoint(id) {
    return (await fetch(`/api/endpoints/${id}`, { method: 'DELETE' }));
  },
  async runtimeStart() { return (await fetch('/api/runtime/start', { method: 'POST' })).json(); },
  async runtimeStop() { return (await fetch('/api/runtime/stop', { method: 'POST' })).json(); },
  async runtimeStatus() { return (await fetch('/api/runtime/status')).json(); },
  async recentLogs(limit = 500) { return (await fetch(`/api/logs?limit=${limit}`)).json(); },
  async clearLogs() { await fetch('/api/logs', { method: 'DELETE' }); },
  async getGenerators() { return (await fetch('/api/generators')).json(); },
  async getGeneratorSample(id, args) {
    return (await fetch('/api/generators/sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, args }),
    })).json();
  },
  async preview(text) {
    return (await fetch('/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })).json();
  },
};

// ============================================================
// State
// ============================================================
const state = {
  config: null,
  endpoints: [],
  selectedId: null,
  dirty: false,
  runtime: 'stopped',
  runtimeStatus: {}, // port -> { state, reason? }
  logs: [],
  autoScroll: true,
};

// ============================================================
// DOM refs
// ============================================================
const els = {
  startStopBtn: $('#startStopBtn'),
  globalStatus: $('#globalStatus'),
  statusDetail: $('#statusDetail'),
  newEndpointBtn: $('#newEndpointBtn'),
  emptyNewBtn: $('#emptyNewBtn'),
  endpointList: $('#endpointList'),
  endpointCount: $('#endpointCount'),
  portSummaryList: $('#portSummaryList'),
  editorEmpty: $('#editorEmpty'),
  editorForm: $('#editorForm'),
  endpointId: $('#endpointId'),
  lastSaved: $('#lastSaved'),
  method: $('#method'),
  port: $('#port'),
  path: $('#path'),
  status: $('#status'),
  responseEditor: { value: '' }, // legacy ref; replaced by CodeMirror getters
  validationStatus: $('#validationStatus'),
  formatBtn: $('#formatBtn'),
  validateBtn: $('#validateBtn'),
  saveBtn: $('#saveBtn'),
  revertBtn: $('#revertBtn'),
  deleteBtn: $('#deleteBtn'),
  lineCount: $('#lineCount'),
  charCount: $('#charCount'),
  logsBody: $('#logsBody'),
  logsCount: $('#logsCount'),
  logsStatus: $('#logsStatus'),
  autoScrollToggle: $('#autoScrollToggle'),
  clearLogsBtn: $('#clearLogsBtn'),
  settingsBtn: $('#settingsBtn'),
  settingsModal: $('#settingsModal'),
  settingsBackdrop: $('#settingsBackdrop'),
  settingsClose: $('#settingsClose'),
  settingsCancel: $('#settingsCancel'),
  settingsSave: $('#settingsSave'),
  storagePath: $('#storagePath'),
  uiPort: $('#uiPort'),
};

// ============================================================
// Render
// ============================================================
function render() {
  renderEndpointList();
  renderEditor();
  renderStatus();
}

function renderEndpointList() {
  els.endpointCount.textContent = state.endpoints.length;
  const ports = [...new Set(state.endpoints.map((e) => e.port))].sort((a, b) => a - b);
  els.portSummaryList.textContent = ports.length ? ports.map((p) => `:${p}`).join('  ') : '—';

  els.endpointList.innerHTML = '';
  for (const ep of state.endpoints) {
    const li = document.createElement('li');
    li.className = 'endpoint-item' + (ep.id === state.selectedId ? ' selected' : '');
    li.dataset.id = ep.id;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', ep.id === state.selectedId ? 'true' : 'false');

    // Per-port status indicator: failed > running > stopped
    const portStatus = state.runtimeStatus[String(ep.port)];
    let ledState = 'stopped';
    let ledTitle = '';
    if (portStatus?.state === 'failed') {
      ledState = 'failed';
      ledTitle = `端口 ${ep.port} 启动失败：${portStatus.reason || '未知原因'}`;
    } else if (portStatus?.state === 'running') {
      ledState = 'running';
      ledTitle = `端口 ${ep.port} 运行中`;
    } else {
      ledTitle = `端口 ${ep.port} 未启动`;
    }

    li.innerHTML = `
      <span class="endpoint-method" data-method="${ep.method}">${ep.method}</span>
      <div class="endpoint-main">
        <div class="endpoint-path"></div>
        <div class="endpoint-port">${ep.port}</div>
      </div>
      <div class="endpoint-status">
        <span class="led led-mini" data-state="${ledState}" title="${ledTitle}"></span>
      </div>
      <button class="endpoint-delete" type="button" aria-label="删除" title="删除">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    `;
    li.querySelector('.endpoint-path').textContent = ep.path;
    li.addEventListener('click', (e) => {
      // Ignore clicks on the delete button
      if (e.target.closest('.endpoint-delete')) return;
      selectEndpoint(ep.id);
    });
    li.querySelector('.endpoint-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteEndpointById(ep.id);
    });
    els.endpointList.appendChild(li);
  }
}

async function deleteEndpointById(id) {
  const ep = state.endpoints.find((e) => e.id === id);
  if (!ep) return;
  if (!confirm(`确认删除 ${ep.method} ${ep.path}？`)) return;
  try {
    await api.deleteEndpoint(id);
  } catch (e) {
    alert('删除失败：' + (e?.message || '未知错误'));
    return;
  }
  const wasSelected = state.selectedId === id;
  state.endpoints = state.endpoints.filter((e) => e.id !== id);
  if (wasSelected) {
    state.selectedId = state.endpoints[0]?.id || null;
    state.dirty = false;
  }
  renderEndpointList();
  renderEditor();
  renderStatus();
}

function renderEditor() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) {
    els.editorEmpty.hidden = false;
    els.editorForm.hidden = true;
    return;
  }
  els.editorEmpty.hidden = true;
  els.editorForm.hidden = false;
  els.endpointId.textContent = `id: ${ep.id.slice(0, 8)}…`;
  if (!state.dirty) {
    els.method.value = ep.method;
    els.port.value = ep.port;
    els.path.value = ep.path;
    els.status.value = ep.statusCode || 200;
    els.responseEditor.value = formatJSON(ep.response);
    if (window.__editorMounted) setValue(formatJSON(ep.response));
    els.lastSaved.textContent = 'saved';
    els.lastSaved.style.color = '';
  }
  updateEditorMeta();
  validateJSON();
}

function renderStatus() {
  const btn = els.startStopBtn;
  const pill = els.globalStatus;
  pill.dataset.state = state.runtime;
  btn.dataset.state = state.runtime;
  pill.querySelector('.led').dataset.state = state.runtime;
  const map = {
    stopped: { text: '已停止', label: '启动', detail: '所有端口空闲' },
    starting: { text: '启动中', label: '启动中…', detail: '正在绑定端口' },
    running: { text: '运行中', label: '停止', detail: `${new Set(state.endpoints.map((e) => e.port)).size} 个端口已上线` },
    failed: { text: '启动失败', label: '重试', detail: '见接口列表' },
  };
  const m = map[state.runtime];
  pill.querySelector('.status-text').textContent = m.text;
  btn.querySelector('.btn-label').textContent = m.label;
  els.statusDetail.textContent = m.detail;
}

function renderLogEntry(entry) {
  const row = document.createElement('div');
  row.className = `log-entry ${entry.matched ? 'matched' : 'missed'}`;
  const range = `${Math.floor(entry.status / 100)}xx`;
  const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  const ip = (entry.ip || '').replace(/^::ffff:/, ''); // strip IPv6-mapped prefix
  row.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-method" style="color: var(--method-${entry.method.toLowerCase()})">${entry.method}</span>
    <span class="log-path"></span>
    <span class="log-port">${entry.port}</span>
    <span class="log-status" data-range="${range}">${entry.status}</span>
    <span class="log-duration">${entry.durationMs}</span>
    <span class="log-ip mono">${ip || '—'}</span>
    <span class="log-result">${entry.matched ? '匹配' : '无路由'}</span>
  `;
  row.querySelector('.log-path').textContent = entry.path;
  return row;
}

function renderLogsInitial() {
  els.logsBody.innerHTML = '';
  if (state.logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.innerHTML = `<span class="logs-empty-mark">//</span><span>暂无请求。</span>`;
    els.logsBody.appendChild(empty);
  } else {
    for (const e of state.logs) els.logsBody.appendChild(renderLogEntry(e));
  }
  els.logsCount.textContent = `${state.logs.length} 条 · 最多 500`;
  if (state.autoScroll) els.logsBody.scrollTop = els.logsBody.scrollHeight;
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
  // Remove the empty-state placeholder if it's still there so the new entry
  // appears at the top of the log list rather than below a 200px-tall gap.
  const empty = els.logsBody.querySelector('.logs-empty');
  if (empty) empty.remove();
  els.logsBody.appendChild(renderLogEntry(entry));
  els.logsCount.textContent = `${state.logs.length} 条 · 最多 500`;
  if (state.autoScroll) els.logsBody.scrollTop = els.logsBody.scrollHeight;
}

// ============================================================
// Actions
// ============================================================
async function loadAll() {
  state.config = await api.getConfig();
  state.endpoints = await api.listEndpoints();
  state.selectedId = state.endpoints[0]?.id || null;
  state.logs = await api.recentLogs(500);
  // Also fetch runtime status so the global toggle reflects the real state
  // after a page refresh (the mock servers may still be bound to their ports).
  try {
    state.runtimeStatus = await api.runtimeStatus();
    deriveGlobalRuntime();
  } catch {}
  renderLogsInitial();
  render();
}

// Derive the global state.runtime (button label) from per-port statuses.
// Priority: any failed → "failed"; any running → "running"; else → "stopped".
function deriveGlobalRuntime() {
  const ports = Object.values(state.runtimeStatus);
  if (ports.some((p) => p.state === 'failed')) state.runtime = 'failed';
  else if (ports.some((p) => p.state === 'running')) state.runtime = 'running';
  else state.runtime = 'stopped';
}

function selectEndpoint(id) {
  if (state.dirty && !confirm('有未保存的修改，是否放弃？')) return;
  state.selectedId = id;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
}

function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  els.lastSaved.textContent = '未保存';
  els.lastSaved.style.color = 'var(--amber)';
}

async function createEndpoint() {
  // Pick an unused-looking port and a clear placeholder path so the user
  // can tell the editor has been reset (not just "looks the same as before").
  const usedPorts = new Set(state.endpoints.map((e) => e.port));
  let port = 8080;
  while (usedPorts.has(port)) port++;
  const ep = await api.createEndpoint({
    method: 'GET',
    port,
    path: '/api/new',
    statusCode: 200,
    response: { ok: true },
    enabled: true,
  });
  state.endpoints.push(ep);
  state.selectedId = ep.id;
  // Force the form to fully reset, ignoring the !state.dirty guard.
  renderEndpointList();
  renderEditorForCreate(ep);
}

function renderEditorForCreate(ep) {
  els.editorEmpty.hidden = true;
  els.editorForm.hidden = false;
  els.endpointId.textContent = `id: ${ep.id.slice(0, 8)}…`;
  // Always write new values, regardless of dirty state
  els.method.value = ep.method;
  els.port.value = ep.port;
  els.path.value = ep.path;
  els.status.value = ep.statusCode || 200;
  els.responseEditor.value = formatJSON(ep.response);
  if (window.__editorMounted) setValue(formatJSON(ep.response));
  els.lastSaved.textContent = '已保存';
  els.lastSaved.style.color = '';
  state.dirty = false;
  updateEditorMeta();
  validateJSON();
  // Focus the path field so the user can immediately type a new path
  els.path.focus();
  els.path.select();
}

async function saveEndpoint() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) return;
  const body = {
    method: els.method.value,
    port: Number(els.port.value),
    path: els.path.value.trim(),
    statusCode: Number(els.status.value) || 200,
    response: (() => { const v = getValue(); return v ? JSON.parse(v) : null; })(),
    enabled: ep.enabled !== false,
  };
  try {
    const updated = await api.updateEndpoint(ep.id, body);
    Object.assign(ep, updated);
    state.dirty = false;
    renderEndpointList();
    flash('已保存', 'green');
  } catch (e) {
    flash('✗ 保存失败', 'red');
  }
}

async function deleteEndpoint() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) return;
  if (!confirm(`确认删除 ${ep.method} ${ep.path}？`)) return;
  await api.deleteEndpoint(ep.id);
  state.endpoints = state.endpoints.filter((e) => e.id !== ep.id);
  state.selectedId = state.endpoints[0]?.id || null;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
  renderStatus();
}

async function toggleRuntime() {
  if (state.runtime === 'running') {
    state.runtime = 'stopped';
    renderStatus();
    await api.runtimeStop();
  } else {
    state.runtime = 'starting';
    renderStatus();
    const result = await api.runtimeStart();
    state.runtime = result.failed && result.failed.length > 0 ? 'failed' : 'running';
    render();
  }
  await refreshRuntimeStatus();
  renderEndpointList();
}

async function refreshRuntimeStatus() {
  try {
    state.runtimeStatus = await api.runtimeStatus();
  } catch {}
  renderEndpointList();
}

// ============================================================
// JSON helpers
// ============================================================
function formatJSON(value) {
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function tryFormat() {
  const text = getValue();
  if (!text.trim()) return;
  try {
    setValue(JSON.stringify(JSON.parse(text), null, 2));
    setValidation('valid', '已格式化');
    markDirty();
  } catch (e) {
    setValidation('invalid', e.message);
  }
}

function validateJSON() {
  const text = getValue().trim();
  if (!text) return setValidation('empty', '空');
  try { JSON.parse(text); setValidation('valid', '合法'); }
  catch { setValidation('invalid', 'JSON 不合法'); }
}

function setValidation(state_, text) {
  els.validationStatus.dataset.state = state_;
  els.validationStatus.querySelector('.val-text').textContent = text;
  els.validationStatus.querySelector('.val-mark').textContent = state_ === 'valid' ? '✓' : state_ === 'invalid' ? '✗' : '·';
}

function updateEditorMeta() {
  const text = getValue();
  const lines = text === '' ? 0 : text.split('\n').length;
  els.lineCount.textContent = `${lines} 行`;
  els.charCount.textContent = `${text.length} 字符`;
}

function flash(text, color) {
  els.lastSaved.textContent = text;
  els.lastSaved.style.color = `var(--${color})`;
  setTimeout(() => {
    els.lastSaved.style.color = state.dirty ? 'var(--amber)' : '';
    els.lastSaved.textContent = state.dirty ? '未保存' : '已保存';
  }, 1600);
}

// ============================================================
// SSE
// ============================================================
function connectSSE() {
  const es = new EventSource('/events');
  es.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    appendLog(entry);
  });
  return es;
}

// ============================================================
// Settings
// ============================================================
function openSettings() {
  els.storagePath.value = state.config.settings.storagePath;
  els.uiPort.value = state.config.settings.uiPort;
  els.settingsModal.hidden = false;
}
function closeSettings() { els.settingsModal.hidden = true; }
async function saveSettings() {
  await api.patchConfig({ storagePath: els.storagePath.value.trim(), uiPort: Number(els.uiPort.value) });
  state.config = await api.getConfig();
  closeSettings();
  flash('已保存 · 重启后生效', 'green');
}

// ============================================================
// Wire events
// ============================================================
els.startStopBtn.addEventListener('click', toggleRuntime);
els.newEndpointBtn.addEventListener('click', createEndpoint);
els.emptyNewBtn.addEventListener('click', createEndpoint);
els.saveBtn.addEventListener('click', saveEndpoint);
els.revertBtn.addEventListener('click', () => { state.dirty = false; renderEditor(); });
els.deleteBtn.addEventListener('click', deleteEndpoint);
els.formatBtn.addEventListener('click', tryFormat);
els.validateBtn.addEventListener('click', validateJSON);
els.clearLogsBtn.addEventListener('click', async () => {
  state.logs = [];
  renderLogsInitial();
  // Persist the clear to the server so it survives a page refresh
  try { await api.clearLogs(); } catch {}
});
els.autoScrollToggle.addEventListener('change', (e) => { state.autoScroll = e.target.checked; });
els.settingsBtn.addEventListener('click', openSettings);
els.settingsBackdrop.addEventListener('click', closeSettings);
els.settingsClose.addEventListener('click', closeSettings);
els.settingsCancel.addEventListener('click', closeSettings);
els.settingsSave.addEventListener('click', saveSettings);

for (const f of [els.method, els.port, els.path, els.status]) {
  f.addEventListener('input', markDirty);
}
// CodeMirror handles its own input; onChange is wired in boot.

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!els.editorForm.hidden) saveEndpoint();
  }
  if (e.key === 'Escape' && !els.settingsModal.hidden) closeSettings();
});

// ============================================================
// Boot
// ============================================================
loadAll().then(() => {
  // Mount CodeMirror after the editor form is rendered.
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  mountEditor({
    initialValue: ep ? formatJSON(ep.response) : '',
    onChange: () => {
      markDirty();
      validateJSON();
      updateEditorMeta();
      schedulePreviewRefresh();
    },
    onSelectionChange: (state) => updateFloatingButton(state),
  });
  // onChange 在 initial mount 时不触发；手动跑一次预览刷新
  if (ep) setTimeout(refreshPreview, 100);
  window.__editorMounted = true;
  connectSSE();
  // Fetch initial runtime status so list LEDs reflect failed/running per port
  refreshRuntimeStatus();
  // Poll every 5s to catch external changes (e.g. someone else binds the port)
  setInterval(refreshRuntimeStatus, 5000);
});

// ============================================================
// Preview pane (right) + Floating dynamic-value button
// ============================================================
const previewPane = $('#previewPane');
const previewBanner = $('#previewBanner');
const previewMeta = $('#previewMeta');
const previewMetaLabel = $('#previewMetaLabel');
const previewExprStat = $('#previewExprStat');
const previewErrStat = $('#previewErrStat');
const previewRefreshBtn = $('#previewRefreshBtn');
const dynamicValueBtn = $('#dynamicValueBtn');
const editorWrap = $('#editorWrap');

let previewDebounceTimer = null;
let lastGoodPreview = null;

function schedulePreviewRefresh() {
  if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(refreshPreview, 300);
}

function setPreviewMeta(state, label, exprCount, errCount) {
  previewMeta.className = 'meta ' + state;
  previewMetaLabel.textContent = label;
  previewExprStat.innerHTML = `表达式 <strong>${exprCount}</strong>`;
  previewErrStat.innerHTML = `错误 <strong>${errCount}</strong>`;
  previewErrStat.style.display = errCount > 0 ? '' : 'none';
}

async function refreshPreview() {
  const text = getValue();
  if (!text.trim()) {
    previewPane.textContent = '// 在左侧编辑响应体，此处显示解析结果';
    setPreviewMeta('', '就绪', 0, 0);
    previewBanner.hidden = true;
    return;
  }
  let res;
  try {
    res = await api.preview(text);
  } catch (e) {
    previewBanner.textContent = '预览暂不可用';
    previewBanner.className = 'preview-banner';
    previewBanner.hidden = false;
    setPreviewMeta('has-errors', '离线', 0, 1);
    return;
  }
  if (!res.ok) {
    previewBanner.textContent = res.error || 'JSON 解析失败';
    previewBanner.className = 'preview-banner';
    previewBanner.hidden = false;
    if (lastGoodPreview !== null) renderPreview(lastGoodPreview, []);
    setPreviewMeta('has-errors', 'JSON 语法错', 0, 1);
    return;
  }
  previewBanner.hidden = true;
  renderPreview(res.resolved, res.errors);
  lastGoodPreview = res.resolved;
  const state = res.errors.length > 0 ? 'has-errors' : 'is-resolved';
  const label = res.errors.length > 0 ? '部分解析' : '已解析';
  setPreviewMeta(state, label, res.exprCount, res.errors.length);
}

/**
 * 用 DOM 节点重建 JSON 输出 —— 实现类型语义着色：
 * - 数值 / boolean / null 用 v-num / v-bool / v-null span（signal-amber / red-dim）
 * - 字符串用 v-str
 * - 键名用 v-key（pencil 灰）
 * - 标点 { } [ ] , : 用 v-punct（faint 极淡）
 * - mixed-fail 的 {{...}} 残留用 expr-error span（红虚线）
 */
function renderPreview(value, errors) {
  previewPane.textContent = '';
  const errorPositions = new Set();
  for (const e of errors) {
    if (typeof e.from === 'number' && typeof e.to === 'number') {
      for (let i = e.from; i < e.to; i++) errorPositions.add(i);
    }
  }
  const json = JSON.stringify(value, null, 2);
  // mixed-fail 残留的 {{...}} 高亮（在字符串内部）
  const re = /\{\{[^}]*\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(json)) !== null) {
    if (m.index > last) appendJsonColored(json.slice(last, m.index));
    const span = document.createElement('span');
    span.className = 'expr-error';
    span.textContent = m[0];
    previewPane.appendChild(span);
    last = m.index + m[0].length;
  }
  if (last < json.length) appendJsonColored(json.slice(last));

  if (errors.length > 0) {
    const errList = document.createElement('div');
    errList.className = 'err-list';
    for (const e of errors) {
      const line = document.createElement('div');
      line.textContent = `⚠ ${e.message}${e.from !== undefined ? `  (col ${e.from}–${e.to})` : ''}`;
      errList.appendChild(line);
    }
    previewPane.appendChild(errList);
  }
  void errorPositions; // 保留供后续按位置染色用
}

/**
 * 把 JSON 文本片段按字符类型染色后插入 previewPane
 * - "  → 切字符串
 * - 数字 → v-num
 * - true/false/null → v-bool / v-null
 * - 字母（键名）→ v-key（连续字母段）
 * - 其余标点 → v-punct
 */
function appendJsonColored(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // 找下一个未转义的 "
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"' && text[j - 1] !== '\\') break;
        j++;
      }
      const lit = document.createElement('span');
      // 判断是 key 还是 str：往前看，跳过空白，看前一个非空字符
      let k = i - 1;
      while (k >= 0 && /\s/.test(text[k])) k--;
      const isKey = k >= 0 && text[k] === ':';
      lit.className = isKey ? 'v-key' : 'v-str';
      lit.textContent = text.slice(i, j + 1);
      previewPane.appendChild(lit);
      i = j + 1;
    } else if (/[0-9-]/.test(c) && (i === 0 || /[\s,:\[]/.test(text[i - 1]))) {
      // 数字
      let j = i;
      while (j < n && /[0-9.eE+\-]/.test(text[j])) j++;
      const span = document.createElement('span');
      span.className = 'v-num';
      span.textContent = text.slice(i, j);
      previewPane.appendChild(span);
      i = j;
    } else if (text.startsWith('true', i) || text.startsWith('false', i)) {
      const span = document.createElement('span');
      span.className = 'v-bool';
      span.textContent = text.slice(i, i + (text.startsWith('true', i) ? 4 : 5));
      previewPane.appendChild(span);
      i += text.startsWith('true', i) ? 4 : 5;
    } else if (text.startsWith('null', i)) {
      const span = document.createElement('span');
      span.className = 'v-null';
      span.textContent = 'null';
      previewPane.appendChild(span);
      i += 4;
    } else if (/[{}\[\],:]/.test(c)) {
      const span = document.createElement('span');
      span.className = 'v-punct';
      span.textContent = c;
      previewPane.appendChild(span);
      i++;
    } else {
      previewPane.appendChild(document.createTextNode(c));
      i++;
    }
  }
}

previewRefreshBtn.addEventListener('click', refreshPreview);

function updateFloatingButton(state) {
  const doc = state.doc;
  const head = state.selection.main.head;
  const text = doc.toString();
  const anchor = findValueAnchorAt(text, head);
  if (!anchor) {
    dynamicValueBtn.hidden = true;
    return;
  }
  const inner = text.slice(anchor.from, anchor.to);
  const hasExpr = /\{\{\$[a-zA-Z_]/.test(inner);
  dynamicValueBtn.textContent = hasExpr ? '编辑表达式' : '动态值';
  const coords = coordsAtPosForRange({ from: anchor.from, to: anchor.to });
  if (!coords) {
    dynamicValueBtn.hidden = true;
    return;
  }
  dynamicValueBtn.style.top = `${coords.top}px`;
  dynamicValueBtn.style.left = `${coords.right + 4}px`;
  dynamicValueBtn.hidden = false;
  dynamicValueBtn.onclick = () => window.__openGeneratorModal?.({
    from: anchor.from,
    to: anchor.to,
    currentValue: inner,
    initialExpr: hasExpr ? extractFirstExpr(inner) : null,
  });
}

/**
 * 找光标所在的 value 锚点 —— 触发规则：
 *   1. 当前行最近一个 `:` 之后只有空白/换行/收尾标点（, } ]），且光标在它后面
 *   2. 该 value 已经包含 `"..."` 引号 → 在引号之间定位
 *   3. 该 value 还没有引号 → 锚点就是 `:` 之后第一个非空白字符的位置（insert 时包引号）
 * 返回 { from, to, hasQuotes } —— from/to 是当前 value 的字符范围（含或不含引号取决于 hasQuotes）
 */
function findValueAnchorAt(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const lineEndRaw = text.indexOf('\n', pos);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const col = pos - lineStart;
  // 在当前行找最近的 `:`（光标之前）
  let colonCol = -1;
  for (let i = col - 1; i >= 0; i--) {
    const ch = line[i];
    if (ch === ':') { colonCol = i; break; }
    if (ch === ',' || ch === '{' || ch === '[' || ch === '}') break;
  }
  if (colonCol < 0) return null;
  // `:` 之后到光标只允许空白
  for (let i = colonCol + 1; i < col; i++) {
    if (!/\s/.test(line[i])) return null;
  }
  // 找 value 起点（`: 之后的第一个非空白）
  const valueStart = (() => {
    for (let i = colonCol + 1; i < line.length; i++) {
      if (!/\s/.test(line[i])) return i;
    }
    return line.length;
  })();
  // 没引号 → 锚点 = `:` 之后到行尾（不含 , } ] 标点）
  // 有引号 → 锚点 = 引号之间
  if (valueStart >= line.length || line[valueStart] !== '"') {
    // 无引号：value 范围是空白之后到第一个 , } ] 或行尾
    let valueEnd = valueStart;
    while (valueEnd < line.length && !/[,}\]]/.test(line[valueEnd])) valueEnd++;
    if (valueStart === valueEnd) return null; // 完全空
    return {
      from: lineStart + valueStart,
      to: lineStart + valueEnd,
      hasQuotes: false,
    };
  }
  // 有引号：找配对右引号
  let j = valueStart + 1;
  while (j < line.length) {
    if (line[j] === '"' && line[j - 1] !== '\\') break;
    j++;
  }
  if (j >= line.length) return null; // 引号未闭合
  // 光标必须在 value 范围内
  if (col < valueStart || col > j) return null;
  return {
    from: lineStart + valueStart + 1,
    to: lineStart + j,
    hasQuotes: true,
  };
}

function extractFirstExpr(s) {
  const m = /\{\{\$[a-zA-Z_][a-zA-Z0-9_.]*(?::[^}]*)?\}\}/.exec(s);
  return m ? m[0] : null;
}

function coordsAtPosForRange(range) {
  const view = getEditorView();
  if (!view) return null;
  try {
    const startCoords = view.coordsAtPos(range.from);
    const line = view.state.doc.lineAt(range.from);
    const endCoords = view.coordsAtPos(line.to);
    if (!startCoords || !endCoords) return null;
    const wrapRect = editorWrap.getBoundingClientRect();
    return {
      top: startCoords.top - wrapRect.top,
      right: endCoords.left - wrapRect.left,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Generator modal behavior
// ============================================================
const generatorModal = $('#generatorModal');
const generatorBackdrop = $('#generatorBackdrop');
const generatorCloseBtn = $('#generatorClose');
const generatorBackBtn = $('#generatorBack');
const generatorLocaleSelect = $('#generatorLocale');
const generatorSearchInput = $('#generatorSearch');
const generatorCategoriesEl = $('#generatorCategories');
const generatorExprText = $('#generatorExprText');
const generatorSampleText = $('#generatorSampleText');
const generatorInsertBtn = $('#generatorInsertBtn');

let generatorCatalog = null;
const generatorState = {
  selectedId: null,
  args: {},
  pendingRange: null,
  filterText: '',
};

async function openGeneratorModal({ from, to, currentValue, initialExpr, hasQuotes }) {
  generatorState.pendingRange = { from, to, hasQuotes: hasQuotes !== false };
  if (!generatorCatalog) {
    generatorCatalog = await api.getGenerators();
  }
  if (initialExpr) {
    const parsed = parseInlineExpression(initialExpr);
    if (parsed) {
      generatorState.selectedId = parsed.id;
      const def = findGeneratorDef(parsed.id);
      generatorState.args = {};
      if (def) for (const a of def.args) generatorState.args[a.name] = parsed.args[Object.keys(parsed.args)[def.args.indexOf(a)]] ?? a.default;
    }
  } else {
    generatorState.selectedId = null;
    generatorState.args = {};
  }
  generatorSearchInput.value = '';
  generatorState.filterText = '';
  renderGeneratorCategories();
  updateGeneratorExprAndSample();
  generatorModal.hidden = false;
}

function parseInlineExpression(s) {
  const m = /^\{\{\$([a-zA-Z_][a-zA-Z0-9_.]*)(?::([^}]*))?\}\}$/.exec(s.trim());
  if (!m) return null;
  const args = {};
  if (m[2]) m[2].split(':').forEach((p, i) => { args[i] = p; });
  return { id: m[1], args };
}

function findGeneratorDef(id) {
  if (!generatorCatalog) return null;
  for (const cat of generatorCatalog.categories) {
    const g = cat.generators.find((x) => x.id === id);
    if (g) return g;
  }
  return null;
}

function renderGeneratorCategories() {
  if (!generatorCatalog) return;
  generatorCategoriesEl.innerHTML = '';
  const filter = generatorState.filterText.toLowerCase();
  for (const cat of generatorCatalog.categories) {
    const filtered = cat.generators.filter((g) => {
      if (!filter) return true;
      return g.label.toLowerCase().includes(filter) || g.id.toLowerCase().includes(filter);
    });
    if (filtered.length === 0) continue;
    const catEl = document.createElement('div');
    catEl.className = 'gen-cat';
    const header = document.createElement('div');
    header.className = 'gen-cat-header';
    header.innerHTML = `<span>› ${cat.label}</span>`;
    catEl.appendChild(header);
    const list = document.createElement('div');
    list.className = 'gen-cat-list';
    for (const g of filtered) {
      const item = document.createElement('div');
      item.className = 'gen-item' + (g.id === generatorState.selectedId ? ' is-selected' : '');
      item.innerHTML = `<span class="gen-item-label">${g.label}</span><span class="gen-item-type">$${g.id}</span>`;
      item.addEventListener('click', () => {
        generatorState.selectedId = g.id;
        const def = findGeneratorDef(g.id);
        generatorState.args = {};
        if (def) for (const a of def.args) generatorState.args[a.name] = a.default;
        renderGeneratorCategories();
        updateGeneratorExprAndSample();
      });
      list.appendChild(item);
      if (g.id === generatorState.selectedId) {
        const def = findGeneratorDef(g.id);
        if (def && def.args.length > 0) {
          const argsEl = document.createElement('div');
          argsEl.className = 'gen-args';
          for (const a of def.args) {
            const label = document.createElement('label');
            const nameSpan = document.createElement('span');
            nameSpan.textContent = a.name;
            label.appendChild(nameSpan);
            let input;
            if (a.type === 'locale') {
              input = document.createElement('select');
              for (const loc of ['zh_CN', 'en']) {
                const opt = document.createElement('option');
                opt.value = loc;
                opt.textContent = loc;
                if (loc === (generatorState.args[a.name] || a.default)) opt.selected = true;
                input.appendChild(opt);
              }
              input.addEventListener('change', () => {
                generatorState.args[a.name] = input.value;
                updateGeneratorExprAndSample();
              });
            } else {
              input = document.createElement('input');
              input.type = (a.type === 'int' || a.type === 'float') ? 'number' : 'text';
              const cur = generatorState.args[a.name] ?? a.default;
              input.value = (cur === undefined || cur === null) ? '' : cur;
              input.addEventListener('input', () => {
                generatorState.args[a.name] = input.value;
                updateGeneratorExprAndSample();
              });
            }
            label.appendChild(input);
            argsEl.appendChild(label);
          }
          list.appendChild(argsEl);
        }
      }
    }
    catEl.appendChild(list);
    generatorCategoriesEl.appendChild(catEl);
  }
}

function buildExprText(id, args) {
  const def = findGeneratorDef(id);
  if (!def) return '';
  const argVals = def.args.map((a) => args[a.name] ?? a.default);
  const allFilled = argVals.every((v) => v !== undefined && v !== '');
  if (!allFilled) return `{{$${id}}}`;
  return `{{$${id}:${argVals.join(':')}}}`;
}

let sampleTimer = null;
function updateGeneratorExprAndSample() {
  const id = generatorState.selectedId;
  if (!id) {
    generatorExprText.textContent = '—';
    generatorSampleText.textContent = '—';
    generatorInsertBtn.disabled = true;
    return;
  }
  generatorInsertBtn.disabled = false;
  const expr = buildExprText(id, generatorState.args);
  generatorExprText.textContent = expr;
  if (sampleTimer) clearTimeout(sampleTimer);
  sampleTimer = setTimeout(async () => {
    const res = await api.getGeneratorSample(id, normalizeArgs(id, generatorState.args));
    generatorSampleText.textContent = res.ok ? String(res.sample) : (res.error || '生成失败');
  }, 200);
}

function normalizeArgs(id, args) {
  const def = findGeneratorDef(id);
  if (!def) return {};
  const out = {};
  for (const a of def.args) {
    const v = args[a.name];
    if (v === undefined || v === '') continue;
    if (a.type === 'int') {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) out[a.name] = n;
    } else if (a.type === 'float') {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) out[a.name] = n;
    } else {
      out[a.name] = String(v);
    }
  }
  return out;
}

function closeGeneratorModal() {
  generatorModal.hidden = true;
}

generatorCloseBtn.addEventListener('click', closeGeneratorModal);
generatorBackdrop.addEventListener('click', closeGeneratorModal);
generatorBackBtn.addEventListener('click', closeGeneratorModal);
generatorSearchInput.addEventListener('input', () => {
  generatorState.filterText = generatorSearchInput.value;
  renderGeneratorCategories();
});
generatorLocaleSelect.addEventListener('change', () => {
  // v1: locale 切换仅影响 person/location 类生成器显示的 label 提示
});

generatorInsertBtn.addEventListener('click', () => {
  const id = generatorState.selectedId;
  if (!id || !generatorState.pendingRange) return;
  const expr = buildExprText(id, generatorState.args);
  const view = getEditorView();
  const { from, to, hasQuotes } = generatorState.pendingRange;
  const replacement = hasQuotes ? expr : `"${expr}"`;
  const newCursor = from + (hasQuotes ? 0 : 1);
  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: { anchor: newCursor, head: newCursor + expr.length },
  });
  closeGeneratorModal();
});

window.__openGeneratorModal = openGeneratorModal;
