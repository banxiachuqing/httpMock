import { describe, it, expect } from 'vitest';
import net from 'node:net';
import dgram from 'node:dgram';
import { buildCaptureEntry, buildCaptureEvent, createUdpCaptureSocket, createTcpCaptureServer } from '../../src/capture.js';

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
