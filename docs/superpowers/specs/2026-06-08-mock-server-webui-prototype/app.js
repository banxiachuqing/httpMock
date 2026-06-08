// Mock//Server — Mission Bridge UI prototype
// Static, in-memory only. No backend.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ============================================================
// Mock data
// ============================================================
const SAMPLE_ENDPOINTS = [
  {
    id: 'a1b2c3d4-1111-4000-8000-000000000001',
    method: 'GET',
    port: 8080,
    path: '/api/users',
    statusCode: 200,
    response: {
      users: [
        { id: 1, name: 'Ada Lovelace', role: 'admin' },
        { id: 2, name: 'Linus Torvalds', role: 'editor' },
        { id: 3, name: 'Grace Hopper', role: 'viewer' },
      ],
      total: 3,
      page: 1,
    },
  },
  {
    id: 'a1b2c3d4-2222-4000-8000-000000000002',
    method: 'POST',
    port: 8080,
    path: '/api/orders',
    statusCode: 201,
    response: {
      ok: true,
      orderId: 'ord_8f3a2c1b',
      createdAt: '2026-06-08T12:34:56.789Z',
    },
  },
  {
    id: 'a1b2c3d4-3333-4000-8000-000000000003',
    method: 'GET',
    port: 9090,
    path: '/health',
    statusCode: 200,
    response: { status: 'up', uptime: 4218 },
  },
  {
    id: 'a1b2c3d4-4444-4000-8000-000000000004',
    method: 'DELETE',
    port: 8080,
    path: '/api/users/:id',
    statusCode: 204,
    response: null,
  },
];

// ============================================================
// State
// ============================================================
const state = {
  endpoints: structuredClone(SAMPLE_ENDPOINTS),
  selectedId: SAMPLE_ENDPOINTS[0].id,
  dirty: false,
  original: null,
  runtime: 'stopped', // 'stopped' | 'starting' | 'running' | 'failed'
  logs: [],
  autoScroll: true,
  simulate: false,
  settings: {
    storagePath: '~/Documents/MockServer',
    uiPort: 5050,
  },
};

// ============================================================
// DOM refs
// ============================================================
const els = {
  startStopBtn: $('#startStopBtn'),
  globalStatus: $('#globalStatus'),
  statusDetail: $('#statusDetail'),
  settingsBtn: $('#settingsBtn'),
  newEndpointBtn: $('#newEndpointBtn'),
  emptyNewBtn: $('#emptyNewBtn'),
  endpointList: $('#endpointList'),
  endpointCount: $('#endpointCount'),
  portSummaryList: $('#portSummaryList'),
  editor: $('#editor'),
  editorEmpty: $('#editorEmpty'),
  editorForm: $('#editorForm'),
  endpointId: $('#endpointId'),
  lastSaved: $('#lastSaved'),
  method: $('#method'),
  port: $('#port'),
  path: $('#path'),
  status: $('#status'),
  responseEditor: $('#responseEditor'),
  validationStatus: $('#validationStatus'),
  formatBtn: $('#formatBtn'),
  validateBtn: $('#validateBtn'),
  saveBtn: $('#saveBtn'),
  revertBtn: $('#revertBtn'),
  deleteBtn: $('#deleteBtn'),
  lineCount: $('#lineCount'),
  charCount: $('#charCount'),
  logsBody: $('#logsBody'),
  logsEmpty: $('#logsEmpty'),
  logsCount: $('#logsCount'),
  logsStatus: $('#logsStatus'),
  autoScrollToggle: $('#autoScrollToggle'),
  simulateToggle: $('#simulateToggle'),
  clearLogsBtn: $('#clearLogsBtn'),
  settingsModal: $('#settingsModal'),
  settingsBackdrop: $('#settingsBackdrop'),
  settingsClose: $('#settingsClose'),
  settingsCancel: $('#settingsCancel'),
  settingsSave: $('#settingsSave'),
  storagePath: $('#storagePath'),
  uiPort: $('#uiPort'),
};

