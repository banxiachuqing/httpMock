# TCP/UDP 抓包 Mock 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mock-tools 增加 TCP/UDP 纯抓包能力：新建 tcp/udp 类型端口，接收数据聚合成消息落全局日志流，UI 可查看 hex/文本双视图；不做任何响应（ACK 属二期）。

**Architecture:** `ports[].type` 扩枚举为 `http|ws|tcp|udp`；`MockEngine._doStart` 按类型派发——http/ws 走现有 `http.createServer`（零改动），tcp 走 `node:net`（空闲 200ms 聚合），udp 走 `node:dgram`（一 datagram 一条）。协议特异逻辑收在新模块 `src/capture.js`；捕获条目复用 LogBuffer + SSE + 日志 UI；tcp/udp 端口详情页为「页头 + 实时捕获列表」视图（`capture-port`）。

**Tech Stack:** Node ≥18（`node:net`/`node:dgram`）、vitest（单元）、vitest+supertest（集成）、Playwright headless（E2E）、零构建原生 ESM 前端。

**Spec:** `docs/superpowers/specs/2026-08-22-tcp-udp-mock-design.md`（已确认）——计划论证以 spec 为准，执行时两者一起读。

## Global Constraints

- 一期**纯抓包**：TCP 连接只收不发；UDP 不回包。不写任何响应/ACK 代码。
- 端口号**全局唯一**（同端口号 tcp+udp 不并存）；端口 `type` 创建后不可改（`FIELD_IMMUTABLE`）。
- TCP 消息边界 = 空闲超时聚合，常量 `DEFAULT_TCP_IDLE_MS = 200`，**不落配置、不做 UI**。
- 单端口 TCP 连接上限 `MAX_TCP_CONNECTIONS = 200`，超出 destroy + warn 日志。
- 聚合/报文上限运行时读 `settings.maxBodyBytes`（与 HTTP 一致，经 `getMax()` 闭包）。
- 日志预览上限：hex 与 text 各自独立 ≤ 8192 字符。
- `ConfigStore.update(mutator)` 是唯一写入入口；本特性不新增写入路径。
- `data.json` **无 schema 变化、无版本迁移**（v3 的 `ports[].type` 本就是自由字符串）。
- 捕获路径任何异常不得杀死进程（bind 失败 → 端口隔离 `failed` + `reason`；socket 错误静默收尾）。
- 凡改 `public/` 必须递归同步 `embed-assets/public/` 并 diff 验证零漂移。
- E2E 默认 headless；测试端口分配区间：capture 单元测试用 189xx，E2E 用 191xx（避开现有 17xxx/18xxx/1900x 占用）。

---

### Task 1: capture.js — 捕获日志条目构建（纯函数）

**Files:**
- Create: `src/capture.js`
- Test: `test/unit/capture.test.js`

**Interfaces:**
- Consumes: 无（纯函数 + node 内置模块）
- Produces（后续任务依赖的精确签名）:
  - `buildCaptureEntry({ protocol: 'tcp'|'udp', port: number, remote: string, connectionId?: string|null, payload: Buffer, truncated?: boolean })` → `{ id, timestamp, protocol, port, remote, connectionId, bytes, payloadHex, payloadText, payloadTruncated }`
  - `buildCaptureEvent({ protocol, port, remote, connectionId?, event: 'connect'|'disconnect' })` → `{ id, timestamp, protocol, port, remote, connectionId, event }`
  - 常量 `DEFAULT_TCP_IDLE_MS = 200`、`MAX_TCP_CONNECTIONS = 200`
  - `bytes` 语义 = **保留字节数**（截断后）；截断事实由 `payloadTruncated` 标记。

- [ ] **Step 1: 写失败测试**

创建 `test/unit/capture.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { buildCaptureEntry, buildCaptureEvent } from '../../src/capture.js';

describe('buildCaptureEntry', () => {
  it('构建 hex + text 双预览条目', () => {
    const e = buildCaptureEntry({
      protocol: 'tcp', port: 9000, remote: '1.2.3.4:5000',
      connectionId: 'cid', payload: Buffer.from('ABC'),
    });
    expect(e.protocol).toBe('tcp');
    expect(e.port).toBe(9000);
    expect(e.remote).toBe('1.2.3.4:5000');
    expect(e.connectionId).toBe('cid');
    expect(e.bytes).toBe(3);
    expect(e.payloadHex).toBe('41 42 43');
    expect(e.payloadText).toBe('ABC');
    expect(e.payloadTruncated).toBe(false);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof e.timestamp).toBe('number');
  });

  it('二进制数据 text 预览不抛错；udp 无 connectionId', () => {
    const e = buildCaptureEntry({
      protocol: 'udp', port: 9001, remote: '1.2.3.4:5000',
      payload: Buffer.from([0x7e, 0xff, 0x01]),
    });
    expect(e.payloadHex).toBe('7e ff 01');
    expect(typeof e.payloadText).toBe('string');
    expect(e.connectionId).toBeNull();
  });

  it('超长 payload 预览截断并标记，bytes 仍是保留字节数', () => {
    const e = buildCaptureEntry({
      protocol: 'tcp', port: 9000, remote: 'r', connectionId: 'c',
      payload: Buffer.alloc(10000, 0x61),
    });
    expect(e.payloadHex.length).toBeLessThanOrEqual(8192);
    expect(e.payloadText.length).toBeLessThanOrEqual(8192);
    expect(e.payloadTruncated).toBe(true);
    expect(e.bytes).toBe(10000);
  });

  it('外部传入 truncated=true 时透传', () => {
    const e = buildCaptureEntry({
      protocol: 'tcp', port: 9000, remote: 'r', connectionId: 'c',
      payload: Buffer.from('ab'), truncated: true,
    });
    expect(e.payloadTruncated).toBe(true);
  });
});

describe('buildCaptureEvent', () => {
  it('构建 connect/disconnect 事件条目', () => {
    const e = buildCaptureEvent({
      protocol: 'tcp', port: 9000, remote: '1.2.3.4:5', connectionId: 'cid', event: 'connect',
    });
    expect(e).toMatchObject({
      protocol: 'tcp', port: 9000, remote: '1.2.3.4:5', connectionId: 'cid', event: 'connect',
    });
    expect(e.id).toBeTruthy();
    expect(typeof e.timestamp).toBe('number');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/capture.test.js`
