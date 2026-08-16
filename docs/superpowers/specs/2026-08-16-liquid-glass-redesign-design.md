# 接口管理页布局改造 + Apple Liquid Glass 全局换皮 — 设计

**日期**：2026-08-16
**状态**：待用户审查
**目标版本**：mock-tools 前端视觉迭代（零构建，纯 public/ 改动）

---

## 1. 背景与目标

HTTP 接口管理页（端口详情页）当前问题：

1. 端点操作按钮（删除/撤销/保存）在编辑区**底部**横条，与上方面板有色差，删除在最左、易误触
2. 「Cinematic Dark Glass」视觉方向偏重（深色渐变 + 靛蓝），用户希望换成 **Apple 官网/iOS 26 的 Liquid Glass 拟态玻璃质感**，且液态感要强（镜面高光、hover 玻璃微鼓起）
3. 窗口缩小时编辑区底部按钮条挤压响应体编辑器

**目标**：

1. HTTP 接口管理页：操作按钮全部上移到编辑区顶部，删除（红色）固定最右、分隔线隔开；去掉底部按钮条；小窗口下编辑列整体可滚动
2. 全局换皮：`styles.css` 双主题 token 重调为 Apple Liquid Glass 质感（亮/暗两套），首页卡片、WS 页、弹窗、日志全部跟随
3. 液态感动效：hover 亮度/位移/缩放微动效 + 镜面高光边，尊重 `prefers-reduced-motion`

**非目标（本次不做）**：

- WS operation 编辑页的布局不动（保留其底部按钮条）——见 §6 已知不一致
- mock 引擎 / API / ConfigStore / 桌面壳零改动
- CodeMirror 编辑器内部不加玻璃（实底保可读性）
- 不引入新依赖，不引入视觉回归测试基建（手工验收代替）

---

## 2. 已确认的需求决策

| # | 决策 |
|---|---|
| 1 | 布局 = 方案 A「经典工作台」：左列表 / 右编辑器 / 底日志骨架不动，改动最小（视觉伴侣 layout-options.html 确认） |
| 2 | 风格 = Apple Liquid Glass，选「液态感再强一点」档：镜面高光、折射边、hover 玻璃微鼓起/亮度变化（视觉伴侣 style-apple-glass.html 确认） |
| 3 | 范围 = **全局换皮**（token 层全应用生效）+ **布局只改 HTTP 接口管理页** |
| 4 | 双主题：亮/暗都按 Apple Glass 方向重做 token（主题系统 2026-08-15 spec 已落地，沿用 `data-theme` 架构） |

---

## 3. 布局改造（仅 HTTP 接口管理页）

### 3.1 按钮上移

- 删除 HTTP 表单底部 `.editor-footer` 节点（index.html ~290 行：`删除 ｜ spacer ｜ 撤销 保存`）
- 三个按钮移入 `.editor-header-right`（`#lastSaved` 之后），顺序与样式：

```html
<div class="editor-header-right">
  <span class="last-saved mono" id="lastSaved">已保存</span>
  <button class="btn btn-ghost" id="revertBtn">撤销</button>
  <button class="btn btn-primary" id="saveBtn">保存</button>
  <span class="header-sep" aria-hidden="true"></span>
  <button class="btn btn-danger" id="deleteBtn">删除</button>
</div>
```

- `.header-sep`：1px 竖分隔线（token 化颜色），隔开常规操作与危险操作
- **落点选 `.editor-header` 而非「响应体」工具栏**：它是编辑区唯一全宽顶栏；「响应体」工具栏只跨左 pane、已有格式化/校验/动态值三按钮 + 校验状态，语义也不符（端点级操作属于整个编辑区）

### 3.2 兼容性

- 按钮 **ID 全部不变** → `app.js` 事件接线零改动；E2E 按 ID 选择，零破坏
- `.editor-footer` / `.editor-header` 类被 WS 详情页共用（index.html ~394 行），**CSS 规则保留**，只删 HTTP 的 DOM 节点
- 左侧接口列表每行的 `×` 删除按钮保留（现有行为，不在本次需求内）

### 3.3 小窗口滚动

- `.editor-form` 成为滚动容器（`overflow-y: auto`）：表单 + 编辑/预览整体滚动，响应体编辑器不再被底部截掉
- 去掉底部按钮条后释放的垂直空间自然归还编辑区

