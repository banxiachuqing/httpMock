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
