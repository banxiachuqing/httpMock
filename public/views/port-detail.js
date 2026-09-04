// 端口详情页：页头交互（启用开关 / 改号 / 删除端口）
import { navigate } from '../router.js';
import { showToast } from '../toast.js';
import { confirmDialog } from '../confirm-dialog.js';

export function renderPortHeader(state, els) {
  const p = state.ports.find((x) => x.port === state.route.port);
  if (!p) return;
  els.portHeaderNumber.textContent = `:${p.port}`;
  els.portHeaderName.textContent = p.name || '';
  els.portNameInput.value = p.name || '';
  els.portEnabledToggle.checked = p.enabled !== false;
  els.portNumberInput.value = String(p.port);
  const st = state.runtimeStatus[String(p.port)];
  els.portStatusLed.dataset.state =
    st?.state === 'failed' ? 'failed' : st?.state === 'running' ? 'running' : 'stopped';
}

export function initPortDetail({ els, state, api, refreshAll }) {
  // 改名：只动端口名称，不涉及其下接口，无需「放弃未保存修改」确认
  els.portNameRenameBtn.addEventListener('click', async () => {
    const port = state.route.port;
    try {
      // 传当前输入值；空串由服务端按当前类型重新生成默认名
      const updated = await api.updatePort(port, { name: els.portNameInput.value });
      const local = state.ports.find((p) => p.port === port);
      if (local) Object.assign(local, updated);
      renderPortHeader(state, els); // 回显改名/重生成后的名称
      showToast({ type: 'success', message: `已改名为 ${updated.name}` });
    } catch (e) {
      showToast({ type: 'error', message: '改名失败：' + (e?.message || '未知错误') });
    }
  });
  els.portNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.portNameRenameBtn.click();
  });

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
    if (
      state.dirty &&
      !(await confirmDialog({
        title: '改号',
        message: '有未保存的修改，改号将放弃这些修改。继续？',
        confirmText: '继续改号',
      }))
    )
      return;
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
    if (
      state.dirty &&
      !(await confirmDialog({
        title: '删除端口',
        message: '有未保存的修改，删除端口将放弃这些修改。继续？',
        danger: true,
        confirmText: '继续删除',
      }))
    )
      return;
    state.dirty = false;
    const port = state.route.port;
    const count = state.endpoints.filter((e) => e.port === port).length;
    const msg = count > 0
      ? `确认删除端口 ${port}？将连同 ${count} 个接口一起删除。`
      : `确认删除端口 ${port}？`;
    if (
      !(await confirmDialog({
        title: '删除端口',
        message: msg,
        danger: true,
        confirmText: '删除端口',
      }))
    )
      return;
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