---

## 4. 视觉 token（全局）

### 4.1 机制

沿用主题系统架构：只重写 `:root`（暗色默认）与 `:root[data-theme="light"]`（亮色覆盖）两个块的**变量值**，变量名不改，组件层规则基本零改动。少量共享组件微调（`.btn` 一族、玻璃 backdrop-filter、光斑背景层）。精确取色以已确认的 mockup（`.superpowers/brainstorm/368-1786887521/content/style-apple-glass.html`）为准，实现时允许按实际观感微调数值，不改方向。

### 4.2 暗色（`:root`）

| 项 | 值 |
|---|---|
| 底色 | `#101014`（替换现有 `--bg-gradient` 深黑渐变） |
| 光斑 | 蓝 `rgba(10,132,255,.28)` 左上 · 紫 `rgba(191,90,242,.2)` 右上 · 绿 `rgba(48,209,88,.12)` 底部（重写 `--blob-*`） |
| 面板 | `--surface-1..3` → `rgba(40,40,50,.45)` 一族三档渐进 |
| 玻璃 | `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`，新增 `--glass-saturate: 180%` |
| 高光边 | `--glass-highlight` → `inset 0 1px 0 rgba(255,255,255,.12)` |
| 主色 | `--cyan` 靛蓝 `#5E6AD2` → Apple 蓝 `#0A84FF`（focus ring / glow / log-enter 等派生值联动） |
| 信号灯 | 绿 `#30D158` · 琥珀 `#FFD60A` · 红 `#FF453A` |
| 方法五色 | GET `#30D158` / POST `#0A84FF` / PUT `#FFD60A` / PATCH `#BF5AF2` / DELETE `#FF453A`（HEAD/OPTIONS `#98989D`） |
| 文字 | 主 `#F5F5F7`，次级 `#98989D` 一族 |
| 编辑器底 | 实底 `rgba(0,0,0,.35)`（新增 token `--editor-bg`，两主题各自赋值） |

### 4.3 亮色（`:root[data-theme="light"]` 块重写）

| 项 | 值 |
|---|---|
| 底色 | `#F5F5F7` |
| 光斑 | 四色：蓝 `rgba(0,122,255,.22)` 左上 · 粉红 `rgba(255,45,85,.13)` 右上 · 紫 `rgba(88,86,214,.18)` 右下 · 绿 `rgba(52,199,89,.12)` 左下 —— 现有 3 个光斑 token/背景层扩为 4 个（新增 `--blob-4`，body 背景层同步加一条） |
| 面板 | `rgba(255,255,255,.50~.72)` 三档渐进，白亮边 `rgba(255,255,255,.65)`，高光 `inset rgba(255,255,255,.7)` |
| 主色 | `#0071E3` |
| 信号灯 | 绿 `#34C759` · 琥珀 `#FF9500` · 红 `#FF3B30` |
| 方法五色 | GET `#34C759` / POST `#0071E3` / PUT `#FF9500` / PATCH `#AF52DE` / DELETE `#FF3B30`（HEAD/OPTIONS `#6E6E73`） |
| 文字 | 主 `#1D1D1F`，次级 `#6E6E73` 一族 |
| 编辑器底 | 实底 `#FFFFFF`（`--editor-bg`） |
| 输入控件 | 面板/卡片用白亮边；输入框等控件保留浅黑细边（`rgba(0,0,0,.07)` 一族，按 mockup） |

### 4.4 共享组件微调

- **圆角**：`--r-1 6→10px`、`--r-2 10→14px`、`--r-3 16→20px`
- **`.btn` 一族改胶囊形**：`border-radius: 999px`；transition 补 `transform`、`filter`
  - `.btn-primary`：实心蓝胶囊（新 token `--accent-fill`，暗 `#0A84FF` / 亮 `#0071E3`）+ 白字 + 同色投影；`data-state` 变体（stopped/starting/running 的 LED 与描边）保留可用——顶栏启动/停止按钮依赖它
  - `.btn-ghost`：半透玻璃胶囊 + 细边
  - `.btn-danger`：红色玻璃胶囊（红底 `rgba(255,59,48,.1)` 一族 + 红字 + 红细边，两主题各自取值）
