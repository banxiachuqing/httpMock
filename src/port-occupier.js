// 端口占用排查与释放（平台相关）。macOS/Linux 用 lsof 定位并 kill 监听进程；Windows 暂不支持（上层提示手动处理）。
// 依赖通过 io 参数注入（默认真实实现），便于测试 stub。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';

const realExecFile = promisify(execFile);

const defaultIo = {
  platform: process.platform,
  execFile: realExecFile,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * 查监听某 TCP 端口的进程。
 * @returns {{supported: boolean, pids: Array<{pid: number, command: string}>}}
 *   supported=false 表示当前平台不支持（win32）；pids 为空表示无占用。
 */
export async function findOccupier(port, io = defaultIo) {
  if (io.platform === 'win32') return { supported: false, pids: [] };
  let stdout = '';
  try {
    ({ stdout } = await io.execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']));
  } catch {
    return { supported: true, pids: [] }; // lsof 无匹配时 exit 1 → 视为无占用
  }
  const pids = [];
  for (const line of stdout.split('\n').slice(1)) { // 跳过表头
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const pid = Number(cols[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push({ pid, command: cols[0] });
  }
  return { supported: true, pids };
}

// 轮询等端口释放（占用进程退出/ socket 关闭需要时间）
async function waitPortFree(port, io, { tries = 20, intervalMs = 75 } = {}) {
  for (let i = 0; i < tries; i++) {
    const occ = await findOccupier(port, io);
    if (occ.pids.length === 0) return true;
    await io.sleep(intervalMs);
  }
  return false;
}

/**
 * kill 监听某端口的进程以释放它：先 SIGTERM，等待后仍占用则升级 SIGKILL。
 * 只针对传入端口上监听的进程，逐 PID 精确 kill，不盲杀。
 * @returns {{killed: number[]}} 被 kill 的 PID 列表（无占用则为空）
 */
export async function forceFreePort(port, io = defaultIo) {
  if (io.platform === 'win32') {
    throw new AppError(400, 'UNSUPPORTED', 'Windows 暂不支持强制释放端口，请手动结束占用进程');
  }
  const occ = await findOccupier(port, io);
  if (occ.pids.length === 0) return { killed: [] };
  for (const { pid } of occ.pids) { try { io.kill(pid, 'SIGTERM'); } catch {} }
  if (await waitPortFree(port, io)) return { killed: occ.pids.map((p) => p.pid) };
  // SIGTERM 未释放 → 升级 SIGKILL
  for (const { pid } of occ.pids) { try { io.kill(pid, 'SIGKILL'); } catch {} }
  await waitPortFree(port, io);
  return { killed: occ.pids.map((p) => p.pid) };
}
