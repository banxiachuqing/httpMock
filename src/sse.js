export function sseResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function broadcast(clients, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

export function sseMiddleware() {
  const clients = new Set();
  return {
    clients,
    handler(req, res, next) {
      sseResponse(res);
      clients.add(res);
      const cleanup = () => clients.delete(res);
      res.on('close', cleanup);
      res.on('error', cleanup);
      res.write(':ok\n\n');
      next();
    },
  };
}