- **字体**：`--font-sans` 把 `-apple-system, 'SF Pro Text'` 提到最前（Windows 回退 PingFang/YaHei 链不变）

---

## 5. 液态感动效

| 元素 | 动效 |
|---|---|
| 玻璃面板/卡片/列表项 hover | `filter: brightness(1.03)` + 高光边增强 + `translateY(-1px)` |
| 按钮 hover | 背景提亮 + `scale(1.02)`；active `scale(.97)` |
| 胶囊工具条/顶栏 | 静态镜面质感：inset 顶部高光 + 外投影（非动画） |
| 过渡时长/曲线 | 复用 `--d-fast` / `--d-norm` / `--ease` |
| `prefers-reduced-motion: reduce` | 关闭 transform / filter 过渡（只保留颜色变化） |

不做折射/形变 morphing 类重动效——长时间编辑大 JSON 时干扰稳定性（YAGNI）。hover 动效作用于面板/卡片/按钮层，编辑器内部不加。

---

## 6. 边界与已知不一致

- **WS operation 编辑页保留底部按钮条**（`.editor-footer` CSS 与 WS DOM 都不动）——用户选定的范围决策；同一应用内两种操作布局并存，记录在案，如后续需要再以独立迭代统一
- CodeMirror 内部只随 token 调背景与语法色，不加玻璃、不加 hover 动效
- 首页卡片、WS 服务网格、弹窗、日志面板、设置面板：**只换 token，DOM 不动**

---

## 7. 同步与测试策略

### 7.1 变更文件

- `public/index.html`（按钮节点移动 + 光斑背景层如需加一条）
- `public/styles.css`（两主题 token 块重写 + `.btn` 一族 + 滚动容器 + `.header-sep`）
- `public/app.js` 预期零改动（按钮 ID 不变；如滚动调整涉及 JS 则最小化）
- **不变量 #5**：以上 `public/` 改动同步到 `embed-assets/`

### 7.2 自动化

- `pnpm test`（单元 + 集成）全绿——本次无后端改动，门槛性验证
- `pnpm test:e2e` 全绿——按钮 ID 未变，现有用例零破坏是硬门槛
- `test/e2e/port-detail.spec.js` 新增**意图断言**（布局意图变了，旧布局若复现必须红）：
  1. `#deleteBtn` 与 `#saveBtn` 的 boundingBox 落在 `.editor-header` 区域内（按钮确实在顶部）
  2. `deleteBtn` 的 x 坐标 > `saveBtn`（删除确实在最右）
  3. HTTP 表单下 `.editor-form > .editor-footer` 不存在（只删了 HTTP 的）
- WS 侧守护断言（`.editor-footer` 在 WS 视图仍在）加在现有 WS E2E 用例里（如 `test/e2e/` 下 WS 相关 spec）；若无现成落点则在 port-detail.spec.js 内加一条导航到 WS 服务详情页的用例

### 7.3 手工验收清单

1. 暗/亮双主题下玻璃质感：彩色背景透出、面板半透、高光边可见
2. hover 动效：卡片/按钮亮度与位移自然，无卡顿（backdrop-filter 性能可接受）
3. 亮色主题无深色残留（沿用主题 spec §7 的页面走查清单）
4. 小窗口（~768px 高）下编辑列可滚动，响应体不被截
5. 顶栏启动/停止按钮三态（stopped/starting/running）在新按钮样式下仍清晰
6. `prefers-reduced-motion` 下无位移动效

---

## 8. 取舍记录

| 方案 | 结论 |
|---|---|
| 按钮进 `.editor-header-right`（全宽顶栏） | **采纳**：语义正确、不挤占响应体工具栏 |
| 按钮进「响应体」工具栏 `.toolbar-right` | 否决：只跨左 pane、已拥挤、语义不符 |
| WS 页布局顺手同改 | 否决：用户选定范围只做 HTTP 页；不一致已记录（§6） |
| 只改 HTTP 页的局部皮肤隔离 | 否决：共享样式表，会造成页面间风格断层 |
| 折射/形变 morphing 重动效 | 否决：编辑稳定性 + YAGNI |
| 视觉回归测试基建 | 否决：项目无既有基建，本次手工验收代替（YAGNI） |
| `.btn` 保持方角只换色 | 否决：胶囊按钮是 Apple Glass 的核心识别特征 |
