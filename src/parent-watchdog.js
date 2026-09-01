// 父进程看门狗（desktop 模式专用）。
// 背景：Tauri 壳若被 SIGKILL（tauri dev Ctrl+C、崩溃、强制退出），壳侧的
// kill_sidecar（main.rs RunEvent::ExitRequested）不会执行，sidecar 变孤儿并
// 继续占用 WebUI 端口（下次启动 listenWithFallback 静默漂移到 5051+）。
// 机制：Unix 下父进程死后本进程 ppid 变为 1（launchd 收养），轮询检测到
// ppid 离开初始值即触发 onOrphaned（server.js 里直接 exit，内核回收端口）。
// 仅壳注入的 MOCK_DESKTOP=1 场景启用；手动运行（无该环境变量）不受影响。
// Windows 上父 PID 可能被复用、检测不可靠——正常退出仍依赖壳侧 kill_sidecar。

export function startParentWatchdog({
  intervalMs = 2000,
  getPPID = () => process.ppid,
  onOrphaned,
  log = () => {},
} = {}) {
  const initialPPID = getPPID();
  const timer = setInterval(() => {
    if (getPPID() === initialPPID) return;
    clearInterval(timer);
    log(`parent process (${initialPPID}) exited, shutting down`);
    onOrphaned?.();
  }, intervalMs);
  timer.unref?.(); // 不阻止进程自然退出
  return () => clearInterval(timer);
}
