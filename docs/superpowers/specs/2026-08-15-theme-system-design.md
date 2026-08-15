# 双主题系统 + 桌面标题栏一体化 — 设计

**日期**：2026-08-15
**状态**：待用户审查
**目标版本**：mock-server-webui v1 增量（桌面版首个体验迭代）

---

## 1. 背景与目标

桌面版（Tauri 壳）已可用，但存在体验割裂：界面是深色 Cinematic Dark Glass 单主题，窗口标题栏是亮色原生栏，且栏上 "MockServer" 文字多余。用户要求：

1. 前端做**暗色 + 亮色双主题**，设置面板提供主题选项（跟随系统 / 亮色 / 暗色），**默认跟随系统**
2. 去掉窗口标题栏的 "MockServer" 文字
3. 标题栏颜色随主题切换，消除壳与界面的割裂感

**目标**：

1. CSS 变量双主题架构，亮暗切换即时生效、刷新/重启保持
2. 主题设置持久化到 `data.json` settings（浏览器模式与桌面版一致）
3. macOS 标题栏 Overlay 一体化：红绿灯悬浮在内容区，栏色即界面色
4. Windows 原生标题栏通过 `setTheme` 跟随主题深浅

**非目标（本次不做）**：

- 不做多标签页/多设备间的主题实时同步（YAGNI）
- 不做 Windows 自定义标题栏（frameless 自绘）
- 不动任何 mock 业务逻辑与 API 信封格式（`PATCH /api/config` 仅加白名单键）
- 壳内嵌页面（loading/崩溃覆盖层）不读应用设置，统一跟随系统（见 §6 偏差声明）

---

## 2. 已确认的需求决策

| # | 决策 |
|---|---|
| 1 | 亮色主题风格：**浅色玻璃**（浅底 + 柔光斑 + 半透白玻璃面板，与暗色互为姊妹） |
| 2 | 主题存储：**`data.json` settings**（与 storagePath/uiPort 同机制），localStorage 作防闪烁缓存 |
| 3 | 标题栏形态：**macOS Overlay 融合栏**（`titleBarStyle: "Overlay"` + `hiddenTitle` + 空标题）；Windows 保留原生栏用 `setTheme` 染色 |
| 4 | 默认主题：**跟随系统** |

---

## 3. 主题架构（前端）

### 3.1 机制

- `<html data-theme="light|dark">` 属性驱动。`styles.css` 现有 `:root` 变量层保持为暗色（默认，向后兼容，未设置属性时行为不变）
- 新增 `:root[data-theme="light"]` 覆盖块定义亮色变量值；**变量名不变，组件样式零改动**
- 设置值三态：`system` / `light` / `dark`；`system` 由 `matchMedia('(prefers-color-scheme: dark)')` 解析并挂 change 监听

### 3.2 变量补齐

把散落在组件样式里的约 40 处硬编码颜色（body 背景渐变、径向光斑、状态徽章底色、玻璃高光、遮罩等）提进 `:root` 变量，两主题各自赋值。

亮色调色板方向（浅色玻璃）：

- 底色：浅灰蓝渐变（如 `#f4f6fa` → `#e8ecf4`），光斑为同色系低透明柔光
- 面板：半透白玻璃（`rgba(255,255,255,0.55~0.72)`）+ 细暗边（`rgba(15,23,42,0.08)`）
- 文字：深 slate 主色（如 `#1a2233`），次级/弱色同族降透明度
- 语义色（绿/琥珀/红/靛蓝/紫、method 五色）沿用色相，按亮底调对比度（加深而非照搬暗色值）

### 3.3 新模块 `public/theme.js`

- `resolveTheme(setting, prefersDark) -> 'light'|'dark'` — 纯函数，可单测
- `applyTheme(setting)` — 解析 → 设 `data-theme` → `system` 模式下挂/换 matchMedia change 监听 → Tauri 环境下调 `window.__TAURI__.app.setTheme(resolved)`（Windows 标题栏染色；macOS 无害）
- Tauri 环境检测：`window.__TAURI__` 存在时给 `<html>` 加 `tauri` class（供 CSS 红绿灯安全区使用，见 §5.2）

---

## 4. 设置集成与持久化

### 4.1 后端（白名单扩展）

- `config-store.js` 初始 settings 补 `theme: 'system'`（存量 data.json 无此键时读取侧按缺省处理，不做迁移）
- `api.js` 的 `PATCH /api/config`：加 `theme` 校验（仅接受 `'system'|'light'|'dark'`，否则 400 `INVALID_VALUE`）与合并分支

### 4.2 设置弹窗