// ============================================================
// Initial render
// ============================================================
function render() {
  renderEndpointList();
  renderEditor();
  renderLogs();
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
    li.innerHTML = `
      <span class="endpoint-method" data-method="${ep.method}">${ep.method}</span>
      <div class="endpoint-main">
        <div class="endpoint-path">${escapeHtml(ep.path)}</div>
        <div class="endpoint-port">${ep.port}</div>
      </div>
      <div class="endpoint-status">
        <span class="led led-mini" data-state="${ep.id === state.selectedId && state.runtime === 'running' ? 'running' : 'stopped'}"></span>
      </div>
    `;
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
    els.status.value = ep.statusCode;
    els.responseEditor.value = formatJSON(ep.response);
    state.original = structuredClone(ep);
    els.lastSaved.textContent = 'saved · just now';
  }
  updateEditorMeta();
  validateJSON();
}

function renderLogs() {
  // Remove empty state if we have logs
  if (state.logs.length > 0 && els.logsEmpty.parentNode) {
    els.logsEmpty.parentNode.removeChild(els.logsEmpty);
  }
  // Re-render
  els.logsBody.innerHTML = '';
  if (state.logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.innerHTML = `
      <span class="logs-empty-mark">//</span>
      <span>No requests yet. Click <strong>ARM</strong> to start the mock engine.</span>
    `;
    els.logsBody.appendChild(empty);
    els.logsCount.textContent = `0 entries · max 500`;
    return;
  }
  for (const entry of state.logs) {
    els.logsBody.appendChild(renderLogEntry(entry));
  }
  els.logsCount.textContent = `${state.logs.length} entries · max 500`;
  if (state.autoScroll) {
    els.logsBody.scrollTop = els.logsBody.scrollHeight;
  }
}

