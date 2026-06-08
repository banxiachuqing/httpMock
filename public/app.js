// Mock//Server — production UI
// Talks to /api/* and /events.

import { mountEditor, getValue, setValue } from './editor.js';

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
    const isRunning = state.runtime === 'running';
    li.innerHTML = `
      <span class="endpoint-method" data-method="${ep.method}">${ep.method}</span>
      <div class="endpoint-main">
        <div class="endpoint-path"></div>
        <div class="endpoint-port">${ep.port}</div>
      </div>
      <div class="endpoint-status">
        <span class="led led-mini" data-state="${isRunning ? 'running' : 'stopped'}"></span>
      </div>
    `;
    li.querySelector('.endpoint-path').textContent = ep.path;
    li.addEventListener('click', () => selectEndpoint(ep.id));
    els.endpointList.appendChild(li);
  }
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
  row.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-method" style="color: var(--method-${entry.method.toLowerCase()})">${entry.method}</span>
    <span class="log-path"></span>
    <span class="log-port">${entry.port}</span>
    <span class="log-status" data-range="${range}">${entry.status}</span>
    <span class="log-duration">${entry.durationMs}</span>
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
  renderLogsInitial();
  render();
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
  const ep = await api.createEndpoint({
    method: 'GET', port: 8080, path: '/api/new',
    statusCode: 200, response: { ok: true }, enabled: true,
  });
  state.endpoints.push(ep);
  state.selectedId = ep.id;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
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
els.clearLogsBtn.addEventListener('click', () => { state.logs = []; renderLogsInitial(); });
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
    onChange: () => { markDirty(); validateJSON(); updateEditorMeta(); },
  });
  window.__editorMounted = true;
  connectSSE();
});
