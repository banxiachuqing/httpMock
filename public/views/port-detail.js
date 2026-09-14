// 端口详情页：页头交互（启用开关）。改号/改名/删除已融合到首页端口卡片（port-cards.js）。
import { showToast } from '../toast.js';

export function renderPortHeader(state, els) {
  const p = state.ports.find((x) => x.port === state.route.port);
  if (!p) return;
  els.portHeaderNumber.textContent = `:${p.port}`;
  els.portHeaderName.textContent = p.name || '';
  els.portEnabledToggle.checked = p.enabled !== false;
  const st = state.runtimeStatus[String(p.port)];
  els.portStatusLed.dataset.state =
    st?.state === 'failed' ? 'failed' : st?.state === 'running' ? 'running' : 'stopped';
}

export function initPortDetail({ els, state, api }) {
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
}