function renderLogEntry(entry) {
  const row = document.createElement('div');
  row.className = `log-entry ${entry.matched ? 'matched' : 'missed'}`;
  const range = `${Math.floor(entry.status / 100)}xx`;
  const time = new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false });
  row.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-method" style="color: var(--method-${entry.method.toLowerCase()})">${entry.method}</span>
    <span class="log-path">${escapeHtml(entry.path)}</span>
    <span class="log-port">${entry.port}</span>
    <span class="log-status" data-range="${range}">${entry.status}</span>
    <span class="log-duration">${entry.durationMs}</span>
    <span class="log-result">${entry.matched ? 'match' : 'no route'}</span>
  `;
  return row;
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 500) {
    state.logs.splice(0, state.logs.length - 500);
  }
  if (els.logsEmpty.parentNode) {
    els.logsEmpty.parentNode.removeChild(els.logsEmpty);
  }
  els.logsBody.appendChild(renderLogEntry(entry));
  els.logsCount.textContent = `${state.logs.length} entries · max 500`;
  if (state.autoScroll) {
    els.logsBody.scrollTop = els.logsBody.scrollHeight;
  }
}

function renderStatus() {
  const btn = els.startStopBtn;
  const pill = els.globalStatus;
  const led = pill.querySelector('.led');
  const ledBtn = btn.querySelector('.btn-led');
  const label = btn.querySelector('.btn-label');
  const text = pill.querySelector('.status-text');

  btn.dataset.state = state.runtime;
  pill.dataset.state = state.runtime;
  led.dataset.state = state.runtime;

  const map = {
    stopped: { text: 'STOPPED', label: 'ARM', detail: 'all ports idle' },
    starting: { text: 'STARTING', label: 'STARTING…', detail: 'binding sockets' },
    running: { text: 'RUNNING', label: 'STOP', detail: `${new Set(state.endpoints.map((e) => e.port)).size} port(s) live` },
    failed: { text: 'FAILED', label: 'RETRY', detail: 'see endpoint list' },
  };
  const m = map[state.runtime];
  text.textContent = m.text;
  label.textContent = m.label;
  els.statusDetail.textContent = m.detail;
}

// ============================================================
// Actions
// ============================================================
function selectEndpoint(id) {
  if (state.dirty) {
    if (!confirm('You have unsaved changes. Discard?')) return;
  }
  state.selectedId = id;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
}

function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  els.lastSaved.textContent = 'unsaved changes';
  els.lastSaved.style.color = 'var(--amber)';
}

function clearDirty() {
  state.dirty = false;
  els.lastSaved.style.color = '';
  els.lastSaved.textContent = 'saved · just now';
}

function createEndpoint() {
  const ep = {
    id: crypto.randomUUID(),
    method: 'GET',
    port: 8080,
    path: '/api/new',
    statusCode: 200,
    response: { ok: true },
  };
  state.endpoints.push(ep);
  state.selectedId = ep.id;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
  els.path.focus();
  els.path.select();
}

function saveEndpoint() {
  // Validate JSON
  const text = els.responseEditor.value.trim();
  if (text.length > 0) {
    try {
      JSON.parse(text);
    } catch (e) {
      flashValidation('invalid', `parse error`);
      els.responseEditor.focus();
      return;
    }
  }
  // Validate fields
  const port = parseInt(els.port.value, 10);
  if (!(port >= 1 && port <= 65535)) {
    flashError('port must be 1–65535');
    return;
  }
  const path = els.path.value.trim();
  if (!path.startsWith('/')) {
    flashError('path must start with /');
    return;
  }
  // Uniqueness
  const method = els.method.value;
  const conflict = state.endpoints.find(
    (e) => e.id !== state.selectedId && e.port === port && e.method === method && e.path === path,
  );
  if (conflict) {
    flashError('endpoint (port, method, path) already exists');
    return;
  }

  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  ep.method = method;
  ep.port = port;
  ep.path = path;
  ep.statusCode = parseInt(els.status.value, 10) || 200;
  ep.response = text.length > 0 ? JSON.parse(text) : null;
  state.dirty = false;
  clearDirty();
  renderEndpointList();
  flashSuccess('saved');
}

function revertEndpoint() {
  if (!state.dirty) return;
  state.dirty = false;
  renderEditor();
}

function deleteEndpoint() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) return;
  if (!confirm(`Delete ${ep.method} ${ep.path}?`)) return;
  state.endpoints = state.endpoints.filter((e) => e.id !== state.selectedId);
  state.selectedId = state.endpoints[0]?.id || null;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
  renderStatus();
}

async function toggleRuntime() {
  if (state.runtime === 'stopped' || state.runtime === 'failed') {
    state.runtime = 'starting';
    renderStatus();
    await sleep(900);
    state.runtime = 'running';
    renderStatus();
    renderEndpointList();
  } else if (state.runtime === 'running') {
    state.runtime = 'stopped';
    renderStatus();
    renderEndpointList();
  }
}

function clearLogs() {
  state.logs = [];
  renderLogs();
}

// ============================================================
// JSON helpers
// ============================================================
function formatJSON(value) {
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function tryFormat() {
  const text = els.responseEditor.value;
  if (!text.trim()) return;
  try {
    const parsed = JSON.parse(text);
    els.responseEditor.value = JSON.stringify(parsed, null, 2);
    flashValidation('valid', 'formatted');
    markDirty();
  } catch (e) {
    flashValidation('invalid', e.message);
  }
}

function validateJSON() {
  const text = els.responseEditor.value.trim();
  if (!text) {
    setValidation('empty', 'empty');
    return;
  }
  try {
    JSON.parse(text);
    setValidation('valid', 'valid');
  } catch (e) {
    setValidation('invalid', 'invalid JSON');
  }
}

function setValidation(state_, text) {
  els.validationStatus.dataset.state = state_;
  els.validationStatus.querySelector('.val-text').textContent = text;
  els.validationStatus.querySelector('.val-mark').textContent =
    state_ === 'valid' ? '✓' : state_ === 'invalid' ? '✗' : '·';
}

function flashValidation(state_, text) {
  setValidation(state_, text);
  setTimeout(validateJSON, 1600);
}

function updateEditorMeta() {
  const text = els.responseEditor.value;
  const lines = text === '' ? 0 : text.split('\n').length;
  els.lineCount.textContent = `${lines} line${lines === 1 ? '' : 's'}`;
  els.charCount.textContent = `${text.length} char${text.length === 1 ? '' : 's'}`;
}

// ============================================================
// Tab key handling
// ============================================================
els.responseEditor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = els.responseEditor.selectionStart;
    const end = els.responseEditor.selectionEnd;
    const text = els.responseEditor.value;
    els.responseEditor.value = text.substring(0, start) + '  ' + text.substring(end);
    els.responseEditor.selectionStart = els.responseEditor.selectionEnd = start + 2;
    markDirty();
    validateJSON();
    updateEditorMeta();
  }
});

// ============================================================
// Log simulator
// ============================================================
const SIMULATOR_METHODS = ['GET', 'GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE', 'HEAD'];
const SIMULATOR_PATHS = [
  '/api/users',
  '/api/users/1',
  '/api/orders',
  '/api/orders?status=pending',
  '/health',
  '/api/unknown',
  '/api/products',
  '/api/products/42',
];
let simInterval = null;

function startSimulator() {
  if (simInterval) return;
  simInterval = setInterval(() => {
    if (state.runtime !== 'running') return;
    const method = SIMULATOR_METHODS[Math.floor(Math.random() * SIMULATOR_METHODS.length)];
    let path = SIMULATOR_PATHS[Math.floor(Math.random() * SIMULATOR_PATHS.length)];
    // Sometimes add a query string
    if (Math.random() < 0.3 && !path.includes('?')) {
      path += `?t=${Math.floor(Math.random() * 1000)}`;
    }
    // Sometimes a totally random path (404)
    if (Math.random() < 0.2) {
      path = '/api/random-' + Math.floor(Math.random() * 9999);
    }
    const matchedEp = state.endpoints.find((e) => e.method === method && e.path === path);
    const port = matchedEp ? matchedEp.port : (state.endpoints[0]?.port || 8080);
    const duration = Math.floor(Math.random() * 25) + 1;
    const status = matchedEp ? matchedEp.statusCode : 404;
    appendLog({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      method,
      path,
      port,
      status,
      durationMs: duration,
      matched: !!matchedEp,
    });
  }, 1100);
}

function stopSimulator() {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
}

// ============================================================
// Settings modal
// ============================================================
function openSettings() {
  els.storagePath.value = state.settings.storagePath;
  els.uiPort.value = state.settings.uiPort;
  els.settingsModal.hidden = false;
}
function closeSettings() {
  els.settingsModal.hidden = true;
}
function saveSettings() {
  state.settings.storagePath = els.storagePath.value.trim();
  state.settings.uiPort = parseInt(els.uiPort.value, 10) || 5050;
  closeSettings();
  flashSuccess('settings saved (restart to apply)');
}

// ============================================================
// Flash messages
// ============================================================
function flashError(msg) {
  els.lastSaved.textContent = '✗ ' + msg;
  els.lastSaved.style.color = 'var(--red)';
  setTimeout(() => {
    els.lastSaved.style.color = state.dirty ? 'var(--amber)' : '';
    els.lastSaved.textContent = state.dirty ? 'unsaved changes' : 'saved · just now';
  }, 2400);
}

function flashSuccess(msg) {
  els.lastSaved.textContent = '✓ ' + msg;
  els.lastSaved.style.color = 'var(--green)';
  setTimeout(() => {
    els.lastSaved.style.color = '';
    els.lastSaved.textContent = 'saved · just now';
  }, 1600);
}

// ============================================================
// Utilities
// ============================================================
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// Event wiring
// ============================================================
els.startStopBtn.addEventListener('click', toggleRuntime);
els.settingsBtn.addEventListener('click', openSettings);
els.settingsBackdrop.addEventListener('click', closeSettings);
els.settingsClose.addEventListener('click', closeSettings);
els.settingsCancel.addEventListener('click', closeSettings);
els.settingsSave.addEventListener('click', saveSettings);
els.newEndpointBtn.addEventListener('click', createEndpoint);
els.emptyNewBtn.addEventListener('click', createEndpoint);
els.saveBtn.addEventListener('click', saveEndpoint);
els.revertBtn.addEventListener('click', revertEndpoint);
els.deleteBtn.addEventListener('click', deleteEndpoint);
els.formatBtn.addEventListener('click', tryFormat);
els.validateBtn.addEventListener('click', validateJSON);
els.clearLogsBtn.addEventListener('click', clearLogs);

els.autoScrollToggle.addEventListener('change', (e) => {
  state.autoScroll = e.target.checked;
});
els.simulateToggle.addEventListener('change', (e) => {
  state.simulate = e.target.checked;
  if (state.simulate) startSimulator();
  else stopSimulator();
  els.logsStatus.querySelector('span:last-child').textContent = state.simulate ? 'simulating' : 'idle';
  els.logsStatus.querySelector('.led-mini').dataset.state = state.simulate ? 'running' : 'stopped';
});

for (const f of [els.method, els.port, els.path, els.status]) {
  f.addEventListener('input', markDirty);
}
els.responseEditor.addEventListener('input', () => {
  markDirty();
  validateJSON();
  updateEditorMeta();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!els.editorForm.hidden) saveEndpoint();
  }
  if (e.key === 'Escape' && !els.settingsModal.hidden) {
    closeSettings();
  }
});

// ============================================================
// First render
// ============================================================
render();
startSimulator(); // start idle so SIMULATE toggle works
stopSimulator();