Expected: FAIL（`Cannot find module '../../src/capture.js'`）

- [ ] **Step 3: 实现 src/capture.js**

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/capture.test.js`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/capture.js test/unit/capture.test.js
git commit -m "feat: 抓包日志条目构建（hex/text 双预览 + 连接事件）"
```

---

### Task 2: capture.js — UDP 捕获 socket

**Files:**
- Modify: `src/capture.js`
- Test: `test/unit/capture.test.js`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `buildCaptureEntry`、`stripIpv6Prefix`
- Produces: `createUdpCaptureSocket({ port: number, logBuffer: {push}, getMax: () => number })` → `{ socket: dgram.Socket }` —— 调用方负责 `socket.bind(port, host)`（引擎绑定阶段要挂一次性 error/listening 竞速，见 Task 4）

- [ ] **Step 1: 追加失败测试**

在 `test/unit/capture.test.js` 顶部 import 追加：

```js
import dgram from 'node:dgram';
import { createUdpCaptureSocket } from '../../src/capture.js';
```

文件末尾追加：

```js
function sendUdp(port, buf) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    client.send(buf, port, '127.0.0.1', (err) => {
      client.close();
      if (err) reject(err); else resolve();
    });
  });
}

function bindCaptureSocket(socket, port) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('listening', resolve);
    socket.bind(port, '127.0.0.1');
  });
}

describe('createUdpCaptureSocket', () => {
  it('每个 datagram 落一条日志，remote/字段正确', async () => {
    const logs = [];
    const { socket } = createUdpCaptureSocket({ port: 18900, logBuffer: { push: (e) => logs.push(e) }, getMax: () => 1024 });
    await bindCaptureSocket(socket, 18900);
    try {
      await sendUdp(18900, Buffer.from('hello'));
      await sendUdp(18900, Buffer.from([0x01, 0x02]));
      await new Promise((r) => setTimeout(r, 100));
      expect(logs).toHaveLength(2);
      expect(logs[0].protocol).toBe('udp');
      expect(logs[0].port).toBe(18900);
      expect(logs[0].payloadText).toBe('hello');
      expect(logs[0].remote).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(logs[0].connectionId).toBeNull();
      expect(logs[1].payloadHex).toBe('01 02');
    } finally {
      socket.close();
    }
  });

  it('超出 maxBodyBytes 截断并标记（bytes 为保留字节数）', async () => {
    const logs = [];
    const { socket } = createUdpCaptureSocket({ port: 18901, logBuffer: { push: (e) => logs.push(e) }, getMax: () => 4 });
    await bindCaptureSocket(socket, 18901);
    try {
      await sendUdp(18901, Buffer.from('123456789'));
      await new Promise((r) => setTimeout(r, 100));
      expect(logs).toHaveLength(1);
      expect(logs[0].bytes).toBe(4);
      expect(logs[0].payloadText).toBe('1234');
      expect(logs[0].payloadTruncated).toBe(true);
    } finally {
      socket.close();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/capture.test.js`
Expected: FAIL（`createUdpCaptureSocket is not a function`）

- [ ] **Step 3: 实现**

`src/capture.js` 末尾追加：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/capture.test.js`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/capture.js test/unit/capture.test.js
git commit -m "feat: UDP 抓包 socket（一 datagram 一条日志 + maxBodyBytes 截断）"
```

---

### Task 3: capture.js — TCP 捕获 server（空闲聚合）

**Files:**
- Modify: `src/capture.js`
- Test: `test/unit/capture.test.js`（追加 describe）

**Interfaces:**
- Consumes: Task 1 全部产出
- Produces: `createTcpCaptureServer({ port, logBuffer, getMax, idleMs = DEFAULT_TCP_IDLE_MS, maxConnections = MAX_TCP_CONNECTIONS })` → `{ server: net.Server, sockets: Set<net.Socket> }` —— `idleMs`/`maxConnections` 仅为测试可注入，生产用默认常量；调用方负责 `server.listen(port, host)`；`sockets` 暴露给引擎 stop() 显式 destroy（net.Server 无 closeIdleConnections）

- [ ] **Step 1: 追加失败测试**

`test/unit/capture.test.js` 顶部 import 追加：

```js
import net from 'node:net';
import { createTcpCaptureServer } from '../../src/capture.js';
```

文件末尾追加：

