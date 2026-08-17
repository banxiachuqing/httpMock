// WS 端口详情页：服务卡片网格 + 新建服务弹窗（spec §6.②）
import { navigate } from '../router.js';
import { showToast } from '../toast.js';

/** 服务的访问地址（注意：UI 端口 ≠ mock 端口，必须用 service.port） */
export function serviceAddress(s) {
  return `${location.protocol}//${location.hostname}:${s.port}${s.path}`;
}

function buildServiceCard(s, { api, onImport, onChanged }) {
  const card = document.createElement('article');
  card.className = 'port-card service-card';
  card.dataset.serviceId = s.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `服务 ${s.name} 详情`);

  const head = document.createElement('header');
  head.className = 'port-card-head';
  const name = document.createElement('span');
  name.className = 'service-name';
  name.textContent = s.name;
  const wsdlBadge = document.createElement('span');
  wsdlBadge.className = 'wsdl-badge';
  wsdlBadge.dataset.state = s.hasWsdl ? 'loaded' : 'none';
  wsdlBadge.textContent = s.hasWsdl ? 'WSDL' : '无 WSDL';
  head.append(name, wsdlBadge);

  const stats = document.createElement('dl');
  stats.className = 'port-card-stats';
  const pathRow = document.createElement('div');
  const pathDt = document.createElement('dt');
  pathDt.textContent = '路径';
  const pathDd = document.createElement('dd');
  pathDd.className = 'mono';
  pathDd.textContent = s.path;
  pathRow.append(pathDt, pathDd);
  const opRow = document.createElement('div');
  const opDt = document.createElement('dt');
  opDt.textContent = '操作';
  const opDd = document.createElement('dd');
  const opCount = (s.operations || []).length;
  const disabledCount = (s.operations || []).filter((o) => o.enabled === false).length;
  opDd.textContent = disabledCount > 0 ? `${opCount} 个 · ${disabledCount} 个禁用` : `${opCount} 个`;
  opRow.append(opDt, opDd);
  stats.append(pathRow, opRow);

  const actions = document.createElement('div');
  actions.className = 'service-card-actions';
  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-sm';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  actions.append(
    mkBtn('复制地址', '复制服务地址', () => navigator.clipboard.writeText(serviceAddress(s))),
    mkBtn('?wsdl', '复制 WSDL 地址', () => navigator.clipboard.writeText(`${serviceAddress(s)}?wsdl`)),
    mkBtn('导入', '导入 / 替换 WSDL', () => onImport(s)),
    mkBtn('删除', '删除服务', async () => {
      if (!confirm(`确认删除服务 ${s.name}（${s.path}）？其下 ${opCount} 个操作将一并删除。`)) return;
      try {
        await api.deleteService(s.id);
        await onChanged();
      } catch (e) {
        showToast({ type: 'error', message: '删除失败：' + (e?.message || '未知错误') });
      }
    }),
  );

  card.append(head, stats, actions);
  const open = () => navigate(`#/port/${s.port}/svc/${s.id}`);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  return card;
}

export function renderServiceCards(state, { grid, countEl, api, onNewService, onImport, onChanged }) {
  const port = state.route.port;
  const services = (state.services || []).filter((s) => s.port === port);
  grid.innerHTML = '';
  countEl.textContent = String(services.length);
  if (services.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'port-empty-hint';
    hint.textContent = '这个 WebService 端口还没有服务。点击"+ 新建服务"创建第一个。';
    grid.appendChild(hint);
  }
  for (const s of services) {
    grid.appendChild(buildServiceCard(s, { api, onImport, onChanged }));
  }
  const newCard = document.createElement('button');
  newCard.type = 'button';
  newCard.className = 'port-card port-card-new';
  newCard.id = 'newServiceCard';
  newCard.innerHTML = '<span class="plus">+</span><span>新建服务</span>';
  newCard.addEventListener('click', onNewService);
  grid.appendChild(newCard);
}

export function initNewServiceDialog({ els, state, api, onCreated }) {
  const open = () => {
    els.newServiceName.value = '';
    els.newServicePath.value = '/ws/';
    els.newServiceError.hidden = true;
    els.newServiceModal.hidden = false;
    els.newServiceName.focus();
  };
  const close = () => {
    els.newServiceModal.hidden = true;
  };
  const fail = (msg) => {
    els.newServiceError.textContent = msg;
    els.newServiceError.hidden = false;
  };
  const submit = async () => {
    const name = els.newServiceName.value.trim();
    const path = els.newServicePath.value.trim();
    if (!path.startsWith('/')) return fail('路径必须以 / 开头');
    if (path.includes('?')) return fail('路径不能包含 ?');
    try {
      const svc = await api.createService({
        port: state.route.port,
        path,
        ...(name ? { name } : {}),
      });
      await onCreated(svc);
      close();
      navigate(`#/port/${svc.port}/svc/${svc.id}`);
    } catch (e) {
      fail(e?.message || '创建失败');
    }
  };
  els.newServiceClose.addEventListener('click', close);
  els.newServiceBackdrop.addEventListener('click', close);
  els.newServiceCancel.addEventListener('click', close);
  els.newServiceCreate.addEventListener('click', submit);
  els.newServicePath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  return { open, close };
}