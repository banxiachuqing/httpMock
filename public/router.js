// hash 路由：#/ → 首页（端口卡片）；#/port/<port> → 端口详情页
export function parseRoute(hash) {
  const m = /^#\/port\/(\d+)$/.exec(hash || '');
  if (m) return { view: 'port', port: Number(m[1]) };
  return { view: 'home' };
}

export function startRouter(onChange) {
  const apply = () => onChange(parseRoute(location.hash));
  window.addEventListener('hashchange', apply);
  apply();
}

export function navigate(hash) {
  location.hash = hash;
}