```js
function tcpConnect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function listenCaptureServer(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(port, '127.0.0.1');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('createTcpCaptureServer', () => {
  it('快速连写在空闲后聚合为一条消息', async () => {
    const logs = [];
    const { server } = createTcpCaptureServer({ port: 18910, logBuffer: { push: (e) => logs.push(e) }, getMax: () => 1024, idleMs: 100 });
    await listenCaptureServer(server, 18910);
    try {
      const s = await tcpConnect(18910);
      s.write('hello, ');
      s.write('world');
      await sleep(250);
      const msgs = logs.filter((e) => !e.event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payloadText).toBe('hello, world');
      expect(msgs[0].bytes).toBe(12);
      expect(msgs[0].protocol).toBe('tcp');
      expect(msgs[0].remote).toMatch(/^127\.0\.0\.1:\d+$/);
      s.end();
      await sleep(50);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('间隔超过空闲阈值 → 两条消息；同连接 connectionId 稳定', async () => {
    const logs = [];
    const { server } = createTcpCaptureServer({ port: 18911, logBuffer: { push: (e) => logs.push(e) }, getMax: () => 1024, idleMs: 100 });
    await listenCaptureServer(server, 18911);
    try {
      const s = await tcpConnect(18911);
      s.write('aaa');
      await sleep(250);
      s.write('bbb');
      await sleep(250);
      const msgs = logs.filter((e) => !e.event);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].payloadText).toBe('aaa');
      expect(msgs[1].payloadText).toBe('bbb');
      expect(msgs[0].connectionId).toBe(msgs[1].connectionId);
      s.end();
      await sleep(50);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('连接断开 flush 残余，并落 connect/disconnect 事件', async () => {
    const logs = [];
    const { server } = createTcpCaptureServer({ port: 18912, logBuffer: { push: (e) => logs.push(e) }, getMax: () => 1024, idleMs: 100 });
    await listenCaptureServer(server, 18912);
    try {
      const s = await tcpConnect(18912);
      s.write('bye');
      s.end();
      await sleep(200);
      const msgs = logs.filter((e) => !e.event);
      const events = logs.filter((e) => e.event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payloadText).toBe('bye');
      expect(events.map((e) => e.event)).toEqual(['connect', 'disconnect']);
      expect(events[0].connectionId).toBe(msgs[0].connectionId);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('超出 maxBodyBytes 立即 flush 并标记截断', async () => {
    const logs = [];
    const { server } = createTcpCaptureServer({ port: 18913, logBuffer: { push: (e) => logs.push(e) }, getMax: () => 5, idleMs: 100 });
    await listenCaptureServer(server, 18913);
    try {
      const s = await tcpConnect(18913);
      s.write('123456789');
      await sleep(200);
      const msgs = logs.filter((e) => !e.event);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payloadText).toBe('12345');
      expect(msgs[0].bytes).toBe(5);
      expect(msgs[0].payloadTruncated).toBe(true);
      s.end();
      await sleep(50);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('超过连接上限的新连接被拒绝并落 warn 日志', async () => {
    const logs = [];
    const { server } = createTcpCaptureServer({ port: 18914, logBuffer: { push: (e) => logs.push(e) }, getMax: () => 1024, maxConnections: 1 });
    await listenCaptureServer(server, 18914);
    const s1 = await tcpConnect(18914);
    const s2 = await tcpConnect(18914);
    await sleep(150);
    expect(logs.some((e) => e.level === 'warn' && e.source === 'capture')).toBe(true);
    // 被拒连接不计入 connect 事件
    expect(logs.filter((e) => e.event === 'connect')).toHaveLength(1);
    s1.end();
    s2.destroy();
    await new Promise((r) => server.close(r));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/capture.test.js`
Expected: FAIL（`createTcpCaptureServer is not a function`）

- [ ] **Step 3: 实现**

`src/capture.js` 末尾追加：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/capture.test.js`
Expected: PASS（12 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/capture.js test/unit/capture.test.js
git commit -m "feat: TCP 抓包 server（空闲聚合 + 断连 flush + 截断 + 连接上限）"
```

---

### Task 4: MockEngine 按端口类型派发 + stop 多类型关闭

**Files:**
- Modify: `src/mock-engine.js`（import、`_doStart` 主循环、`stop()`）
- Test: `test/unit/mock-engine.test.js`（追加 describe）

**Interfaces:**
- Consumes: `createTcpCaptureServer` / `createUdpCaptureSocket`（Task 2/3）
- Produces:
  - `MockEngine.start(endpoints, ports, services)` 签名不变；`ports[].type` 为 `'tcp'|'udp'` 时绑定对应捕获 server
  - `this.servers` 值形状变为 `{ kind: 'http'|'tcp'|'udp', server?, socket?, sockets? }`（仅引擎内部与 `/api/runtime/stop` 使用，后者只读 keys——无外部破坏面）
  - `getStatus()` 形状不变

- [ ] **Step 1: 追加失败测试**

`test/unit/mock-engine.test.js` 顶部 import 追加：

```js
import net from 'node:net';
import dgram from 'node:dgram';
```

文件末尾追加：

```js
describe('MockEngine TCP/UDP 抓包端口', () => {
  it('tcp 端口接收数据并落捕获日志', async () => {
    engine = new MockEngine({ logBuffer });
    const { running, failed } = await engine.start([], [{ port: 18920, enabled: true, type: 'tcp' }]);
    expect(running.map((r) => r.port)).toEqual([18920]);
    expect(failed).toEqual([]);
    const s = net.connect(18920, '127.0.0.1');
    await new Promise((res) => s.once('connect', res));
    s.write('ping');
    await new Promise((r) => setTimeout(r, 400)); // 等 200ms 空闲聚合 flush
    s.end();
    const msg = pushedLogs.find((e) => e.protocol === 'tcp' && !e.event);
    expect(msg.payloadText).toBe('ping');
  });

  it('udp 端口接收 datagram 并落捕获日志', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18921, enabled: true, type: 'udp' }]);
    const client = dgram.createSocket('udp4');
    await new Promise((res, rej) => client.send('ping', 18921, '127.0.0.1', (e) => (e ? rej(e) : res())));
    client.close();
    await new Promise((r) => setTimeout(r, 150));
    const msg = pushedLogs.find((e) => e.protocol === 'udp');
    expect(msg.payloadText).toBe('ping');
  });

  it('tcp 端口 EADDRINUSE 隔离：不影响其他端口', async () => {
    const blocker = net.createServer();
    await new Promise((res) => blocker.listen(18922, '127.0.0.1', res));
    try {
      engine = new MockEngine({ logBuffer });
      const { running, failed } = await engine.start(
        [{ id: 'a', port: 18923, method: 'GET', path: '/x', statusCode: 200, response: { ok: 1 }, enabled: true }],
        [{ port: 18922, enabled: true, type: 'tcp' }, { port: 18923, enabled: true, type: 'http' }],
      );
      expect(failed.find((f) => f.port === 18922)).toBeTruthy();
      expect(running.find((r) => r.port === 18923)).toBeTruthy();
      expect(engine.getStatus()['18922'].state).toBe('failed');
      expect(engine.getStatus()['18923'].state).toBe('running');
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('stop() 释放 tcp/udp 端口，可立即重绑', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18924, enabled: true, type: 'tcp' }, { port: 18925, enabled: true, type: 'udp' }]);
    await engine.stop();
    const again = await engine.start([], [{ port: 18924, enabled: true, type: 'tcp' }, { port: 18925, enabled: true, type: 'udp' }]);
    expect(again.failed).toEqual([]);
  });

  it('stop() 销毁活动 tcp 连接（客户端收到 close）', async () => {
    engine = new MockEngine({ logBuffer });
    await engine.start([], [{ port: 18926, enabled: true, type: 'tcp' }]);
    const s = net.connect(18926, '127.0.0.1');
    await new Promise((res) => s.once('connect', res));
    const closed = new Promise((res) => s.once('close', res));
    await engine.stop();
    await closed;
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/unit/mock-engine.test.js`
Expected: 新增用例 FAIL（tcp/udp 端口被当 http 绑定，`pushedLogs.find(e => e.protocol === 'tcp')` 为 undefined）；既有用例全部仍 PASS（不破坏回归）

