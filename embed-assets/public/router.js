// hash 路由：#/ → 首页；#/port/<port> → 端口详情；#/port/<port>/svc/<serviceId> → WS 服务详情
export function parseRoute(hash) {
  const svc = /^#\/port\/(\d+)\/svc\/([\w-]+)$/.exec(hash || '');
  if (svc) return { view: 'service', port: Number(svc[1]), serviceId: svc[2] };
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
