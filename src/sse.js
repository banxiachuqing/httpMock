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
    try {
      // write() 返回 false = 内核缓冲已满（慢/停读客户端）：不能无限累积，
      // 主动断开——SSE 客户端会自动重连并从头拉取，日志流不会丢
      if (!res.write(payload)) res.end();
    } catch {}
  }
}

export function sseMiddleware() {
  const clients = new Set();
  return {
    clients,
    handler(req, res) {
      sseResponse(res);
      clients.add(res);
      const cleanup = () => clients.delete(res);
      res.on('close', cleanup);
      res.on('error', cleanup);
      res.write(':ok\n\n');
      // Do NOT call next() — keep the connection open
    },
  };
}
