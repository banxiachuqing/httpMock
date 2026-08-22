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
