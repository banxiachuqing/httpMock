// 首页：端口卡片渲染 + 新建端口弹窗
import { navigate } from '../router.js';
import { showToast } from '../toast.js';

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function latestLogByPort(logs) {
  const latest = new Map();
  for (const entry of logs) {
    if (!entry.method) continue; // 过滤 resolver-warn 条目
    const prev = latest.get(entry.port);
    if (!prev || entry.timestamp > prev.timestamp) latest.set(entry.port, entry);
  }
  return latest;
}

function endpointLabel(entry, endpoints) {
  if (entry.operationName) return entry.operationName === '?wsdl' ? '?wsdl' : entry.operationName;
  if (!entry.matched || !entry.endpointId) return `无路由 · ${entry.path}`;
  const ep = endpoints.find((e) => e.id === entry.endpointId);
  if (ep?.name) return ep.name;
  return ep ? `${ep.method} ${ep.path}` : entry.path;
}

function buildCard(p, state, lastEntry, api) {
  const isWs = p.type === 'ws';
  const card = document.createElement('article');
  card.className = 'port-card';
  card.dataset.port = String(p.port);
  card.dataset.enabled = String(p.enabled !== false);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `端口 ${p.port} 详情`);

  const portStatus = state.runtimeStatus[String(p.port)];
  const ledState = portStatus?.state === 'failed' ? 'failed'
    : portStatus?.state === 'running' ? 'running' : 'stopped';

  const head = document.createElement('header');
  head.className = 'port-card-head';

  const badge = document.createElement('span');
  badge.className = 'port-type-badge';
  badge.dataset.type = isWs ? 'ws' : 'http';
  badge.textContent = isWs ? 'WS' : 'HTTP';

  const num = document.createElement('span');
  num.className = 'port-card-number mono';
  num.textContent = `:${p.port}`;

  const led = document.createElement('span');
  led.className = 'led led-mini';
  led.dataset.state = ledState;

  const toggle = document.createElement('label');
  toggle.className = 'toggle port-card-toggle';
  toggle.addEventListener('click', (e) => e.stopPropagation());
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = p.enabled !== false;
  checkbox.setAttribute('aria-label', `启用端口 ${p.port}`);
  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    try {
      const updated = await api.updatePort(p.port, { enabled: checkbox.checked });
      Object.assign(p, updated);
      card.dataset.enabled = String(p.enabled !== false);
    } catch (e) {
      checkbox.checked = !checkbox.checked;
      showToast({ type: 'error', message: '切换失败：' + (e?.message || '未知错误') });
    } finally {
      checkbox.disabled = false;
    }
  });
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'toggle-label';
  toggleLabel.textContent = '启用';
  toggle.append(checkbox, toggleLabel);

  head.append(num, badge, led, toggle);

  const stats = document.createElement('dl');
  stats.className = 'port-card-stats';

  const epRow = document.createElement('div');
  const epDt = document.createElement('dt');
  const epDd = document.createElement('dd');
  if (isWs) {
    const svcs = (state.services || []).filter((s) => s.port === p.port);
    const opsCount = svcs.reduce((n, s) => n + (s.operations?.length || 0), 0);
    epDt.textContent = '服务';
    epDd.textContent = `${svcs.length} 个 · ${opsCount} 操作`;
  } else {
    const eps = state.endpoints.filter((e) => e.port === p.port);
    const disabledCount = eps.filter((e) => e.enabled === false).length;
    epDt.textContent = '接口';
    epDd.textContent = disabledCount > 0
      ? `${eps.length} 个 · ${disabledCount} 个禁用`
      : `${eps.length} 个`;
  }
  epRow.append(epDt, epDd);

  const lastRow = document.createElement('div');
  const lastDt = document.createElement('dt');
  lastDt.textContent = '最近请求';
  const lastDd = document.createElement('dd');
  lastDd.className = 'port-card-last';
  if (lastEntry) {
    const nameSpan = document.createElement('span');
    nameSpan.textContent = endpointLabel(lastEntry, state.endpoints);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'port-card-time';
    timeSpan.textContent = relativeTime(lastEntry.timestamp);
    lastDd.append(nameSpan, timeSpan);
  } else {
    lastDd.textContent = '—';
  }
  lastRow.append(lastDt, lastDd);

  stats.append(epRow, lastRow);
  card.append(head, stats);

  const open = () => navigate(`#/port/${p.port}`);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

function buildNewCard() {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'port-card port-card-new';
  card.id = 'newPortCard';
  card.innerHTML = '<span class="plus">+</span><span>新建端口</span>';
  return card;
}

export function renderPortCards(state, { grid, countEl, api, onNewPort }) {
  grid.innerHTML = '';
  countEl.textContent = String(state.ports.length);
  if (state.ports.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'port-empty-hint';
    hint.textContent = '还没有端口。点击"+ 新建端口"创建第一个 mock 端口。';
    grid.appendChild(hint);
  }
  const latest = latestLogByPort(state.logs);
  for (const p of state.ports) {
    grid.appendChild(buildCard(p, state, latest.get(p.port), api));
  }
  const newCard = buildNewCard();
  newCard.addEventListener('click', onNewPort);
  grid.appendChild(newCard);
}

export function nextFreePort(ports, start = 8080) {
  const used = new Set(ports.map((p) => p.port));
  let port = start;
  while (used.has(port)) port++;
  return port;
}

export function initNewPortDialog({ els, state, api }) {
  const open = () => {
    els.newPortNumber.value = String(nextFreePort(state.ports));
    els.newPortError.hidden = true;
    els.newPortModal.querySelector('input[name="newPortType"][value="http"]').checked = true;
    els.newPortModal.hidden = false;
    els.newPortNumber.focus();
    els.newPortNumber.select();
  };
  const close = () => { els.newPortModal.hidden = true; };
  const fail = (msg) => {
    els.newPortError.textContent = msg;
    els.newPortError.hidden = false;
  };
  const submit = async () => {
    const port = Number(els.newPortNumber.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail('端口号必须是 1–65535 的整数');
    }
    if (state.ports.some((p) => p.port === port)) {
      return fail(`端口 ${port} 已存在`);
    }
    const type = els.newPortModal.querySelector('input[name="newPortType"]:checked')?.value || 'http';
    try {
      await api.createPort(port, type);
      state.ports = await api.listPorts();
      close();
      navigate(`#/port/${port}`);
    } catch (e) {
      fail(e?.message || '创建失败');
    }
  };

  els.newPortClose.addEventListener('click', close);
  els.newPortBackdrop.addEventListener('click', close);
  els.newPortCancel.addEventListener('click', close);
  els.newPortCreate.addEventListener('click', submit);
  els.newPortNumber.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  return { open, close };
}