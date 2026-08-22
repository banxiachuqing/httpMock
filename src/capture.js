// TCP/UDP 抓包数据平面（spec 2026-08-22 §4/§5）
// 一期纯抓包：TCP 连接只收不发；UDP 只收不回包。
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';

// TCP 消息边界：连接上该时长无新数据 → 累积字节作为一条消息落日志（spec §3：常量，不落配置）
export const DEFAULT_TCP_IDLE_MS = 200;
// 单端口活动 TCP 连接上限：超出即拒并 warn（spec §4）
export const MAX_TCP_CONNECTIONS = 200;
// payload 预览上限（字符）：hex 3 字符/字节（'xx '）、text 按 utf8 近似 1 字符/字节（spec §5）
const HEX_PREVIEW_BYTES = 2730;
const TEXT_PREVIEW_BYTES = 8192;

function stripIpv6Prefix(ip) {
  return (ip || '').replace(/^::ffff:/, '');
}

export function buildCaptureEntry({ protocol, port, remote, connectionId = null, payload, truncated = false }) {
  const hexTruncated = payload.length > HEX_PREVIEW_BYTES;
  const textTruncated = payload.length > TEXT_PREVIEW_BYTES;
  const hexBuf = hexTruncated ? payload.subarray(0, HEX_PREVIEW_BYTES) : payload;
  const textBuf = textTruncated ? payload.subarray(0, TEXT_PREVIEW_BYTES) : payload;
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    protocol,
    port,
    remote,
    connectionId,
    bytes: payload.length,
    payloadHex: hexBuf.toString('hex').replace(/../g, '$& ').trimEnd(),
    payloadText: textBuf.toString('utf8'),
    payloadTruncated: truncated || hexTruncated || textTruncated,
  };
}

export function buildCaptureEvent({ protocol, port, remote, connectionId = null, event }) {
  return { id: crypto.randomUUID(), timestamp: Date.now(), protocol, port, remote, connectionId, event };
}

// UDP：一个 datagram = 一条消息日志（天然边界，无聚合）（spec §4）
export function createUdpCaptureSocket({ port, logBuffer, getMax }) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const max = getMax();
    const truncated = msg.length > max;
    logBuffer?.push(buildCaptureEntry({
      protocol: 'udp',
      port,
      remote: `${stripIpv6Prefix(rinfo.address)}:${rinfo.port}`,
      connectionId: null,
      payload: truncated ? msg.subarray(0, max) : msg,
      truncated,
    }));
  });
  // 运行时错误不杀进程（spec §8）；bind 阶段的错误由引擎挂的一次性 error 监听处理，两者并存不冲突
  socket.on('error', () => {});
  return { socket };
}

// TCP：空闲聚合（spec §4）——连接上 idleMs 无新数据 → 累积字节落一条消息；
// 连接关闭时残余也落一条；超出 maxBodyBytes 立即 flush 并标记截断（剩余字节丢弃，对齐 HTTP readBody 语义）。
export function createTcpCaptureServer({ port, logBuffer, getMax, idleMs = DEFAULT_TCP_IDLE_MS, maxConnections = MAX_TCP_CONNECTIONS }) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    const remote = `${stripIpv6Prefix(socket.remoteAddress)}:${socket.remotePort}`;
    if (sockets.size >= maxConnections) {
      logBuffer?.push({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        level: 'warn',
        source: 'capture',
        message: `tcp :${port} 活动连接数超上限 ${maxConnections}，已拒绝 ${remote}`,
      });
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const connectionId = crypto.randomUUID();
    logBuffer?.push(buildCaptureEvent({ protocol: 'tcp', port, remote, connectionId, event: 'connect' }));

    let chunks = [];
    let bytes = 0;
    let truncated = false;
    let idleTimer = null;

    const flush = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (bytes === 0) return;
      const payload = Buffer.concat(chunks, bytes);
      chunks = [];
      const wasTruncated = truncated;
      bytes = 0;
      truncated = false;
      logBuffer?.push(buildCaptureEntry({ protocol: 'tcp', port, remote, connectionId, payload, truncated: wasTruncated }));
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(flush, idleMs);
    };

    socket.on('data', (chunk) => {
      const room = getMax() - bytes;
      if (chunk.length > room) {
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          bytes += room;
        }
        truncated = true;
        flush();
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
      armIdle();
    });
    socket.on('close', () => {
      flush();
      sockets.delete(socket);
      logBuffer?.push(buildCaptureEvent({ protocol: 'tcp', port, remote, connectionId, event: 'disconnect' }));
    });
    // RST 等错误不杀进程（spec §8）；收尾由随后的 'close' 统一处理
    socket.on('error', () => {});
  });
  return { server, sockets };
}
