// 端口详情页：页头交互（启用开关 / 改号 / 删除端口）
import { navigate } from '../router.js';
import { showToast } from '../toast.js';

export function renderPortHeader(state, els) {
  const p = state.ports.find((x) => x.port === state.route.port);
  if (!p) return;
  els.portHeaderNumber.textContent = `:${p.port}`;
  els.portEnabledToggle.checked = p.enabled !== false;
  els.portNumberInput.value = String(p.port);
  const st = state.runtimeStatus[String(p.port)];
  els.portStatusLed.dataset.state =
    st?.state === 'failed' ? 'failed' : st?.state === 'running' ? 'running' : 'stopped';
}

export function initPortDetail({ els, state, api, refreshAll }) {
  els.portEnabledToggle.addEventListener('change', async () => {
    const port = state.route.port;
    try {
      const updated = await api.updatePort(port, { enabled: els.portEnabledToggle.checked });
      const local = state.ports.find((p) => p.port === port);
      if (local) Object.assign(local, updated);
    } catch (e) {
      els.portEnabledToggle.checked = !els.portEnabledToggle.checked;
      showToast({ type: 'error', message: '切换失败：' + (e?.message || '未知错误') });
    }
  });

  els.portRenameBtn.addEventListener('click', async () => {
    if (state.dirty && !confirm('有未保存的修改，改号将放弃这些修改。继续？')) return;
    state.dirty = false;
    const oldPort = state.route.port;
    const newPort = Number(els.portNumberInput.value);
    if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      return showToast({ type: 'error', message: '端口号必须是 1–65535 的整数' });
    }
    if (newPort === oldPort) return;
    if (state.ports.some((p) => p.port === newPort)) {
      return showToast({ type: 'error', message: `端口 ${newPort} 已存在` });
    }
    try {
      await api.updatePort(oldPort, { port: newPort });
      await refreshAll(); // 重新拉 ports + endpoints（port 字段已级联变化）
      navigate(`#/port/${newPort}`);
      showToast({ type: 'success', message: `端口已改为 ${newPort}` });
    } catch (e) {
      showToast({ type: 'error', message: '改号失败：' + (e?.message || '未知错误') });
    }
  });

  els.deletePortBtn.addEventListener('click', async () => {
    if (state.dirty && !confirm('有未保存的修改，删除端口将放弃这些修改。继续？')) return;
    state.dirty = false;
    const port = state.route.port;
    const count = state.endpoints.filter((e) => e.port === port).length;
    const msg = count > 0
      ? `确认删除端口 ${port}？将连同 ${count} 个接口一起删除。`
      : `确认删除端口 ${port}？`;
    if (!confirm(msg)) return;
    try {
      await api.deletePort(port);
      await refreshAll();
      navigate('#/');
      showToast({ type: 'success', message: `已删除端口 ${port}` });
    } catch (e) {
      showToast({ type: 'error', message: '删除失败：' + (e?.message || '未知错误') });
    }
  });
}