- [ ] **Step 3: 实现**

`src/mock-engine.js`：

a) 顶部 import 追加：

```js
import { createTcpCaptureServer, createUdpCaptureSocket } from './capture.js';
```

b) `MockEngine` 类前新增两个绑定辅助函数：

```js
// listen 成败 Promise 化：error/listening 一次性竞速（http/net Server 通用）
function listenOrFail(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

// dgram 版本：bind + error/listening（dgram 绑定成功同样发 'listening'）
function bindOrFail(socket, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { socket.removeListener('listening', onListening); reject(err); };
    const onListening = () => { socket.removeListener('error', onError); resolve(); };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port, host);
  });
}
```

c) `_doStart` 的主循环整体替换为（按类型派发；http/ws 路径逻辑不变，仅 listen 改走 `listenOrFail`）：

```js
    for (const [port, eps] of byPort.entries()) {
      const portEntity = Array.isArray(ports) ? ports.find((p) => p.port === port) : null;
      const getMax = () => this.configStore?.config?.settings?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      const type = portEntity?.type ?? 'http';
      let record = null;
      try {
        if (type === 'tcp') {
          const { server, sockets } = createTcpCaptureServer({ port, logBuffer: this.logBuffer, getMax });
          record = { kind: 'tcp', server, sockets };
          await listenOrFail(server, port, this.bindHost);
        } else if (type === 'udp') {
          const { socket } = createUdpCaptureSocket({ port, logBuffer: this.logBuffer, getMax });
          record = { kind: 'udp', socket };
          await bindOrFail(socket, port, this.bindHost);
        } else {
          const handler = type === 'ws'
            ? createWsHandler({ port, services: services.filter((s) => s.port === port), logBuffer: this.logBuffer, getMax })
            : createHttpHandler({ port, router: buildRouter(eps), logBuffer: this.logBuffer, getMax });
          const server = http.createServer(handler);
          record = { kind: 'http', server };
          await listenOrFail(server, port, this.bindHost);
        }
        this.servers.set(port, record);
        this.statuses.set(port, { state: 'running' });
        running.push({ port });
      } catch (e) {
        this.statuses.set(port, { state: 'failed', reason: e.code || 'EADDRINUSE' });
        failed.push({ port, reason: e.code || 'EADDRINUSE' });
        try { record?.server?.close(); } catch {}
        try { record?.socket?.close(); } catch {}
      }
    }
```

d) `stop()` 的关闭循环替换为按 kind 分派（方法其余部分不变）：

```js
  async stop() {
    const promises = [];
    for (const entry of this.servers.values()) {
      if (entry.kind === 'udp') {
        promises.push(new Promise((resolve) => {
          try { entry.socket.close(() => resolve()); } catch { resolve(); }
        }));
      } else if (entry.kind === 'tcp') {
        // net.Server 无 closeIdleConnections：显式 destroy 活动连接，
        // 否则 server.close() 回调一直等空闲连接不断（spec §4）
        for (const s of entry.sockets) { try { s.destroy(); } catch {} }
        promises.push(new Promise((resolve) => {
          entry.server.close(() => resolve());
        }));
      } else {
        promises.push(new Promise((resolve) => {
          entry.server.close(() => resolve());
          // server.close() 不关 keep-alive 空闲连接（回调不等它们）；显式关掉，
          // 否则端口被重新绑定时旧连接残留（Node 18.2+ 才有的 API，低版本跳过）
          if (typeof entry.server.closeIdleConnections === 'function') entry.server.closeIdleConnections();
        }));
      }
    }
    await Promise.all(promises);
    // 端口可能立刻被重新绑定（api.js 每次配置变更都会 stop→start 同端口）：
    // 等一轮事件循环，让同一进程内客户端 keep-alive 池收到 FIN 并移除旧连接
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.servers.clear();
    for (const port of this.statuses.keys()) {
      this.statuses.set(port, { state: 'stopped' });
    }
    this.running = false;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/unit/mock-engine.test.js test/unit/capture.test.js`
Expected: PASS（全部，含既有回归）

- [ ] **Step 5: Commit**

```bash
git add src/mock-engine.js test/unit/mock-engine.test.js
git commit -m "feat: MockEngine 按端口类型派发 net/dgram 抓包 + stop 多类型关闭"
```

---

### Task 5: API — ports type 扩枚举 + assertHttpPort 收紧

**Files:**
- Modify: `src/api-ports.js:28-30`（type 校验）
- Modify: `src/api.js:56-62`（assertHttpPort）
- Test: `test/integration/api-ports.test.js`（追加 describe）

**Interfaces:**
- Consumes: 无新依赖
- Produces: `POST /api/ports` 接受 `type: 'tcp'|'udp'`；`POST/PUT /api/endpoints` 对非 http 类型端口一律 400 `PORT_TYPE_MISMATCH`

- [ ] **Step 1: 追加失败测试**

`test/integration/api-ports.test.js` 末尾追加：