- 新增「主题」下拉：跟随系统 / 亮色 / 暗色（值 `system|light|dark`）
- 打开时回显 `state.config.settings.theme ?? 'system'`；保存后立即 `applyTheme` + PATCH 持久化 + 回写 localStorage 缓存
- 主题属于即时预览型偏好：保存即生效，不提供"取消后还原预览"的复杂逻辑（取消 = 不保存不改）

### 4.3 防闪烁引导

`index.html` `<head>` 内联 ~10 行脚本：读 localStorage `mockserver.theme` 缓存，在首帧前设置 `data-theme`（无缓存则按系统偏好）。app.js 配置加载完成后以服务端值为准调和并回写缓存。浏览器模式同样生效。

---

## 5. 标题栏一体化（壳）

### 5.1 macOS Overlay 融合栏

`tauri.conf.json` 窗口配置改三处：

```json
{
  "label": "main",
  "title": "",
  "titleBarStyle": "Overlay",
  "hiddenTitle": true
}
```

效果：标题文字消失，红绿灯悬浮在内容区上，窗口顶端就是 App 顶栏——栏色即主题色，**壳侧零联动代码**。

### 5.2 顶栏适配（前端 CSS/布局）

- `html.tauri .topbar` 左移 78px 让出红绿灯安全区（浏览器模式无 `tauri` class，不受影响）
- 顶栏的 logo 区与中部空白加 `data-tauri-drag-region` 成为拖拽区；**右侧按钮组不放拖拽属性**（Tauri 2 的 drag region 通过 `closest('[data-tauri-drag-region]')` 捕获子元素 mousedown，按钮区必须排除在外，否则按钮变成拖拽触发器）

### 5.3 Windows 标题栏

- 保留原生标题栏；主题切换时前端调 `window.__TAURI__.app.setTheme(resolved)` 染深/浅色
- `src-tauri/capabilities/default.json` 加 `core:app:allow-set-theme` 权限

### 5.4 启动底色

**不设 `backgroundColor`，不加 Rust command**：启动瞬间窗口底色跟随系统外观，loading 页用 `prefers-color-scheme` 适配（§6），全链路零联动代码。

---

## 6. 壳内嵌页面适配

- `src-tauri/ui/loading.html`：内联样式加 `@media (prefers-color-scheme: light)` 浅色系
- `src-tauri/src/sidecar.rs` 的 `overlay_js` 覆盖层：内嵌 HTML 同样加亮色 media query 分支

**偏差声明**：这两个页面读不到应用设置（不同 origin / 无 IPC 上下文），统一跟随系统。用户手动锁定固定主题而系统相反时，启动 loading 与崩溃覆盖层仍跟随系统——可接受（默认设置即跟随系统，且两页转瞬即逝）。

---

## 7. 测试策略

**vitest 单测**（新增 `test/unit/theme.test.js`）：

- `resolveTheme` 纯函数：三态 × prefersDark 布尔矩阵全组合

**vitest 集成**（`test/integration/api-config.test.js` 加用例）：

- `PATCH /api/config` 接受合法 theme 值并持久化；非法值 400 `INVALID_VALUE`；新配置默认 `theme: 'system'`

**E2E（headed，新增 `test/e2e/theme.spec.js`）**：

- 设置面板切换三态 → `<html data-theme>` 断言
- `page.emulateMedia({ colorScheme })` 模拟系统切换 → system 模式下跟随
- localStorage 缓存断言 + 刷新后主题保持（服务端持久化）

**桌面手工验收**：

1. Overlay 栏形态：无标题文字、红绿灯悬浮、不遮挡顶栏按钮
2. 顶栏 logo 区/空白可拖拽移动窗口；右侧按钮正常点击不触发拖拽
3. 主题切换时窗口整体（含栏区）一致变色
4. 亮色主题下各页面（首页卡片、详情页、编辑器、设置弹窗、日志面板）无残存深色硬编码
5. Windows 标题栏染色（**本机无法验证，标注为首轮 CI/后续**）

**关键不变量提醒**：`public/` 改动（styles.css / index.html / app.js / 新增 theme.js）必须同步 `embed-assets/`（不变量 #5），否则 Bun 编译产物与 dev 不一致。

---

## 8. 取舍记录

| 方案 | 结论 |
|---|---|
| macOS Overlay 融合栏 | **采纳**：割裂感消除最彻底，壳侧零联动 |
| 保留原生栏 + JS→Rust 联动改背景色 | 否决：原生栏边界仍在，且壳要加 command 增复杂度 |
| 完全 frameless 自绘标题栏 | 否决：工作量与维护成本远超收益 |
| 主题存 localStorage | 否决：浏览器/桌面两处可能不一致；data.json 与现有设置同机制 |
| 多标签页主题实时同步 | 否决：YAGNI |
| 壳内嵌页读应用设置 | 否决：origin 不同读不到；跟随系统即可 |
