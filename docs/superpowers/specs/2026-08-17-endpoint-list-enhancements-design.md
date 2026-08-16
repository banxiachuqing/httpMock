# 接口列表增强：复制接口 + 拖拽排序 + 删除撤销按钮 — 设计

**日期**：2026-08-17
**状态**：已确认（brainstorming 完成，用户批准）
**范围**：HTTP 接口管理页（`#/port/<port>` 的接口列表侧栏 + 编辑区 header）
**关联**：延续 2026-08-16 Liquid Glass 换皮后的视觉体系

---

## 1. 背景与目标

HTTP 接口管理页的接口列表目前只有「选中」和「删除」两个操作，顺序固定为创建顺序且无法调整；编辑区 header 上的撤销按钮使用率低、占位碍眼。

目标：

1. 列表项支持**一键复制**现有接口（含响应体），用于快速派生相似接口
2. 列表支持**拖拽排序**，顺序持久化到 data.json
3. **删除** HTTP 页编辑区的撤销按钮（`#revertBtn`）

## 2. 已确认的需求决策

| 决策点 | 结论 |
|---|---|
| 复制撞唯一性约束怎么办 | 自动改路径后缀：`<path>-copy`，再撞则 `-copy-2` 递增（用户已确认） |
| 复制实现路径 | 客户端拼装 + 现有 `POST /api/endpoints`，不新增复制路由 |
| 排序 API 形态 | 新增 `PUT /api/endpoints/order`，body 为全量 id 排列 |
| 拖拽实现 | 原生 HTML5 DnD，零依赖 |
| 撤销按钮删除范围 | 仅 HTTP 页 `#revertBtn`；WS 页 `wsRevertBtn` 不动 |

## 3. 复制接口

### 3.1 入口与外观

- 列表项 `.endpoint-name-row` 内、删除按钮（`.endpoint-delete`）**左侧**新增 `<button class="endpoint-copy">`
- 22px 图标按钮（复制/双矩形图标），与删除按钮同一套显现逻辑：默认 `opacity: 0`，`.endpoint-item:hover` / `:focus-within` 时显现
- hover 配色用新增 token `--cyan-wash`（暗 `rgba(10,132,255,0.12)` / 亮 `rgba(0,113,227,0.10)`）+ `color: var(--cyan)`，与删除的红色系区分
- `aria-label="复制接口"`、`title="复制接口"`

### 3.2 流程（`copyEndpointById(id)`，纯前端编排）

1. 从 `state.endpoints` 取源端点
2. 计算新路径：候选 `<path>-copy`；只要 `(port, method, 候选)` 与任一**启用**端点（`enabled !== false`）冲突，就递增为 `<path>-copy-2`、`<path>-copy-3`……（与 `checkUniqueness` 同谓词）
3. 名称：源有名称则加「(副本)」后缀；空则保持空（回落显示 `METHOD path`）
4. `POST /api/endpoints`：`{ method, port, path: 候选, statusCode, response: structuredClone(源.response), name, enabled: true }`
5. 成功后新端点插入 `state.endpoints` 中**源端点正后方**，自动选中并进入编辑态——沿用 `createEndpoint` 的强制重置行为（不拦截未保存编辑，与现有「新建」一致）
6. 失败（含服务端唯一性驳回，400 `DUPLICATE_ENDPOINT`）：`alert("复制失败：" + message)`，不改本地状态

服务端唯一性校验是最终权威；客户端避撞只是让正常路径不触发报错。

## 4. 拖拽排序

### 4.1 API：`PUT /api/endpoints/order`

- body：`{ ids: string[] }`
- 校验：必须是现有端点 id 的**排列**——数组长度相等、无重复、无未知 id；否则 `400 INVALID_ORDER`（`ids must be a permutation of endpoint ids`）
- 通过则 `ConfigStore.update` 内整体重排 `cfg.endpoints = ids.map(id => byId.get(id))`，返回 `200` + 重排后的数组
- 顺序纯展示语义：mock 引擎按 `port|method|path` Map 路由，不受顺序影响，无需重启运行时

### 4.2 前端交互（原生 HTML5 DnD）

- `renderEndpointList` 给每个 `li` 设 `draggable = true`
- `dragstart`：记录 `state.draggingId`，`dataTransfer.setData('text/plain', id)`（Firefox 必需），加 `.dragging`（半透明）
- 目标项 `dragover`：`preventDefault()`，按指针位于项上/下半区设置 `.drop-above` / `.drop-below`（靛蓝指示线，CSS 伪元素实现，跟随 `--cyan`）
- `drop`：计算新顺序 → 清除 `draggingId` 与所有拖拽态 class → 顺序没变则到此为止；变了则乐观重排 `state.endpoints`、`renderEndpointList()`、异步调 `api.reorderEndpoints(ids)`；失败 `alert` 且从服务端重拉列表回同步（不静默保留错误顺序）
- `dragend`（drop 之后或拖拽取消时触发）：兜底清理——`draggingId` 仍在则清除并补一次 `renderEndpointList()`