```js
describe('TCP/UDP 端口类型（spec 2026-08-22 §3/§6）', () => {
  it('创建 tcp/udp 端口', async () => {
    const tcp = await ctx.request.post('/api/ports').send({ port: 9500, type: 'tcp' });
    expect(tcp.status).toBe(201);
    expect(tcp.body).toEqual({ port: 9500, enabled: true, type: 'tcp' });
    const udp = await ctx.request.post('/api/ports').send({ port: 9501, type: 'udp' });
    expect(udp.status).toBe(201);
    expect(udp.body).toEqual({ port: 9501, enabled: true, type: 'udp' });
  });

  it('拒绝非法 type', async () => {
    const r = await ctx.request.post('/api/ports').send({ port: 9502, type: 'sctp' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_VALUE');
  });

  it('type 创建后不可改', async () => {
    await ctx.request.post('/api/ports').send({ port: 9503, type: 'tcp' });
    const r = await ctx.request.put('/api/ports/9503').send({ type: 'http' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('FIELD_IMMUTABLE');
  });

  it('往 tcp 端口建 HTTP 端点 → PORT_TYPE_MISMATCH', async () => {
    await ctx.request.post('/api/ports').send({ port: 9504, type: 'tcp' });
    const r = await ctx.request.post('/api/endpoints').send({ port: 9504, method: 'GET', path: '/x', response: {} });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });

  it('往 udp 端口建 WS 服务 → PORT_TYPE_MISMATCH（ensureWsPortEntity 覆盖）', async () => {
    await ctx.request.post('/api/ports').send({ port: 9505, type: 'udp' });
    const r = await ctx.request.post('/api/services').send({ port: 9505, path: '/ws/S', name: 'S' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PORT_TYPE_MISMATCH');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/integration/api-ports.test.js`
Expected: FAIL（`创建 tcp/udp 端口` 返回 400 INVALID_VALUE；`往 tcp 端口建端点` 返回 201 而非 400）

- [ ] **Step 3: 实现**

`src/api-ports.js` 第 28-30 行改为：

```js
      if (!['http', 'ws', 'tcp', 'udp'].includes(type)) {
        throw new AppError(400, 'INVALID_VALUE', "type must be 'http' | 'ws' | 'tcp' | 'udp'");
      }
```

`src/api.js` 的 `assertHttpPort`（56-62 行）改为：

```js
// 非 http 型端口拒绝挂 HTTP 端点（spec §3 端口类型约束；ws/tcp/udp 一律拒）
function assertHttpPort(cfg, port) {
  const p = cfg.ports.find((x) => x.port === port);
  if (p && p.type !== 'http') {
    throw new AppError(400, 'PORT_TYPE_MISMATCH', `port ${port} is a ${p.type} port`);
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量集成回归**

Run: `pnpm vitest run test/integration/`
Expected: PASS（注意确认既有 `往 ws 端口建 endpoint → PORT_TYPE_MISMATCH` 用例仍过——它只断言 code 不断言 message）

- [ ] **Step 5: Commit**

```bash
git add src/api-ports.js src/api.js test/integration/api-ports.test.js
git commit -m "feat: ports type 扩为 http|ws|tcp|udp + 非 http 端口拒挂 HTTP 端点"
```

---

### Task 6: UI — 新建端口弹窗加 TCP/UDP + 端口卡片适配

**Files:**
- Modify: `public/index.html`（newPortModal radios，602-606 行区域）
- Modify: `public/views/port-cards.js`（badge、stats 首行、latestLogByPort、endpointLabel）
- Modify: `public/styles.css`（badge 颜色）
- Test: `test/e2e/capture.spec.js`（新建，首个用例）

**Interfaces:**
- Consumes: Task 5 的 API（`POST /api/ports` 接受 tcp/udp）
- Produces: 端口卡片 `.port-type-badge[data-type='tcp'|'udp']`；抓包端口卡片首行统计文案 `TCP 抓包`/`UDP 抓包`

- [ ] **Step 1: 写失败 E2E**

创建 `test/e2e/capture.spec.js`：

```js
import { test, expect } from '@playwright/test';
import { bootServer } from './helpers.js';

let server;

test.beforeAll(async () => { server = await bootServer(); });
test.afterAll(async () => { if (server) await server.cleanup(); });

test('新建 TCP 抓包端口：弹窗选型 + 卡片徽标与统计', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  await page.click('#newPortCard');
  await expect(page.locator('#newPortModal')).toBeVisible();
  await page.check('input[name="newPortType"][value="tcp"]');
  await page.fill('#newPortNumber', '19100');
  await page.click('#newPortCreate');

  await page.waitForSelector('#portHeader:not([hidden])');
  expect(page.url()).toContain('#/port/19100');

  await page.goto(`${server.baseURL}/#/`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const card = page.locator('.port-card[data-port="19100"]');
  await expect(card).toBeVisible();
  await expect(card.locator('.port-type-badge')).toHaveText('TCP');
  await expect(card.locator('.port-card-stats dd').first()).toHaveText('TCP 抓包');
});
```

- [ ] **Step 2: 跑 E2E 确认失败**

Run: `pnpm playwright test test/e2e/capture.spec.js`
Expected: FAIL（没有 value="tcp" 的 radio，`page.check` 超时）

- [ ] **Step 3: 实现**

a) `public/index.html` 新建端口弹窗 radios（约 602-606 行）替换为：

```html
          <div class="port-type-radios">
            <label><input type="radio" name="newPortType" value="http" checked /> HTTP 接口</label>
            <label><input type="radio" name="newPortType" value="ws" /> WebService (SOAP)</label>
            <label><input type="radio" name="newPortType" value="tcp" /> TCP 抓包</label>
            <label><input type="radio" name="newPortType" value="udp" /> UDP 抓包</label>
          </div>
          <p class="field-hint">创建后类型不可更改。TCP/UDP 抓包端口只接收并记录数据，不返回响应。</p>
