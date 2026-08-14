import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../server.js";
import { tempDir } from "../helpers/temp-dir.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

let handle, dir;

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (dir) dir.cleanup();
  dir = undefined;
});

/** 收集子进程 stdout 直到出现指定前缀的行（或退出/超时） */
function waitForLine(child, prefix, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`等待 ${prefix} 超时，已收到：${buf}`)),
      timeoutMs,
    );
    child.stdout.on("data", (d) => {
      buf += d;
      const line = buf
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith(prefix));
      if (line) {
        clearTimeout(timer);
        resolve(line);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`进程退出(${code})，未收到 ${prefix}，输出：${buf}`));
    });
  });
}

function spawnDesktop(extraEnv) {
  return spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, MOCK_DESKTOP: "1", ...extraEnv },
  });
}

describe("desktop 模式（MOCK_DESKTOP）", () => {
  it("startServer({desktop:true}) 打印 MOCK_READY，端口为实际绑定端口且可服务", async () => {
    dir = tempDir("mock-desktop-");
    const lines = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      lines.push(String(chunk));
      return origWrite(chunk, ...args);
    };
    try {
      handle = await startServer({
        storagePath: dir.path,
        uiPort: 0,
        openBrowser: false,
        desktop: true,
      });
    } finally {
      process.stdout.write = origWrite;
    }

    const readyLine = lines
      .map((l) => l.trim())
      .find((l) => l.startsWith("MOCK_READY "));
    expect(readyLine).toBeTruthy();
    const payload = JSON.parse(readyLine.slice("MOCK_READY ".length));
    expect(payload.host).toBe("127.0.0.1");
    expect(payload.port).toBe(handle.port);

    const res = await fetch(`http://127.0.0.1:${payload.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it("MOCK_DESKTOP=1 子进程经 isMain 入口启动，stdout 输出 MOCK_READY", async () => {
    dir = tempDir("mock-desktop-");
    const child = spawnDesktop({ HOME: dir.path });
    try {
      const readyLine = await waitForLine(child, "MOCK_READY ");
      const payload = JSON.parse(readyLine.slice("MOCK_READY ".length));
      const res = await fetch(`http://127.0.0.1:${payload.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("启动失败时打印 MOCK_ERROR 并以非零码退出", async () => {
    dir = tempDir("mock-desktop-");
    // defaultStoragePath() 回退逻辑：~/Documents 不是目录 → 用 ~/MockServer；
    // 两个候选都做成"已存在的普通文件"，ensureDir 必然抛错
    fs.writeFileSync(path.join(dir.path, "Documents"), "not a dir");
    fs.writeFileSync(path.join(dir.path, "MockServer"), "not a dir");
    const child = spawnDesktop({ HOME: dir.path });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    expect(code).toBe(1);
    const errLine = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("MOCK_ERROR "));
    expect(errLine).toBeTruthy();
    expect(
      JSON.parse(errLine.slice("MOCK_ERROR ".length)).message,
    ).toBeTruthy();
  });
});