### 4.3 与 5s 轮询的冲突处理

`refreshRuntimeStatus` 每 5s 调 `renderEndpointList()` 重建 DOM，会在拖拽中途抽走拖动元素。处理：`renderEndpointList()` 开头加守卫——`state.draggingId` 非空时直接 return（LED 状态晚几秒刷新，无害）；drop / dragend 清除状态后立即渲染追平（§4.2）。

## 5. 删除撤销按钮

- `public/index.html`：删除 `.editor-header-right` 内的 `<button class="btn btn-ghost btn-sm" id="revertBtn">撤销</button>`
- `public/app.js`：删除 `els.revertBtn` 登记与 `addEventListener` 块；handler 逻辑（`dirty=false + renderEditor`）无其他调用方，随之消失
- **保留**：`selectEndpoint` 的未保存 confirm 守卫（那是切换接口的行为，不属于撤销按钮）
- **不动**：WS 服务详情页的 `wsRevertBtn`（另一页面）；`.editor-footer` 相关 CSS（WS 在用）

## 6. 边界与已知取舍

- 拖拽是**全局顺序**（列表混排所有端口的接口），跨端口拖动合法；WS 操作列表（`#operationList`）不做拖拽
- 复制不做批量、不做跨端口复制（改端口用编辑表单）
- 拖拽期间 LED 状态最多延迟一个轮询周期（5s）刷新——接受
- 复制沿用「新建」的强制重置行为：有未保存编辑时点复制不弹 confirm（与现有 `createEndpoint` 一致，保持一致性 > 单独加守卫）
- 顺序变更不广播给其他客户端（本地单用户工具，无多端协同需求）

## 7. 同步与测试策略

### 7.1 变更文件

| 文件 | 改动 |
|---|---|
| `src/api.js` | + `PUT /api/endpoints/order` 路由 |
| `test/integration/api-endpoints.test.js` | + order 路由用例 |
| `public/app.js` | 复制按钮接线 + `copyEndpointById`；DnD 处理 + 渲染守卫；删 `revertBtn` 接线 |
| `public/index.html` | 删 `#revertBtn` |
| `public/styles.css` | `.endpoint-copy` 样式 + 拖拽态（`.dragging` / `.drop-above` / `.drop-below`）+ `--cyan-wash` 双主题 token |
| `test/e2e/port-detail.spec.js` | + 复制用例、拖拽用例；布局意图用例追加 `#revertBtn` count=0 |
| `embed-assets/public/{app.js,index.html,styles.css}` | 同步（CLAUDE.md 不变量 #5） |

后端其余模块与 `src-tauri/` 零改动。

### 7.2 自动化（TDD，先 RED 后 GREEN）

- **集成**：order 路由——正常重排（返回值 + `GET /api/endpoints` 复核持久化）；非排列 400（长度错 / 未知 id / 重复 id）
- **E2E 复制**：点复制按钮 → 列表出现 `<path>-copy` 新项、自动选中、编辑器响应体与源一致；对同一源连拷两次 → 第二个副本路径为 `-copy-2`（避撞意图）
- **E2E 拖拽**：dragTo 交换顺序 → DOM 顺序变化 + 刷新后顺序保持（持久化意图）。Playwright 对 HTML5 DnD 用 `dragTo()`；若不稳则退化为 dispatchEvent 序列，以意图断言为准
- **E2E 撤销删除**：现有布局意图用例追加 `#editorForm #revertBtn` count=0，防复活

### 7.3 手工验收清单

1. hover 列表项：复制与删除按钮同时显现，复制蓝 / 删除红
2. 复制：新项出现在源正后方并选中；`-copy` 路径；响应体已拷贝；保存后 mock 端口可命中新路径
3. 连拷：第二次复制路径为 `-copy-2`
4. 拖拽：拖动半透明、目标位出现靛蓝指示线；放下即换序；刷新后保持
5. 拖拽期间列表不闪跳（轮询守卫生效）
6. 编辑区 header 无撤销按钮；保存/删除布局不受影响；WS 服务详情撤销按钮仍在
7. 亮/暗双主题下复制按钮与指示线颜色正常

## 8. 取舍记录

- **客户端拼装复制 vs 服务端 `POST /api/endpoints/:id/copy`**：选客户端——零新路由、复用校验链；本地单用户工具，并发竞态可忽略，服务端仍是权威校验
- **全量 id 排列 vs 锚点式 PATCH**：选全量——单请求原子、校验简单；锚点式请求多且竞态复杂，无收益
- **原生 DnD vs SortableJS**：选原生——单层垂直列表够用，不引入 vendor 依赖；代价是自己处理 5s 轮询冲突（一个守卫解决）
- **复制命名加「(副本)」vs 留空**：加后缀——列表会出现两个同名项，后缀防混淆；名称无唯一性约束，不引入校验负担