```

b) `public/views/port-cards.js`：

`buildCard` 中徽标与统计（31-107 行区域）改为：

```js
function buildCard(p, state, lastEntry, api) {
  const isWs = p.type === 'ws';
  const isCapture = p.type === 'tcp' || p.type === 'udp';
  const type = p.type || 'http';
  // ...（card/dataset/aria 等不变）
  const badge = document.createElement('span');
  badge.className = 'port-type-badge';
  badge.dataset.type = type;
  badge.textContent = type.toUpperCase();
  // ...
  // stats 首行：
  if (isCapture) {
    epDt.textContent = '类型';
    epDd.textContent = `${type.toUpperCase()} 抓包`;
  } else if (isWs) {
    // 现有 ws 分支不变
  } else {
    // 现有 http 分支不变
  }
```

`latestLogByPort` 的过滤改为同时认捕获条目：

```js
    if (!entry.method && !entry.protocol) continue; // 过滤 resolver-warn 等无请求条目
```

`endpointLabel` 加捕获分支（放函数开头）：

```js
function endpointLabel(entry, endpoints) {
  if (entry.protocol) {
    if (entry.event) return entry.event === 'connect' ? '连接建立' : '连接断开';
    return `${entry.protocol.toUpperCase()} · ${entry.bytes} B`;
  }
  // ...既有 http/ws 逻辑不变
}
```

c) `public/styles.css`（`.port-type-badge[data-type='ws']` 规则后追加）：

```css
.port-type-badge[data-type='tcp'] { color: var(--cyan); }
.port-type-badge[data-type='udp'] { color: #b48ce8; }
```

- [ ] **Step 4: 跑 E2E 确认通过**

Run: `pnpm playwright test test/e2e/capture.spec.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/views/port-cards.js public/styles.css test/e2e/capture.spec.js
git commit -m "feat: 新建端口弹窗支持 TCP/UDP 抓包类型 + 卡片徽标/统计适配"
```

---

### Task 7: UI — capture-port 详情视图（页头 + 实时捕获列表）

**Files:**
- Modify: `public/app.js`（`effectiveView`、`applyRoute`、`refreshAll`）
- Modify: `public/styles.css`（capture-port 网格）
- Test: `test/e2e/capture.spec.js`（追加用例）

**Interfaces:**
- Consumes: `state.ports[].type`（Task 5 API 已返回）
- Produces: 有效视图 `'capture-port'`（`state.route.view` / `document.body.dataset.view` 的新枚举值）；tcp/udp 端口的 `#/port/:port` 渲染为「端口页头 + 该端口过滤的日志区」，接口侧栏与 JSON 编辑器隐藏

- [ ] **Step 1: 追加失败 E2E**

`test/e2e/capture.spec.js` 追加：

```js
test('UDP 端口详情页为抓包视图：无接口侧栏/编辑器，日志区可见', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 19101, type: 'udp' }),
    });
  });

  await page.goto(`${server.baseURL}/#/port/19101`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#portHeader:not([hidden])');

  await expect(page.locator('#sidebarPanel')).toBeHidden();
  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('#logsPanel')).toBeVisible();
  await expect(page.locator('#portHeaderNumber')).toHaveText(':19101');
});
```

- [ ] **Step 2: 跑 E2E 确认失败**

Run: `pnpm playwright test test/e2e/capture.spec.js`
Expected: 新用例 FAIL（udp 端口走了 http 详情视图，`#sidebarPanel` 可见）

- [ ] **Step 3: 实现**

a) `public/app.js` 的 `effectiveView`（约 715-726 行）末尾返回行改为：

```js
function effectiveView(route) {
  if (route.view === 'home') return 'home';
  const portEntity = currentPortEntity(route);
  if (!portEntity) return 'not-found';
  if (route.view === 'service') {
    const svc = (state.services || []).find(
      (s) => s.id === route.serviceId && s.port === route.port,
    );
    return svc ? 'service' : 'not-found';
  }
  if (portEntity.type === 'ws') return 'ws-port';
  if (portEntity.type === 'tcp' || portEntity.type === 'udp') return 'capture-port';
  return 'port';
}
```

b) `applyRoute` 中的视图分发（约 762-790 行）相应行改为：

```js
  els.portHeader.hidden = !(ev === 'port' || ev === 'ws-port' || ev === 'capture-port');
```

（`sidebarPanel`/`editor` 的 `hidden = ev !== 'port'` 行不变——capture-port 下自动隐藏；`logsPanel.hidden = ev === 'home'` 不变——capture-port 下自动显示。）

```js
  if (ev === 'port' || ev === 'ws-port' || ev === 'capture-port') renderPortHeader(state, els);
```

并在 `if (ev === 'ws-port') {...}` 分支后加：

```js
  if (ev === 'capture-port') {
    renderLogsInitial();
  }
```

c) `refreshAll`（约 1024 行）的条件扩展：

```js
  if (state.route.view === 'port' || state.route.view === 'ws-port' || state.route.view === 'capture-port') {
    renderPortHeader(state, els);
  }
```

d) `public/styles.css`（`body[data-view='ws-port']` 规则块后追加）：

```css
/* 抓包端口详情：topbar / 端口页头 / 日志区（占满剩余高度） */
body[data-view='capture-port'] {
  grid-template-rows: 56px auto 1fr;
  grid-template-columns: 1fr;
  grid-template-areas:
    "topbar"
    "porthdr"
    "logs";
}
```

- [ ] **Step 4: 跑 E2E 确认通过**

Run: `pnpm playwright test test/e2e/capture.spec.js`
Expected: PASS（2 个用例）

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/styles.css test/e2e/capture.spec.js
git commit -m "feat: capture-port 抓包详情视图（页头 + 实时捕获日志区）"
```

---

### Task 8: UI — 日志流捕获条目渲染 + 详情弹窗 hex/文本双视图

**Files:**
- Modify: `public/index.html`（log-detail dialog：三个既有 section 加 id + 新增捕获 section）
- Modify: `public/app.js`（`els` 新增引用、`renderLogEntry` 捕获分支、`openLogDetail` 守卫、`renderLogDetail` 捕获分支）
- Modify: `public/styles.css`（协议 chip、payload 切换按钮样式）
- Test: `test/e2e/capture.spec.js`（追加用例）

**Interfaces:**
- Consumes: 捕获日志条目（Task 1 字段形状：`protocol/remote/connectionId/bytes/payloadHex/payloadText/payloadTruncated/event?`）；app.js 既有 `formatBytes(n)`
- Produces: `.log-entry.capture` 行；log-detail 弹窗捕获模式（`#logDetailCaptureSection` + `#logDetailHexBtn`/`#logDetailTextBtn` 切换）

- [ ] **Step 1: 追加失败 E2E**

`test/e2e/capture.spec.js` 顶部 import 追加：

```js
import net from 'node:net';
import dgram from 'node:dgram';
```

文件末尾追加：

