// 「端口启动失败」对话框：逐个失败端口提供 改号 / 强制启动（kill 占用进程）。
// 触发：启动后 POST /api/runtime/start 返回 failed 非空时由 app.js 打开。
import { showToast } from '../toast.js';

const REASON_LABEL = {
  EADDRINUSE: '被占用',
  EACCES: '特权端口（权限不足，需 ≥1024 或 root）',
};

export function initPortStartFailDialog({ els, state, api, onResolved }) {
  const close = () => { els.portStartFailModal.hidden = true; };

  async function open(failed) {
    els.portStartFailModal.hidden = false;
    await renderList(failed);
  }

  async function renderList(failed) {
    const list = els.portStartFailList;
    list.innerHTML = '';
    for (const f of failed) list.appendChild(await buildRow(f));
  }

  async function buildRow({ port, reason }) {
    const row = document.createElement('div');
    row.className = 'start-fail-row';
    row.dataset.port = String(port);

    const head = document.createElement('div');
    head.className = 'start-fail-head';
    const portEl = document.createElement('span');
    portEl.className = 'mono start-fail-port';
    portEl.textContent = `:${port}`;
    const reasonEl = document.createElement('span');
    reasonEl.className = 'fail-reason';
    reasonEl.textContent = REASON_LABEL[reason] || reason || '启动失败';
    head.append(portEl, reasonEl);

    // 占用者信息：仅「被占用」(EADDRINUSE) 查询；特权端口无进程可 kill
    const isOccupied = reason === 'EADDRINUSE';
    let canForce = false;
    const occupierEl = document.createElement('div');
    occupierEl.className = 'occupier-info field-hint';
    if (isOccupied) {
      try {
        const occ = await api.getOccupier(port);
        canForce = occ.supported !== false;
        occupierEl.textContent = occ.pids.length
          ? `被 ${occ.pids.map((p) => `${p.command} (PID ${p.pid})`).join('、')} 占用`
          : '被未知进程占用';
        if (!canForce) occupierEl.textContent += '；强制启动仅支持 macOS/Linux，请手动结束占用进程';
      } catch {
        occupierEl.textContent = '占用进程信息获取失败';
      }
    } else {
      occupierEl.textContent = '特权端口无法靠结束进程解决，请改为 ≥1024 的端口';
    }

    // 操作区：改号（所有失败都可）+ 强制启动（仅被占用且平台支持）
    const ops = document.createElement('div');
    ops.className = 'start-fail-ops';
    const renameInput = document.createElement('input');
    renameInput.type = 'number';
    renameInput.className = 'input mono rename-input';
    renameInput.min = '1';
    renameInput.max = '65535';
    renameInput.placeholder = '新端口号';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn btn-ghost btn-sm rename-btn';
    renameBtn.textContent = '改号';
    renameBtn.addEventListener('click', () => doRename(port, renameInput.value));
    ops.append(renameInput, renameBtn);

    if (canForce) {
      const forceBtn = document.createElement('button');
      forceBtn.className = 'btn btn-danger btn-sm force-start-btn';
      forceBtn.textContent = '强制启动';
      forceBtn.title = '结束占用该端口的进程后重新绑定';
      forceBtn.addEventListener('click', () => doForceStart(port, forceBtn));
      ops.append(forceBtn);
    }

    row.append(head, occupierEl, ops);
    return row;
  }

  async function doRename(oldPort, newPortRaw) {
    const newPort = Number(newPortRaw);
    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      return showToast({ type: 'error', message: '端口号必须是 1–65535 的整数' });
    }
    if (newPort === oldPort) {
      return showToast({ type: 'error', message: '新端口号与原端口相同' });
    }
    try {
      await api.updatePort(oldPort, { port: newPort }); // 复用改号级联
      showToast({ type: 'success', message: `已改号为 ${newPort}，重试启动` });
      await refresh();
    } catch (e) {
      showToast({ type: 'error', message: '改号失败：' + (e?.message || '未知错误') });
    }
  }

  async function doForceStart(port, btn) {
    btn.disabled = true;
    try {
      await api.forceStartPort(port);
      showToast({ type: 'success', message: `端口 ${port} 已强制启动` });
      await refresh();
    } catch (e) {
      showToast({ type: 'error', message: '强制启动失败：' + (e?.message || '未知错误') });
      btn.disabled = false;
    }
  }

  // 操作后重跑启动并刷新外层状态；仍有失败则更新列表，全部解决则关闭对话框
  async function refresh() {
    const result = await api.runtimeStart();
    await onResolved?.();
    if (result.failed && result.failed.length > 0) await renderList(result.failed);
    else close();
  }

  els.portStartFailClose.addEventListener('click', close);
  els.portStartFailBackdrop.addEventListener('click', close);
  els.portStartFailOk.addEventListener('click', close);

  return { open, close };
}
