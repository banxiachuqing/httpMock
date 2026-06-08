# Mock Server（本地 HTTP 模拟工具 · WebUI）

## Problem
全栈/后端开发在本地自测时，需要一个能反复使用、可视化配置的 mock 接口服务。当前选择都不顺手：json-server 表达力不足（不支持任意 method/path/响应体组合）；Postman / Apifox 的 mock 中心太重且依赖云端账号；自己起 Express 临时脚本则每次都要改代码、重启服务，且看不到请求日志。

## Evidence
- 用户自述反复被上述痛点卡住（自用场景，尚未做团队级数据收集）

## Users
- **Primary**：全栈/后端工程师，本地联调前端、模拟第三方回调（支付/登录/消息推送等）
- **Not for**：需要团队协作/云端共享、动态脚本化响应、HTTPS 接入的团队与项目

## Hypothesis
我们相信 **"打开即用、零配置的本地 mock 工具，支持多接口配置和实时请求日志"** 将 **解决本地联调时 mock 反复搭建、看不到调用明细的痛点** for **全栈/后端开发者**。
我们会在 **首次安装到完成第一个 mock 接口配置、启动服务并看到请求打进来，整个流程 < 3 分钟** 时验证假设成立。

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| 首次上手到第一个 mock 端到端跑通 | < 3 分钟 | 内部 dogfood 计时 |
| 单端口配置多个 endpoint 时路由正确 | 100% 命中正确响应 | curl 验证每个 method+path |
| 端口被占用时给出明确提示 | 100% 提示成功 | 故意占用端口后启动 |
| 跨平台开箱即用 | macOS 与 Windows 均能跑通 | 双平台 smoke test |
| 持久化目录可发现且可改 | 用户能在 UI 中查看/修改存储路径 | 手动验证 |

## Scope

**MVP** —— 用户在 WebUI 中：

1. 配置多个 mock 接口（每条记录：HTTP 方法 + 路径 + 所属端口 + 返回 JSON 文本）
2. 同一个端口可挂多个 endpoint（按 method + path 精确匹配）
3. 启动/停止 mock 服务
4. 在 JSON 文本域中：实时语法校验 + 一键格式化（2 空格缩进）
5. 底部面板实时显示请求日志（时间、方法、路径、状态码、耗时）——**仅内存，不落盘**
6. 配置数据持久化到「电脑文档目录」下的子目录；首次启动可指定目录，后续可在 UI 中查看/修改
7. 跨平台：macOS 与 Windows 都能开箱即用
8. 端口冲突时给出明确错误提示

**Out of scope**
- 鉴权 / 账号 / 云同步 / 团队共享 — 与"轻量本地"定位冲突
- 请求录制 / 代理劫持 / 性能压测 — 不在 MVP 范围
- HTTPS / 证书 / 鉴权 Header — MVP 仅 HTTP
- 动态脚本 / 模板变量 / 函数化响应 — MVP 响应体是静态 JSON
- 日志持久化 / 跨会话日志回看 — 仅实时显示

## Delivery Milestones

<!-- 业务结果，非工程任务；/plan 将每个转化为一个 plan。 -->
<!-- Status: pending | in-progress | complete -->

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | 本地 mock 服务核心 | 用户能在 UI 配置多条接口、启动后按 method+path 命中正确响应；端口冲突有提示 | pending | — |
| 2 | JSON 体验 + 实时请求日志 | JSON 文本域带校验与一键格式化；底部面板实时显示请求日志 | pending | — |
| 3 | 跨平台持久化与设置 | macOS/Windows「文档目录」读写正常；UI 中可查看与修改存储路径 | pending | — |

## Open Questions

- [ ] 启动形态：单 Node 进程支持多端口 vs. 每端口一个子进程？（影响实现复杂度与启动速度）
- [ ] 端口冲突时是直接报错让用户改，还是允许绑定到次优端口并提示？（倾向：直接报错，避免歧义）
- [ ] 实时请求日志的实现方式：SSE 推送 vs. 短轮询？日志条数上限多少？
- [ ] "实时请求日志"是否需要"清空"按钮？（MVP 倾向提供）

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 跨平台路径差异（macOS vs. Windows） | Medium | Medium | 使用 `path.join` + 平台探测；macOS 走 `~/Documents`，Windows 走 `%USERPROFILE%\\Documents`；在 UI 显式展示当前路径 |
| 端口被占导致启动失败 | High | Low | 启动前用 `lsof`（macOS）/ `netstat`（Windows）检测；UI 给出"端口 X 被占用"明确提示 |
| 大量请求导致 UI 卡顿 | Medium | Medium | 日志条数上限（例如 500 条）+ 环形覆盖；非持久化；不阻塞主线程 |
| 单文件 JSON 配置易损坏 | Low | High | 写入用原子替换（写临时文件 → `fs.rename` 覆盖），读取失败时备份原文件 |
| 同一端口不同接口的方法/路径重复 | Medium | Low | UI 提交前校验唯一性，重复时给出行内错误 |

---

*Status: DRAFT — 仅需求。实现规划待 `/plan` 启动。*