```js
test('TCP 抓包数据出现在日志流，详情可切换 hex/文本', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 19102, type: 'tcp' }),
    });
    await fetch('/api/runtime/start', { method: 'POST' });
  });

  const s = net.connect(19102, '127.0.0.1');
  await new Promise((res) => s.once('connect', res));
  s.write('hello tcp');
  await new Promise((r) => setTimeout(r, 500)); // 等空闲聚合 flush

  await page.goto(`${server.baseURL}/#/port/19102`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const row = page.locator('.log-entry.capture', { hasText: '接收' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('TCP');
  await row.click();

  await expect(page.locator('#logDetailPayload')).toHaveText('68 65 6c 6c 6f 20 74 63 70');
  await page.click('#logDetailTextBtn');
  await expect(page.locator('#logDetailPayload')).toHaveText('hello tcp');
  await page.click('#logDetailClose');
  s.end();
});

test('UDP 抓包数据出现在日志流', async ({ page }) => {
  await page.goto(server.baseURL, { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    await fetch('/api/ports', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: 19103, type: 'udp' }),
    });
    await fetch('/api/runtime/start', { method: 'POST' });
  });

  const client = dgram.createSocket('udp4');
  await new Promise((res, rej) => client.send('hello udp', 19103, '127.0.0.1', (e) => (e ? rej(e) : res())));
  client.close();
  await new Promise((r) => setTimeout(r, 300));

  await page.goto(`${server.baseURL}/#/port/19103`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);

  const row = page.locator('.log-entry.capture', { hasText: '接收' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('UDP');
});
```

- [ ] **Step 2: 跑 E2E 确认失败**

Run: `pnpm playwright test test/e2e/capture.spec.js`
Expected: 两个新用例 FAIL（`.log-entry.capture` 不存在）

- [ ] **Step 3: 实现**

a) `public/index.html` log-detail dialog 改造：

给三个既有 section 加 id（结构不变）：

```html
    <section class="log-detail-section" id="logDetailQuerySection">
```
```html
    <section class="log-detail-section" id="logDetailHeadersSection">
```
```html
    <section class="log-detail-section" id="logDetailBodySection">
```

在 body section 之后、`</dialog>` 之前新增捕获 section：

```html
    <section class="log-detail-section" id="logDetailCaptureSection" hidden>
      <h3>数据 <span class="log-detail-count" id="logDetailBytes">0 B</span>
        <span class="payload-toggle" role="group" aria-label="数据格式">
          <button type="button" class="toggle-btn is-active" id="logDetailHexBtn">HEX</button>
          <button type="button" class="toggle-btn" id="logDetailTextBtn">文本</button>
        </span>
      </h3>
      <div class="log-detail-body-warning" id="logDetailCaptureWarning" hidden>数据已截断（超出上限）</div>
      <pre class="log-detail-body-plain mono" id="logDetailPayload"></pre>
    </section>
```

b) `public/app.js`：

`els` 的 Log detail dialog 区块追加引用：

```js
  logDetailQuerySection: $("#logDetailQuerySection"),
  logDetailHeadersSection: $("#logDetailHeadersSection"),
  logDetailBodySection: $("#logDetailBodySection"),
  logDetailCaptureSection: $("#logDetailCaptureSection"),
  logDetailBytes: $("#logDetailBytes"),
  logDetailHexBtn: $("#logDetailHexBtn"),
  logDetailTextBtn: $("#logDetailTextBtn"),
  logDetailCaptureWarning: $("#logDetailCaptureWarning"),
  logDetailPayload: $("#logDetailPayload"),
```

`renderLogEntry` 加捕获分发（函数开头）+ 新渲染函数：

```js
function renderLogEntry(entry) {
  if (entry.protocol === 'tcp' || entry.protocol === 'udp') {
    return renderCaptureLogEntry(entry);
  }
  // ...既有 HTTP 渲染不变
}

// 抓包条目行：时间 / 协议 / 远端 / 端口 / 字节数 / — / 来源 IP / 事件或「接收」（spec §5/§7）
function renderCaptureLogEntry(entry) {
  const row = document.createElement('div');
  row.className = 'log-entry capture';
  const time = new Date(entry.timestamp).toLocaleTimeString('zh-CN', {
    hour12: false,
  });
  const remoteIp = (entry.remote || '').replace(/:\d+$/, '');
  row.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-method log-proto" data-protocol="${entry.protocol}">${entry.protocol.toUpperCase()}</span>
    <span class="log-path"></span>
    <span class="log-port">${entry.port}</span>
    <span class="log-status" data-range="">${entry.event ? '—' : formatBytes(entry.bytes)}</span>
    <span class="log-duration">—</span>
    <span class="log-ip mono"></span>
    <span class="log-result"></span>
  `;
  // remote 来自对端地址，只能 textContent 赋值（不进 innerHTML）
  row.querySelector('.log-path').textContent = entry.remote || '—';
  row.querySelector('.log-ip').textContent = remoteIp || '—';
  row.querySelector('.log-result').textContent = entry.event
    ? entry.event === 'connect' ? '连接建立' : '连接断开'
    : '接收';
  row.addEventListener('click', () => openLogDetail(entry.id));
  return row;
}
```

`openLogDetail` 守卫放宽：

```js
function openLogDetail(id) {
  const entry = state.logs.find((e) => e.id === id);
  if (!entry || (!entry.method && !entry.protocol)) return;
  renderLogDetail(entry);
  els.logDetail.showModal();
}
```

`renderLogDetail` 函数开头加捕获分支（既有 HTTP 逻辑原样保留，仅在其前补一行复位）：

```js
function renderLogDetail(entry) {
  if (entry.protocol === 'tcp' || entry.protocol === 'udp') {
    renderCaptureLogDetail(entry);
    return;
  }
  // HTTP 条目：复位捕获区隐藏 + 三个既有 section 显示（弹窗是复用的）
  els.logDetailCaptureSection.hidden = true;
  els.logDetailQuerySection.hidden = false;
  els.logDetailHeadersSection.hidden = false;
  els.logDetailBodySection.hidden = false;
  // ...既有 HTTP 渲染不变
}

// 抓包条目详情：header 显示协议/远端/字节数或事件；数据区 hex/文本双视图切换（spec §7）
function renderCaptureLogDetail(entry) {
  els.logDetailMethod.textContent = entry.protocol.toUpperCase();
  els.logDetailMethod.dataset.method = '';
  els.logDetailPath.textContent = entry.remote || '—';
  els.logDetailStatus.dataset.range = '';
  els.logDetailStatus.textContent = entry.event
    ? entry.event === 'connect' ? '连接' : '断开'
    : formatBytes(entry.bytes) || `${entry.bytes} B`;

  const time = new Date(entry.timestamp).toLocaleString('zh-CN', { hour12: false });
  els.logDetailMeta.innerHTML = '';
  const rows = [
    ['时间', time],
    ['端口', String(entry.port)],
    ['远端', entry.remote || '—'],
  ];
  if (entry.event) {
    rows.push(['事件', entry.event === 'connect' ? '连接建立' : '连接断开']);
  } else {
    rows.push(['字节数', `${entry.bytes} B`]);
  }
  if (entry.connectionId) rows.push(['连接', `${entry.connectionId.slice(0, 8)}…`]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    els.logDetailMeta.append(dt, dd);
  }

  els.logDetailQuerySection.hidden = true;
  els.logDetailHeadersSection.hidden = true;
  els.logDetailBodySection.hidden = true;
  els.logDetailCaptureSection.hidden = !!entry.event;
  if (!entry.event) {
    els.logDetailBytes.textContent = formatBytes(entry.bytes) || `${entry.bytes} B`;
    els.logDetailCaptureWarning.hidden = !entry.payloadTruncated;
    let mode = 'hex';
    const apply = () => {
      els.logDetailPayload.textContent = mode === 'hex' ? entry.payloadHex : entry.payloadText;
      els.logDetailHexBtn.classList.toggle('is-active', mode === 'hex');
      els.logDetailTextBtn.classList.toggle('is-active', mode === 'text');
    };
    els.logDetailHexBtn.onclick = () => { mode = 'hex'; apply(); };
    els.logDetailTextBtn.onclick = () => { mode = 'text'; apply(); };
    apply();
  }
}
```

c) `public/styles.css` 追加（可放 `.port-type-badge` 新增规则附近）：

