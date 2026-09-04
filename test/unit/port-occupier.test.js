import { describe, it, expect, vi } from 'vitest';
import { findOccupier, forceFreePort } from '../../src/port-occupier.js';

const LSOF_TABLE = `COMMAND   PID   USER      FD   TYPE DEVICE SIZE/OFF NODE NAME
node    12345 zhangjie   22u  IPv6 0xabc      0t0  TCP 127.0.0.1:8080 (LISTEN)
`;

// 默认注入真实实现；测试用 stub。io = { platform, execFile, kill, sleep }
function makeIo(over = {}) {
  return {
    platform: 'darwin',
    execFile: vi.fn(async () => ({ stdout: '' })),
    kill: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

describe('findOccupier：查监听某端口的进程', () => {
  it('解析 lsof 表格输出 → [{pid, command}]', async () => {
    const io = makeIo({ execFile: vi.fn(async () => ({ stdout: LSOF_TABLE })) });
    const r = await findOccupier(8080, io);
    expect(r.supported).toBe(true);
    expect(r.pids).toEqual([{ pid: 12345, command: 'node' }]);
    expect(io.execFile).toHaveBeenCalledWith('lsof', ['-nP', '-iTCP:8080', '-sTCP:LISTEN']);
  });

  it('lsof 无匹配（exit 1 抛错）→ 视为无占用', async () => {
    const io = makeIo({
      execFile: vi.fn(async () => { const e = new Error('exit 1'); e.code = 1; throw e; }),
    });
    const r = await findOccupier(8080, io);
    expect(r.supported).toBe(true);
    expect(r.pids).toEqual([]);
  });

  it('win32 → supported:false，且不调 lsof', async () => {
    const io = makeIo({ platform: 'win32' });
    const r = await findOccupier(8080, io);
    expect(r.supported).toBe(false);
    expect(r.pids).toEqual([]);
    expect(io.execFile).not.toHaveBeenCalled();
  });
});

describe('forceFreePort：kill 占用进程释放端口', () => {
  it('无占用 → 不 kill，killed 为空', async () => {
    const io = makeIo();
    const r = await forceFreePort(8080, io);
    expect(r.killed).toEqual([]);
    expect(io.kill).not.toHaveBeenCalled();
  });

  it('SIGTERM 后端口释放 → 不再升级 SIGKILL', async () => {
    let occupied = true;
    const io = makeIo({
      execFile: vi.fn(async () => ({ stdout: occupied ? LSOF_TABLE : '' })),
      kill: vi.fn(() => { occupied = false; }), // SIGTERM 即释放
    });
    const r = await forceFreePort(8080, io);
    expect(r.killed).toEqual([12345]);
    expect(io.kill).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(io.kill).not.toHaveBeenCalledWith(12345, 'SIGKILL');
  });

  it('SIGTERM 不释放 → 升级 SIGKILL', async () => {
    let occupied = true;
    const io = makeIo({
      execFile: vi.fn(async () => ({ stdout: occupied ? LSOF_TABLE : '' })),
      kill: vi.fn((pid, sig) => { if (sig === 'SIGKILL') occupied = false; }), // 只有 SIGKILL 才释放
    });
    const r = await forceFreePort(8080, io);
    expect(r.killed).toEqual([12345]);
    const sigs = io.kill.mock.calls.map((c) => c[1]);
    expect(sigs).toContain('SIGTERM');
    expect(sigs).toContain('SIGKILL');
  });

  it('win32 → 抛 UNSUPPORTED', async () => {
    const io = makeIo({ platform: 'win32' });
    await expect(forceFreePort(8080, io)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
