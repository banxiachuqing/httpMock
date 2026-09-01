import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startParentWatchdog } from '../../src/parent-watchdog.js';

describe('startParentWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ppid 不变时不触发', () => {
    let ppid = 123;
    const onOrphaned = vi.fn();
    startParentWatchdog({ getPPID: () => ppid, onOrphaned });
    vi.advanceTimersByTime(10000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('ppid 离开初始值（父进程死亡被收养）时触发 onOrphaned', () => {
    let ppid = 123;
    const onOrphaned = vi.fn();
    const log = vi.fn();
    startParentWatchdog({ getPPID: () => ppid, onOrphaned, log });
    ppid = 1; // 父进程死亡，launchd 收养
    vi.advanceTimersByTime(2500);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });

  it('触发后停止轮询（不重复触发）', () => {
    let ppid = 123;
    const onOrphaned = vi.fn();
    startParentWatchdog({ getPPID: () => ppid, onOrphaned });
    ppid = 1;
    vi.advanceTimersByTime(2500);
    ppid = 999;
    vi.advanceTimersByTime(10000);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it('返回的 stop 可手动取消轮询', () => {
    let ppid = 123;
    const onOrphaned = vi.fn();
    const stop = startParentWatchdog({ getPPID: () => ppid, onOrphaned });
    stop();
    ppid = 1;
    vi.advanceTimersByTime(10000);
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});