```css
.log-proto[data-protocol='tcp'] { color: var(--cyan); }
.log-proto[data-protocol='udp'] { color: #b48ce8; }

.payload-toggle { margin-left: 10px; display: inline-flex; gap: 4px; }
.payload-toggle .toggle-btn {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 11px;
  padding: 1px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  opacity: 0.65;
  cursor: pointer;
}
.payload-toggle .toggle-btn.is-active {
  opacity: 1;
  color: var(--cyan);
  border-color: currentColor;
}
```

- [ ] **Step 4: 跑 E2E 确认通过**

Run: `pnpm playwright test test/e2e/capture.spec.js`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/styles.css test/e2e/capture.spec.js
git commit -m "feat: 日志流抓包条目渲染 + 详情弹窗 hex/文本双视图"
```

---

### Task 9: embed-assets 同步 + CLAUDE.md 更新 + 全量回归

**Files:**
- Modify: `embed-assets/public/{index.html,app.js,styles.css}`、`embed-assets/public/views/port-cards.js`（从 `public/` 对应文件拷贝）
- Modify: `CLAUDE.md`（不变量 #9、模块职责表、测试布局）

**Interfaces:**
- Consumes: Task 6-8 的全部前端产物
- Produces: 编译产物与 dev 行为一致；文档与代码一致

- [ ] **Step 1: 同步 embed-assets 并验证零漂移**

```bash
cp public/index.html public/app.js public/styles.css embed-assets/public/
cp public/views/port-cards.js embed-assets/public/views/
diff -r public embed-assets/public
```

Expected: diff 无输出（仅 vendor 目录是 embed-assets 特有，不参与 public 对比——若 diff 报 vendor，改用 `diff -r public embed-assets/public --exclude=vendor` 或逐一比对上述 4 个文件）

- [ ] **Step 2: 更新 CLAUDE.md**

- 关键不变量 #9 改为：端口分类型：`type: 'http'|'ws'|'tcp'|'udp'` 创建后不可改；资源类型必须与端口类型匹配（`PORT_TYPE_MISMATCH`——`assertHttpPort` 对一切非 http 类型拒绝）。
- 模块职责表新增行：`src/capture.js` — TCP/UDP 抓包数据平面（net/dgram）；空闲 200ms 聚合、连接上限 200、maxBodyBytes 截断；纯抓包不响应。
- 测试布局 unit 行追加 `capture`；e2e 行追加 `capture`。

- [ ] **Step 3: 全量回归**

Run: `pnpm test`
Expected: PASS（unit + integration 全绿）

Run: `pnpm test:e2e`
Expected: PASS（全部 e2e，含既有 happy-path / port-cards / port-detail / log-detail-modal 等——重点确认 log-detail-modal.spec.js 未受弹窗结构改动影响）

- [ ] **Step 4: Commit**

```bash
git add embed-assets/public CLAUDE.md
git commit -m "chore: 同步 embed-assets + CLAUDE.md 记录抓包能力与不变量更新"
```

---

## Self-Review 记录（计划落盘前已执行）

- **Spec 覆盖**：§1 结论 → Task 1-8；§2 方案 A → Task 4；§3 约束（全局唯一/类型不可变/级联 no-op/互斥收紧/200ms 常量）→ Task 4/5；§4 引擎行为（聚合/flush/截断/上限/隔离/stop）→ Task 3/4；§5 日志模型 → Task 1/8；§6 API → Task 5；§7 UI → Task 6/7/8；§8 错误处理 → Task 3/4 的静默 error 分支与隔离测试；§9 测试计划 → 各 Task 内嵌；§11 文档影响 → Task 9。§10 二期挂钩不实现（YAGNI）。
- **类型一致性**：`createTcpCaptureServer`/`createUdpCaptureSocket` 签名在 Task 2/3 定义、Task 4 消费，参数名 `port/logBuffer/getMax`（+可选 `idleMs/maxConnections`）一致；捕获条目字段在 Task 1 定义、Task 8 消费一致（`payloadHex/payloadText/payloadTruncated/bytes/remote/connectionId/event`）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
