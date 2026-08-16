// Mock Tools — production UI
// Talks to /api/* and /events.

import {
  mountEditor,
  getValue,
  setValue,
  getEditorView,
  getActiveEditorView,
  setEditorTheme,
} from "./editor.js";
import { applyTheme, onThemeChange } from "./theme.js";
import { startRouter, navigate } from "./router.js";
import { renderPortCards, initNewPortDialog } from "./views/port-cards.js";
import { renderPortHeader, initPortDetail } from "./views/port-detail.js";
import {
  renderServiceCards,
  initNewServiceDialog,
  serviceAddress,
} from "./views/ws-services.js";
import { initImportWsdlDialog } from "./views/ws-import.js";
import { initServiceDetail, renderServiceDetail } from "./views/ws-detail.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ============================================================
// API client
// ============================================================
const api = {
  async getConfig() {
    return (await fetch("/api/config")).json();
  },
  async patchConfig(settings) {
    return (
      await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings }),
      })
    ).json();
  },
  async listEndpoints() {
    return (await fetch("/api/endpoints")).json();
  },
  async createEndpoint(body) {
    return (
      await fetch("/api/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  },
  async updateEndpoint(id, body) {
    return (
      await fetch(`/api/endpoints/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  },
  async deleteEndpoint(id) {
    return await fetch(`/api/endpoints/${id}`, { method: "DELETE" });
  },
  async reorderEndpoints(ids) {
    const r = await fetch("/api/endpoints/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) {
      const json = await r.json().catch(() => ({}));
      throw new Error(json.error || "排序失败");
    }
    return r.json();
  },
  async listPorts() {
    return (await fetch("/api/ports")).json();
  },
  async createPort(port, type = "http") {
    const r = await fetch("/api/ports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port, type }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || "创建端口失败");
    return body;
  },
  async updatePort(port, body) {
    const r = await fetch(`/api/ports/${port}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "更新端口失败");
    return json;
  },
  async deletePort(port) {
    const r = await fetch(`/api/ports/${port}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error("删除端口失败");
  },
  async runtimeStart() {
    return (await fetch("/api/runtime/start", { method: "POST" })).json();
  },
  async runtimeStop() {
    return (await fetch("/api/runtime/stop", { method: "POST" })).json();
  },
  async runtimeStatus() {
    return (await fetch("/api/runtime/status")).json();
  },
  async recentLogs(limit = 500) {
    return (await fetch(`/api/logs?limit=${limit}`)).json();
  },
  async clearLogs() {
    await fetch("/api/logs", { method: "DELETE" });
  },
  async getGenerators() {
    return (await fetch("/api/generators")).json();
  },
  async getGeneratorSample(id, args) {
    return (
      await fetch("/api/generators/sample", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, args }),
      })
    ).json();
  },
  async preview(text, format) {
    return (
      await fetch("/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(format ? { text, format } : { text }),
      })
    ).json();
  },
  async createService(body) {
    const r = await fetch("/api/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "创建服务失败");
    return json;
  },
  async updateService(id, body) {
    const r = await fetch(`/api/services/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "更新服务失败");
    return json;
  },
  async deleteService(id) {
    const r = await fetch(`/api/services/${id}`, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error("删除服务失败");
  },
  async importServiceWsdl(id, wsdl) {
    const r = await fetch(`/api/services/${id}/wsdl`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wsdl }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "导入 WSDL 失败");
    return json;
  },
  async parseWsdl(wsdl) {
    const r = await fetch("/api/wsdl/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wsdl }),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "WSDL 解析失败");
    return json;
  },
  async createOperation(serviceId, body) {
    const r = await fetch(`/api/services/${serviceId}/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "新建操作失败");
    return json;
  },
  async updateOperation(serviceId, opId, body) {
    const r = await fetch(`/api/services/${serviceId}/operations/${opId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "保存操作失败");
    return json;
  },
  async deleteOperation(serviceId, opId) {
    const r = await fetch(`/api/services/${serviceId}/operations/${opId}`, {
      method: "DELETE",
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || "删除操作失败");
    return json;
  },
};

// ============================================================
// State
// ============================================================
const state = {
  config: null,
  ports: [],
  endpoints: [],
  services: [],
  selectedId: null,
  selectedOperationId: null,
  draggingId: null,
  dirty: false,
  runtime: "stopped",
  runtimeStatus: {}, // port -> { state, reason? }
  logs: [],
  autoScroll: true,
  route: { view: "home" },
};

// ============================================================
// DOM refs
// ============================================================
const els = {
  startStopBtn: $("#startStopBtn"),
  globalStatus: $("#globalStatus"),
  statusDetail: $("#statusDetail"),
  newEndpointBtn: $("#newEndpointBtn"),
  emptyNewBtn: $("#emptyNewBtn"),
  endpointList: $("#endpointList"),
  endpointCount: $("#endpointCount"),
  portSummaryList: $("#portSummaryList"),
  editor: $("#editor"),
  editorEmpty: $("#editorEmpty"),
  editorForm: $("#editorForm"),
  endpointId: $("#endpointId"),
  lastSaved: $("#lastSaved"),
  method: $("#method"),
  port: $("#port"),
  path: $("#path"),
  status: $("#status"),
  responseEditor: { value: "" }, // legacy ref; replaced by CodeMirror getters
  validationStatus: $("#validationStatus"),
  formatBtn: $("#formatBtn"),
  validateBtn: $("#validateBtn"),
  saveBtn: $("#saveBtn"),
  deleteBtn: $("#deleteBtn"),
  lineCount: $("#lineCount"),
  charCount: $("#charCount"),
  logsBody: $("#logsBody"),
  logsCount: $("#logsCount"),
  logsStatus: $("#logsStatus"),
  autoScrollToggle: $("#autoScrollToggle"),
  clearLogsBtn: $("#clearLogsBtn"),
  settingsBtn: $("#settingsBtn"),
  settingsModal: $("#settingsModal"),
  settingsBackdrop: $("#settingsBackdrop"),
  settingsClose: $("#settingsClose"),
  settingsCancel: $("#settingsCancel"),
  settingsSave: $("#settingsSave"),
  storagePath: $("#storagePath"),
  uiPort: $("#uiPort"),
  maxBody: $("#settingsMaxBody"),
  maxBodyHint: $("#settingsMaxBodyHint"),
  theme: $("#settingsTheme"),

  // Log detail dialog
  logDetail: $("#log-detail"),
  logDetailMethod: $("#logDetailMethod"),
  logDetailPath: $("#logDetailPath"),
  logDetailStatus: $("#logDetailStatus"),
  logDetailClose: $("#logDetailClose"),
  logDetailMeta: $("#logDetailMeta"),
  logDetailQueryCount: $("#logDetailQueryCount"),
  logDetailQueryTable: $("#logDetailQueryTable"),
  logDetailQueryEmpty: $("#logDetailQueryEmpty"),
  logDetailHeadersCount: $("#logDetailHeadersCount"),
  logDetailHeadersTable: $("#logDetailHeadersTable"),
  logDetailHeadersEmpty: $("#logDetailHeadersEmpty"),
  logDetailBodyWarning: $("#logDetailBodyWarning"),
  logDetailBody: $("#logDetailBody"),
  logDetailBodyPlain: $("#logDetailBodyPlain"),
  logDetailEmpty: $("#logDetailEmpty"),

  // 视图与路由
  viewHome: $("#viewHome"),
  portCardGrid: $("#portCardGrid"),
  portCardCount: $("#portCardCount"),
  portHeader: $("#portHeader"),
  backToHomeBtn: $("#backToHomeBtn"),
  portHeaderNumber: $("#portHeaderNumber"),
  portStatusLed: $("#portStatusLed"),
  portNotFound: $("#portNotFound"),
  portNotFoundBack: $("#portNotFoundBack"),
  sidebarPanel: $("#sidebarPanel"),
  logsPanel: $("#logsPanel"),

  // 新建端口弹窗
  newPortModal: $("#newPortModal"),
  newPortBackdrop: $("#newPortBackdrop"),
  newPortClose: $("#newPortClose"),
  newPortCancel: $("#newPortCancel"),
  newPortCreate: $("#newPortCreate"),
  newPortNumber: $("#newPortNumber"),
  newPortError: $("#newPortError"),

  // 详情页端口操作
  portEnabledToggle: $("#portEnabledToggle"),
  portNumberInput: $("#portNumberInput"),
  portRenameBtn: $("#portRenameBtn"),
  deletePortBtn: $("#deletePortBtn"),
  endpointName: $("#endpointName"),

  // WS 视图
  viewWsPort: $("#viewWsPort"),
  serviceCardGrid: $("#serviceCardGrid"),
  serviceCardCount: $("#serviceCardCount"),
  serviceHeader: $("#serviceHeader"),
  backToPortBtn: $("#backToPortBtn"),
  serviceHeaderName: $("#serviceHeaderName"),
  serviceHeaderPath: $("#serviceHeaderPath"),
  serviceEnabledToggle: $("#serviceEnabledToggle"),
  importWsdlBtn: $("#importWsdlBtn"),
  copyServiceAddrBtn: $("#copyServiceAddrBtn"),
  deleteServiceBtn: $("#deleteServiceBtn"),
  wsSidebarPanel: $("#wsSidebarPanel"),
  operationCount: $("#operationCount"),
  operationList: $("#operationList"),
  newOperationBtn: $("#newOperationBtn"),
  wsEditor: $("#wsEditor"),
  wsEditorEmpty: $("#wsEditorEmpty"),
  wsEditorForm: $("#wsEditorForm"),
  wsEmptyNewBtn: $("#wsEmptyNewBtn"),

  // WS 服务详情编辑区
  xmlEditorHost: $("#xmlEditorHost"),
  wsOperationId: $("#wsOperationId"),
  wsOpName: $("#wsOpName"),
  wsOpSoapAction: $("#wsOpSoapAction"),
  wsOpStatus: $("#wsOpStatus"),
  wsResponseType: $("#wsResponseType"),
  wsValidationStatus: $("#wsValidationStatus"),
  wsFormatBtn: $("#wsFormatBtn"),
  wsValidateBtn: $("#wsValidateBtn"),
  wsDynamicBtn: $("#wsDynamicBtn"),
  wsLineCount: $("#wsLineCount"),
  wsCharCount: $("#wsCharCount"),
  wsPreviewMeta: $("#wsPreviewMeta"),
  wsPreviewMetaLabel: $("#wsPreviewMetaLabel"),
  wsPreviewExprStat: $("#wsPreviewExprStat"),
  wsPreviewErrStat: $("#wsPreviewErrStat"),
  wsPreviewRefreshBtn: $("#wsPreviewRefreshBtn"),
  wsPreviewBanner: $("#wsPreviewBanner"),
  wsPreviewPane: $("#wsPreviewPane"),
  wsLastSaved: $("#wsLastSaved"),
  wsDeleteOpBtn: $("#wsDeleteOpBtn"),
  wsRevertBtn: $("#wsRevertBtn"),
  wsSaveOpBtn: $("#wsSaveOpBtn"),

  // 新建服务弹窗
  newServiceModal: $("#newServiceModal"),
  newServiceBackdrop: $("#newServiceBackdrop"),
  newServiceClose: $("#newServiceClose"),
  newServiceCancel: $("#newServiceCancel"),
  newServiceCreate: $("#newServiceCreate"),
  newServiceName: $("#newServiceName"),
  newServicePath: $("#newServicePath"),
  newServiceError: $("#newServiceError"),

  // 导入 WSDL 弹窗
  importWsdlModal: $("#importWsdlModal"),
  importWsdlBackdrop: $("#importWsdlBackdrop"),
  importWsdlClose: $("#importWsdlClose"),
  importWsdlCancel: $("#importWsdlCancel"),
  importWsdlParseBtn: $("#importWsdlParseBtn"),
  importWsdlConfirm: $("#importWsdlConfirm"),
  importWsdlText: $("#importWsdlText"),
  importWsdlFile: $("#importWsdlFile"),
  importWsdlError: $("#importWsdlError"),
  importWsdlSummary: $("#importWsdlSummary"),
  importWsdlPreview: $("#importWsdlPreview"),
};

let logDetailCM = null;

// ============================================================
// Render
// ============================================================
function render() {
  renderEndpointList();
  renderEditor();
  renderStatus();
}

function renderEndpointList() {
  // 拖拽期间不重建列表：5s 轮询会整体重渲染 DOM，抽走拖动中的元素（spec 2026-08-17 §4.3）
  if (state.draggingId) return;
  els.endpointCount.textContent = state.endpoints.length;
  const ports = [...new Set(state.endpoints.map((e) => e.port))].sort(
    (a, b) => a - b,
  );
  els.portSummaryList.textContent = ports.length
    ? ports.map((p) => `:${p}`).join("  ")
    : "—";

  els.endpointList.innerHTML = "";
  for (const ep of state.endpoints) {
    const li = document.createElement("li");
    li.className =
      "endpoint-item" + (ep.id === state.selectedId ? " selected" : "");
    li.dataset.id = ep.id;
    li.setAttribute("role", "option");
    li.setAttribute(
      "aria-selected",
      ep.id === state.selectedId ? "true" : "false",
    );

    // Per-port status indicator: failed > running > stopped
    const portStatus = state.runtimeStatus[String(ep.port)];
    let ledState = "stopped";
    let ledTitle = "";
    if (portStatus?.state === "failed") {
      ledState = "failed";
      ledTitle = `端口 ${ep.port} 启动失败：${portStatus.reason || "未知原因"}`;
    } else if (portStatus?.state === "running") {
      ledState = "running";
      ledTitle = `端口 ${ep.port} 运行中`;
    } else {
      ledTitle = `端口 ${ep.port} 未启动`;
    }

    li.innerHTML = `
      <div class="endpoint-name-row">
        <span class="endpoint-name"></span>
        <span class="endpoint-status">
          <span class="led led-mini" data-state="${ledState}" title="${ledTitle}"></span>
        </span>
        <button class="endpoint-copy" type="button" aria-label="复制接口" title="复制接口">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2"></rect>
            <path d="M5 15V5a2 2 0 0 1 2-2h10"></path>
          </svg>
        </button>
        <button class="endpoint-delete" type="button" aria-label="删除" title="删除">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div class="endpoint-meta">
        <span class="endpoint-method" data-method="${ep.method}">${ep.method}</span>
        <span class="endpoint-port">${ep.port}</span>
        <span class="endpoint-path"></span>
        <span class="endpoint-status-code">${ep.statusCode || 200}</span>
      </div>
    `;
    li.querySelector(".endpoint-name").textContent =
      ep.name || `${ep.method} ${ep.path}`;
    li.querySelector(".endpoint-path").textContent = ep.path;
    li.addEventListener("click", (e) => {
      // Ignore clicks on the action buttons (delete / copy)
      if (e.target.closest(".endpoint-delete, .endpoint-copy")) return;
      selectEndpoint(ep.id);
    });
    li.querySelector(".endpoint-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEndpointById(ep.id);
    });
    li.querySelector(".endpoint-copy").addEventListener("click", (e) => {
      e.stopPropagation();
      copyEndpointById(ep.id);
    });

    // ---- 拖拽排序（原生 HTML5 DnD，spec 2026-08-17 §4.2） ----
    li.draggable = true;
    li.addEventListener("dragstart", (e) => {
      state.draggingId = ep.id;
      e.dataTransfer.setData("text/plain", ep.id);
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => li.classList.add("dragging"));
    });
    li.addEventListener("dragover", (e) => {
      if (!state.draggingId || state.draggingId === ep.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      li.classList.toggle("drop-above", before);
      li.classList.toggle("drop-below", !before);
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-above", "drop-below");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromId = state.draggingId;
      state.draggingId = null;
      if (!fromId || fromId === ep.id) {
        renderEndpointList();
        return;
      }
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const ids = state.endpoints.map((x) => x.id).filter((x) => x !== fromId);
      ids.splice(ids.indexOf(ep.id) + (before ? 0 : 1), 0, fromId);
      const unchanged = ids.every((x, i) => x === state.endpoints[i].id);
      if (unchanged) {
        renderEndpointList();
        return;
      }
      const byId = new Map(state.endpoints.map((x) => [x.id, x]));
      state.endpoints = ids.map((x) => byId.get(x));
      renderEndpointList();
      api.reorderEndpoints(ids).catch(async (err) => {
        alert("排序失败：" + (err?.message || "未知错误"));
        state.endpoints = await api.listEndpoints();
        renderEndpointList();
      });
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      if (state.draggingId) {
        state.draggingId = null;
        renderEndpointList();
      }
    });
    els.endpointList.appendChild(li);
  }
}

async function deleteEndpointById(id) {
  const ep = state.endpoints.find((e) => e.id === id);
  if (!ep) return;
  if (!confirm(`确认删除 ${ep.method} ${ep.path}？`)) return;
  try {
    await api.deleteEndpoint(id);
  } catch (e) {
    alert("删除失败：" + (e?.message || "未知错误"));
    return;
  }
  const wasSelected = state.selectedId === id;
  state.endpoints = state.endpoints.filter((e) => e.id !== id);
  if (wasSelected) {
    state.selectedId = state.endpoints[0]?.id || null;
    state.dirty = false;
  }
  renderEndpointList();
  renderEditor();
  renderStatus();
}

// 复制避撞：与 checkUniqueness 同谓词——只看 enabled !== false 的端点
function nextCopyPath(source) {
  const taken = (candidate) =>
    state.endpoints.some(
      (e) =>
        e.enabled !== false &&
        e.port === source.port &&
        e.method === source.method &&
        e.path === candidate,
    );
  let candidate = `${source.path}-copy`;
  let n = 2;
  while (taken(candidate)) candidate = `${source.path}-copy-${n++}`;
  return candidate;
}

async function copyEndpointById(id) {
  const source = state.endpoints.find((e) => e.id === id);
  if (!source) return;
  try {
    const ep = await api.createEndpoint({
      method: source.method,
      port: source.port,
      path: nextCopyPath(source),
      statusCode: source.statusCode,
      response: structuredClone(source.response ?? null),
      name: source.name ? `${source.name} (副本)` : "",
      enabled: true,
    });
    // api.createEndpoint 不对非 2xx 抛错，这里自行校验（服务端 400 DUPLICATE_ENDPOINT 等）
    if (!ep?.id) throw new Error(ep?.error || "未知错误");
    const idx = state.endpoints.findIndex((e) => e.id === id);
    state.endpoints.splice(idx + 1, 0, ep);
    state.selectedId = ep.id;
    renderEndpointList();
    renderEditorForCreate(ep);
  } catch (e) {
    alert("复制失败：" + (e?.message || "未知错误"));
  }
}

function renderEditor() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) {
    els.editorEmpty.hidden = false;
    els.editorForm.hidden = true;
    return;
  }
  els.editorEmpty.hidden = true;
  els.editorForm.hidden = false;
  els.endpointId.textContent = `id: ${ep.id.slice(0, 8)}…`;
  if (!state.dirty) {
    els.method.value = ep.method;
    els.endpointName.value = ep.name || "";
    els.port.value = ep.port;
    els.path.value = ep.path;
    els.status.value = ep.statusCode || 200;
    els.responseEditor.value = formatJSON(ep.response);
    if (window.__editorMounted) setValue(formatJSON(ep.response));
    els.lastSaved.textContent = "saved";
    els.lastSaved.style.color = "";
  }
  updateEditorMeta();
  validateJSON();
}

function renderStatus() {
  const btn = els.startStopBtn;
  const pill = els.globalStatus;
  pill.dataset.state = state.runtime;
  btn.dataset.state = state.runtime;
  pill.querySelector(".led").dataset.state = state.runtime;
  const map = {
    stopped: { text: "已停止", label: "启动", detail: "所有端口空闲" },
    starting: { text: "启动中", label: "启动中…", detail: "正在绑定端口" },
    running: {
      text: "运行中",
      label: "停止",
      detail: `${new Set(state.endpoints.map((e) => e.port)).size} 个端口已上线`,
    },
    failed: { text: "启动失败", label: "重试", detail: "见接口列表" },
  };
  const m = map[state.runtime];
  pill.querySelector(".status-text").textContent = m.text;
  btn.querySelector(".btn-label").textContent = m.label;
  els.statusDetail.textContent = m.detail;
}

// ============================================================
// 路由与视图切换
// ============================================================
let suppressHash = false;
let newPortDialog = null;
let newServiceDialog = null;
let importWsdlDialog = null;

function renderHome() {
  renderPortCards(state, {
    grid: els.portCardGrid,
    countEl: els.portCardCount,
    api,
    onNewPort: () => newPortDialog.open(),
  });
}

function currentPortEntity(route) {
  return state.ports.find((p) => p.port === route.port) || null;
}

function effectiveView(route) {
  if (route.view === "home") return "home";
  const portEntity = currentPortEntity(route);
  if (!portEntity) return "not-found";
  if (route.view === "service") {
    const svc = (state.services || []).find(
      (s) => s.id === route.serviceId && s.port === route.port,
    );
    return svc ? "service" : "not-found";
  }
  return portEntity.type === "ws" ? "ws-port" : "port";
}

async function applyRoute(route) {
  if (
    state.dirty &&
    (state.route.view === "port" || state.route.view === "service") &&
    !confirm("有未保存的修改，是否放弃？")
  ) {
    suppressHash = true;
    location.hash =
      state.route.view === "service"
        ? `#/port/${state.route.port}/svc/${state.route.serviceId}`
        : `#/port/${state.route.port}`;
    return;
  }
  state.route = route;
  state.dirty = false;

  if (route.view !== "home" && !currentPortEntity(route)) {
    // 端口可能刚被创建（API 直接建 / 另一标签页），拉一次最新数据再判断
    try {
      state.ports = await api.listPorts();
      state.endpoints = await api.listEndpoints();
      state.config = await api.getConfig();
      state.services = state.config.services || [];
    } catch {}
  }

  const ev = effectiveView(route);
  // route.view 是解析层视图（port），分流后回写有效视图（port/ws-port/service/not-found），
  // refreshAll / boot 等处的 "ws-port" 分流判断依赖它
  state.route = { ...route, view: ev };
  document.body.dataset.view = ev === "not-found" ? "port" : ev;
  els.viewHome.hidden = ev !== "home";
  els.viewWsPort.hidden = ev !== "ws-port";
  els.portHeader.hidden = !(ev === "port" || ev === "ws-port");
  els.serviceHeader.hidden = ev !== "service";
  els.portNotFound.hidden = ev !== "not-found";
  els.sidebarPanel.hidden = ev !== "port";
  els.wsSidebarPanel.hidden = ev !== "service";
  els.editor.hidden = ev !== "port";
  els.wsEditor.hidden = ev !== "service";
  els.logsPanel.hidden = ev === "home";

  if (ev === "home") renderHome();
  if (ev === "port" || ev === "ws-port") renderPortHeader(state, els);
  if (ev === "port") {
    // CodeMirror 在 hidden 容器里挂载过，显示后需要重新测量
    getEditorView()?.requestMeasure();
    renderEndpointList();
    renderEditor();
    renderLogsInitial();
  }
  if (ev === "ws-port") {
    renderWsPortPage();
    renderLogsInitial();
  }
  if (ev === "service") {
    renderServicePage();
    renderLogsInitial();
  }
}

function renderWsPortPage() {
  renderServiceCards(state, {
    grid: els.serviceCardGrid,
    countEl: els.serviceCardCount,
    api,
    onNewService: () => newServiceDialog.open(),
    onImport: (svc) => importWsdlDialog.open(svc),
    onChanged: refreshAll,
  });
}

// service 视图的渲染由 ws-detail.js 提供
function renderServicePage() {
  renderServiceDetail();
}

function renderLogEntry(entry) {
  const row = document.createElement("div");
  row.className = `log-entry ${entry.matched ? "matched" : "missed"}`;
  const range = `${Math.floor(entry.status / 100)}xx`;
  const time = new Date(entry.timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
  });
  const ip = (entry.ip || "").replace(/^::ffff:/, ""); // strip IPv6-mapped prefix
  row.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-method" style="color: var(--method-${entry.method.toLowerCase()})">${entry.method}</span>
    <span class="log-path"></span>
    <span class="log-port">${entry.port}</span>
    <span class="log-status" data-range="${range}">${entry.status}</span>
    <span class="log-duration">${entry.durationMs}</span>
    <span class="log-ip mono">${ip || "—"}</span>
    <span class="log-result"></span>
  `;
  row.querySelector(".log-path").textContent = entry.path;
  // operationName 来自请求数据，只能 textContent 赋值（不进 innerHTML）
  row.querySelector(".log-result").textContent = entry.matched
    ? entry.operationName
      ? `✓ ${entry.operationName}`
      : "匹配"
    : entry.serviceId
      ? `✗ Fault${entry.operationName ? ` · ${entry.operationName}` : ""}`
      : "无路由";
  // 只有 HTTP 请求条目可点（过滤 resolver-warn）
  if (entry.method) {
    row.addEventListener("click", () => openLogDetail(entry.id));
  }
  return row;
}

function openLogDetail(id) {
  const entry = state.logs.find((e) => e.id === id);
  if (!entry || !entry.method) return;
  renderLogDetail(entry);
  els.logDetail.showModal();
}

function closeLogDetail() {
  if (els.logDetail.open) els.logDetail.close();
}

function renderLogDetail(entry) {
  // 1. Header
  els.logDetailMethod.textContent = entry.method;
  els.logDetailMethod.dataset.method = entry.method;
  els.logDetailPath.textContent = entry.path;
  els.logDetailStatus.textContent = entry.status;
  els.logDetailStatus.dataset.range = `${Math.floor(entry.status / 100)}xx`;

  // 2. Meta
  const time = new Date(entry.timestamp).toLocaleString("zh-CN", {
    hour12: false,
  });
  els.logDetailMeta.innerHTML = "";
  const rows = [
    ["时间", time],
    ["端口", String(entry.port)],
    ["耗时", `${entry.durationMs} ms`],
    ["IP", entry.ip ? entry.ip.replace(/^::ffff:/, "") : "—"],
    ["路由", entry.matched ? "匹配" : "无路由"],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    els.logDetailMeta.append(dt, dd);
  }

  // 3. Query
  const queryTbody = els.logDetailQueryTable.querySelector("tbody");
  queryTbody.innerHTML = "";
  const params = new URLSearchParams(entry.query || "");
  const paramKeys = [...params.keys()];
  if (paramKeys.length === 0) {
    els.logDetailQueryTable.hidden = true;
    els.logDetailQueryEmpty.hidden = false;
    els.logDetailQueryCount.textContent = "0";
  } else {
    els.logDetailQueryTable.hidden = false;
    els.logDetailQueryEmpty.hidden = true;
    els.logDetailQueryCount.textContent = String(paramKeys.length);
    for (const [k, v] of params) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = k;
      const td2 = document.createElement("td");
      td2.textContent = v;
      tr.append(td1, td2);
      queryTbody.append(tr);
    }
  }

  // 4. Headers
  const headerTbody = els.logDetailHeadersTable.querySelector("tbody");
  headerTbody.innerHTML = "";
  const headerEntries = Object.entries(entry.requestHeaders || {});
  if (headerEntries.length === 0) {
    els.logDetailHeadersTable.hidden = true;
    els.logDetailHeadersEmpty.hidden = false;
    els.logDetailHeadersCount.textContent = "0";
  } else {
    els.logDetailHeadersTable.hidden = false;
    els.logDetailHeadersEmpty.hidden = true;
    els.logDetailHeadersCount.textContent = String(headerEntries.length);
    for (const [k, v] of headerEntries) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = k;
      const td2 = document.createElement("td");
      td2.textContent = Array.isArray(v) ? v.join(", ") : String(v);
      tr.append(td1, td2);
      headerTbody.append(tr);
    }
  }

  // 5. Body
  if (logDetailCM) {
    logDetailCM.destroy();
    logDetailCM = null;
  }
  els.logDetailBody.innerHTML = "";

  const body = entry.requestBodyPreview || "";
  if (!body) {
    els.logDetailEmpty.hidden = false;
    els.logDetailBodyWarning.hidden = true;
    els.logDetailBody.hidden = true;
    els.logDetailBodyPlain.hidden = true;
  } else {
    els.logDetailEmpty.hidden = true;
    els.logDetailBodyWarning.hidden = !entry.requestBodyTruncated;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {}
    if (parsed !== undefined) {
      const formatted = JSON.stringify(parsed, null, 2);
      els.logDetailBody.hidden = false;
      els.logDetailBodyPlain.hidden = true;
      logDetailCM = window.mountReadonlyEditor(els.logDetailBody, formatted);
    } else {
      els.logDetailBody.hidden = true;
      els.logDetailBodyPlain.hidden = false;
      els.logDetailBodyPlain.textContent = body;
    }
  }
}

function visibleLogs() {
  if (state.route.view !== "home") {
    return state.logs.filter((e) => e.port === state.route.port);
  }
  return state.logs;
}

function updateLogsCount() {
  const vis = visibleLogs();
  els.logsCount.textContent =
    state.route.view !== "home"
      ? `${vis.length} 条 / 共 ${state.logs.length} 条`
      : `${state.logs.length} 条 · 最多 500`;
}

function renderLogsInitial() {
  els.logsBody.innerHTML = "";
  const vis = visibleLogs();
  if (vis.length === 0) {
    const empty = document.createElement("div");
    empty.className = "logs-empty";
    empty.innerHTML = `<span class="logs-empty-mark">//</span><span>暂无请求。</span>`;
    els.logsBody.appendChild(empty);
  } else {
    // 倒序渲染：最新请求显示在列表顶部
    for (let i = vis.length - 1; i >= 0; i--)
      els.logsBody.appendChild(renderLogEntry(vis[i]));
  }
  updateLogsCount();
  if (state.autoScroll) els.logsBody.scrollTop = 0;
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
  const isPortView = state.route.view !== "home";
  const matches = !isPortView || entry.port === state.route.port;
  if (matches) {
    // Remove the empty-state placeholder if it's still there so the new entry
    // appears at the top of the log list rather than below a 200px-tall gap.
    const empty = els.logsBody.querySelector(".logs-empty");
    if (empty) empty.remove();
    els.logsBody.prepend(renderLogEntry(entry));
    if (state.autoScroll) els.logsBody.scrollTop = 0;
  }
  updateLogsCount();
  if (state.route.view === "home") renderHome();
}

// ============================================================
// Actions
// ============================================================
async function refreshAll() {
  state.ports = await api.listPorts();
  state.endpoints = await api.listEndpoints();
  state.config = await api.getConfig();
  state.services = state.config.services || [];
  if (!state.endpoints.some((e) => e.id === state.selectedId)) {
    state.selectedId = state.endpoints[0]?.id || null;
    state.dirty = false;
  }
  render();
  if (state.route.view === "port" || state.route.view === "ws-port") {
    renderPortHeader(state, els);
  }
  if (state.route.view === "ws-port") renderWsPortPage();
  if (state.route.view === "service") renderServicePage();
}

async function loadAll() {
  state.config = await api.getConfig();
  onThemeChange((resolved) => setEditorTheme(resolved));
  applyTheme(state.config.settings.theme ?? "system");
  state.ports = await api.listPorts();
  state.endpoints = await api.listEndpoints();
  state.services = state.config.services || [];
  state.selectedId = state.endpoints[0]?.id || null;
  state.logs = await api.recentLogs(500);
  // Also fetch runtime status so the global toggle reflects the real state
  // after a page refresh (the mock servers may still be bound to their ports).
  try {
    state.runtimeStatus = await api.runtimeStatus();
    deriveGlobalRuntime();
  } catch {}
  renderLogsInitial();
  render();
}

// Derive the global state.runtime (button label) from per-port statuses.
// Priority: any failed → "failed"; any running → "running"; else → "stopped".
function deriveGlobalRuntime() {
  const ports = Object.values(state.runtimeStatus);
  if (ports.some((p) => p.state === "failed")) state.runtime = "failed";
  else if (ports.some((p) => p.state === "running")) state.runtime = "running";
  else state.runtime = "stopped";
}

function selectEndpoint(id) {
  if (state.dirty && !confirm("有未保存的修改，是否放弃？")) return;
  state.selectedId = id;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
}

function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  els.lastSaved.textContent = "未保存";
  els.lastSaved.style.color = "var(--amber)";
}

async function createEndpoint() {
  if (state.route.view !== "port") return;
  const ep = await api.createEndpoint({
    method: "GET",
    port: state.route.port,
    path: "/api/new",
    statusCode: 200,
    response: { code: 200, msg: "操作成功", data: null, success: true },
    enabled: true,
  });
  state.endpoints.push(ep);
  state.selectedId = ep.id;
  // Force the form to fully reset, ignoring the !state.dirty guard.
  renderEndpointList();
  renderEditorForCreate(ep);
}

function renderEditorForCreate(ep) {
  els.editorEmpty.hidden = true;
  els.editorForm.hidden = false;
  els.endpointId.textContent = `id: ${ep.id.slice(0, 8)}…`;
  // Always write new values, regardless of dirty state
  els.method.value = ep.method;
  els.endpointName.value = ep.name || "";
  els.port.value = ep.port;
  els.path.value = ep.path;
  els.status.value = ep.statusCode || 200;
  els.responseEditor.value = formatJSON(ep.response);
  if (window.__editorMounted) setValue(formatJSON(ep.response));
  els.lastSaved.textContent = "已保存";
  els.lastSaved.style.color = "";
  state.dirty = false;
  updateEditorMeta();
  validateJSON();
  // Focus the path field so the user can immediately type a new path
  els.path.focus();
  els.path.select();
}

async function saveEndpoint() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) return;
  const body = {
    method: els.method.value,
    port: Number(els.port.value),
    path: els.path.value.trim(),
    statusCode: Number(els.status.value) || 200,
    name: els.endpointName.value.trim(),
    response: (() => {
      const v = getValue();
      return v ? JSON.parse(v) : null;
    })(),
    enabled: ep.enabled !== false,
  };
  try {
    const updated = await api.updateEndpoint(ep.id, body);
    // 用服务端响应整体替换（服务端可能删除字段，如清空 name，Object.assign 不会删键）
    const idx = state.endpoints.findIndex((e) => e.id === updated.id);
    if (idx >= 0) state.endpoints[idx] = updated;
    state.dirty = false;
    renderEndpointList();
    flash("已保存", "green");
  } catch (e) {
    flash("✗ 保存失败", "red");
  }
}

async function deleteEndpoint() {
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  if (!ep) return;
  if (!confirm(`确认删除 ${ep.method} ${ep.path}？`)) return;
  await api.deleteEndpoint(ep.id);
  state.endpoints = state.endpoints.filter((e) => e.id !== ep.id);
  state.selectedId = state.endpoints[0]?.id || null;
  state.dirty = false;
  renderEndpointList();
  renderEditor();
  renderStatus();
}

async function toggleRuntime() {
  if (state.runtime === "running") {
    state.runtime = "stopped";
    renderStatus();
    await api.runtimeStop();
  } else {
    state.runtime = "starting";
    renderStatus();
    const result = await api.runtimeStart();
    state.runtime =
      result.failed && result.failed.length > 0 ? "failed" : "running";
    render();
  }
  await refreshRuntimeStatus();
  renderEndpointList();
}

async function refreshRuntimeStatus() {
  try {
    state.runtimeStatus = await api.runtimeStatus();
  } catch {}
  renderEndpointList();
  if (state.route.view === "home") renderHome();
}

// ============================================================
// JSON helpers
// ============================================================
function formatJSON(value) {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 1) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function tryFormat() {
  const text = getValue();
  if (!text.trim()) return;
  try {
    setValue(JSON.stringify(JSON.parse(text), null, 2));
    setValidation("valid", "已格式化");
    markDirty();
  } catch (e) {
    setValidation("invalid", e.message);
  }
}

function validateJSON() {
  const text = getValue().trim();
  if (!text) return setValidation("empty", "空");
  try {
    JSON.parse(text);
    setValidation("valid", "合法");
  } catch {
    setValidation("invalid", "JSON 不合法");
  }
}

function setValidation(state_, text) {
  els.validationStatus.dataset.state = state_;
  els.validationStatus.querySelector(".val-text").textContent = text;
  els.validationStatus.querySelector(".val-mark").textContent =
    state_ === "valid" ? "✓" : state_ === "invalid" ? "✗" : "·";
}

function updateEditorMeta() {
  const text = getValue();
  const lines = text === "" ? 0 : text.split("\n").length;
  els.lineCount.textContent = `${lines} 行`;
  els.charCount.textContent = `${text.length} 字符`;
}

function flash(text, color) {
  els.lastSaved.textContent = text;
  els.lastSaved.style.color = `var(--${color})`;
  setTimeout(() => {
    els.lastSaved.style.color = state.dirty ? "var(--amber)" : "";
    els.lastSaved.textContent = state.dirty ? "未保存" : "已保存";
  }, 1600);
}

// ============================================================
// SSE
// ============================================================
function connectSSE() {
  const es = new EventSource("/events");
  es.addEventListener("log", (e) => {
    const entry = JSON.parse(e.data);
    appendLog(entry);
  });
  return es;
}

// ============================================================
// Settings
// ============================================================
function openSettings() {
  els.storagePath.value = state.config.settings.storagePath;
  els.uiPort.value = state.config.settings.uiPort;
  els.theme.value = state.config.settings.theme ?? "system";
  els.maxBody.value = state.config.settings.maxBodyBytes ?? 4194304;
  els.maxBodyHint.textContent = formatBytes(Number(els.maxBody.value));
  els.settingsModal.hidden = false;
}
function closeSettings() {
  els.settingsModal.hidden = true;
}
async function saveSettings() {
  const newMax = Number(els.maxBody.value);
  if (!Number.isInteger(newMax) || newMax < 1) {
    flash("请求体大小上限必须是正整数", "red");
    return;
  }
  const newStoragePath = els.storagePath.value.trim();
  const newUiPort = Number(els.uiPort.value);
  const needsRestart =
    newStoragePath !== state.config.settings.storagePath ||
    newUiPort !== state.config.settings.uiPort;
  await api.patchConfig({
    storagePath: newStoragePath,
    uiPort: newUiPort,
    maxBodyBytes: newMax,
    theme: els.theme.value,
  });
  state.config = await api.getConfig();
  applyTheme(state.config.settings.theme ?? "system");
  closeSettings();
  flash(needsRestart ? "已保存 · 重启后生效" : "已保存 · 立即生效", "green");
}

// ============================================================
// Wire events
// ============================================================
els.startStopBtn.addEventListener("click", toggleRuntime);
els.backToHomeBtn.addEventListener("click", () => navigate("#/"));
els.portNotFoundBack.addEventListener("click", () => navigate("#/"));
els.newEndpointBtn.addEventListener("click", createEndpoint);
els.emptyNewBtn.addEventListener("click", createEndpoint);
els.saveBtn.addEventListener("click", saveEndpoint);
els.deleteBtn.addEventListener("click", deleteEndpoint);
els.formatBtn.addEventListener("click", tryFormat);
els.validateBtn.addEventListener("click", validateJSON);
els.clearLogsBtn.addEventListener("click", async () => {
  state.logs = [];
  renderLogsInitial();
  // Persist the clear to the server so it survives a page refresh
  try {
    await api.clearLogs();
  } catch {}
});
els.autoScrollToggle.addEventListener("change", (e) => {
  state.autoScroll = e.target.checked;
});
els.settingsBtn.addEventListener("click", openSettings);
els.settingsBackdrop.addEventListener("click", closeSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsCancel.addEventListener("click", closeSettings);
els.settingsSave.addEventListener("click", saveSettings);
els.maxBody.addEventListener("input", () => {
  els.maxBodyHint.textContent = formatBytes(Number(els.maxBody.value)) || "—";
});
els.logDetailClose.addEventListener("click", closeLogDetail);
els.logDetail.addEventListener("click", (e) => {
  // 点 backdrop（dialog 自身）关闭；点内部内容不关
  if (e.target === els.logDetail) closeLogDetail();
});
els.logDetail.addEventListener("close", () => {
  if (logDetailCM) {
    logDetailCM.destroy();
    logDetailCM = null;
  }
});

for (const f of [els.method, els.endpointName, els.path, els.status]) {
  f.addEventListener("input", markDirty);
}
// CodeMirror handles its own input; onChange is wired in boot.

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    if (!els.editorForm.hidden) saveEndpoint();
    else if (!els.wsEditorForm.hidden) els.wsSaveOpBtn.click();
  }
  if (e.key === "Escape" && !els.settingsModal.hidden) closeSettings();
});

// ============================================================
// Boot
// ============================================================
loadAll().then(() => {
  // Mount CodeMirror after the editor form is rendered.
  const ep = state.endpoints.find((e) => e.id === state.selectedId);
  mountEditor({
    initialValue: ep ? formatJSON(ep.response) : "",
    onChange: () => {
      markDirty();
      validateJSON();
      updateEditorMeta();
      schedulePreviewRefresh();
    },
    onSelectionChange: (state) => updateDynamicValueBtnState(state),
  });
  // onChange 在 initial mount 时不触发；手动跑一次预览刷新
  if (ep) setTimeout(refreshPreview, 100);
  window.__editorMounted = true;
  connectSSE();
  // Fetch initial runtime status so list LEDs reflect failed/running per port
  refreshRuntimeStatus();
  // Poll every 5s to catch external changes (e.g. someone else binds the port)
  setInterval(refreshRuntimeStatus, 5000);
  newPortDialog = initNewPortDialog({ els, state, api });
  initPortDetail({ els, state, api, refreshAll });
  newServiceDialog = initNewServiceDialog({
    els,
    state,
    api,
    onCreated: async () => {
      state.config = await api.getConfig();
      state.services = state.config.services || [];
    },
  });
  importWsdlDialog = initImportWsdlDialog({
    els,
    api,
    onImported: async () => {
      state.config = await api.getConfig();
      state.services = state.config.services || [];
      if (state.route.view === "ws-port") renderWsPortPage();
      if (state.route.view === "service") renderServicePage();
    },
  });
  initServiceDetail({
    els,
    state,
    api,
    refreshAll,
    importDialog: () => importWsdlDialog,
  });
  startRouter((route) => {
    if (suppressHash) {
      suppressHash = false;
      return;
    }
    applyRoute(route);
  });
});

// ============================================================
// Preview pane (right) + Dynamic-value toolbar button
// ============================================================
const previewPane = $("#previewPane");
const previewBanner = $("#previewBanner");
const previewMeta = $("#previewMeta");
const previewMetaLabel = $("#previewMetaLabel");
const previewExprStat = $("#previewExprStat");
const previewErrStat = $("#previewErrStat");
const previewRefreshBtn = $("#previewRefreshBtn");
const dynamicValueToolbarBtn = $("#dynamicValueToolbarBtn");
const editorWrap = $("#editorWrap");

let previewDebounceTimer = null;
let lastGoodPreview = null;

function schedulePreviewRefresh() {
  if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(refreshPreview, 300);
}

function setPreviewMeta(state, label, exprCount, errCount) {
  previewMeta.className = "meta " + state;
  previewMetaLabel.textContent = label;
  previewExprStat.innerHTML = `表达式 <strong>${exprCount}</strong>`;
  previewErrStat.innerHTML = `错误 <strong>${errCount}</strong>`;
  previewErrStat.style.display = errCount > 0 ? "" : "none";
}

async function refreshPreview() {
  const text = getValue();
  if (!text.trim()) {
    previewPane.textContent = "// 在左侧编辑响应体，此处显示解析结果";
    setPreviewMeta("", "就绪", 0, 0);
    previewBanner.hidden = true;
    return;
  }
  let res;
  try {
    res = await api.preview(text);
  } catch (e) {
    previewBanner.textContent = "预览暂不可用";
    previewBanner.className = "preview-banner";
    previewBanner.hidden = false;
    setPreviewMeta("has-errors", "离线", 0, 1);
    return;
  }
  if (!res.ok) {
    previewBanner.textContent = res.error || "JSON 解析失败";
    previewBanner.className = "preview-banner";
    previewBanner.hidden = false;
    if (lastGoodPreview !== null) renderPreview(lastGoodPreview, []);
    setPreviewMeta("has-errors", "JSON 语法错", 0, 1);
    return;
  }
  previewBanner.hidden = true;
  renderPreview(res.resolved, res.errors);
  lastGoodPreview = res.resolved;
  const state = res.errors.length > 0 ? "has-errors" : "is-resolved";
  const label = res.errors.length > 0 ? "部分解析" : "已解析";
  setPreviewMeta(state, label, res.exprCount, res.errors.length);
}

/**
 * 用 DOM 节点重建 JSON 输出 —— 实现类型语义着色：
 * - 数值 / boolean / null 用 v-num / v-bool / v-null span（signal-amber / red-dim）
 * - 字符串用 v-str
 * - 键名用 v-key（pencil 灰）
 * - 标点 { } [ ] , : 用 v-punct（faint 极淡）
 * - mixed-fail 的 {{...}} 残留用 expr-error span（红虚线）
 */
function renderPreview(value, errors) {
  previewPane.textContent = "";
  const errorPositions = new Set();
  for (const e of errors) {
    if (typeof e.from === "number" && typeof e.to === "number") {
      for (let i = e.from; i < e.to; i++) errorPositions.add(i);
    }
  }
  const json = JSON.stringify(value, null, 2);
  // mixed-fail 残留的 {{...}} 高亮（在字符串内部）
  const re = /\{\{[^}]*\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(json)) !== null) {
    if (m.index > last) appendJsonColored(json.slice(last, m.index));
    const span = document.createElement("span");
    span.className = "expr-error";
    span.textContent = m[0];
    previewPane.appendChild(span);
    last = m.index + m[0].length;
  }
  if (last < json.length) appendJsonColored(json.slice(last));

  if (errors.length > 0) {
    const errList = document.createElement("div");
    errList.className = "err-list";
    for (const e of errors) {
      const line = document.createElement("div");
      line.textContent = `⚠ ${e.message}${e.from !== undefined ? `  (col ${e.from}–${e.to})` : ""}`;
      errList.appendChild(line);
    }
    previewPane.appendChild(errList);
  }
  void errorPositions; // 保留供后续按位置染色用
}

/**
 * 把 JSON 文本片段按字符类型染色后插入 previewPane
 * - "  → 切字符串
 * - 数字 → v-num
 * - true/false/null → v-bool / v-null
 * - 字母（键名）→ v-key（连续字母段）
 * - 其余标点 → v-punct
 */
function appendJsonColored(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // 找下一个未转义的 "
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"' && text[j - 1] !== "\\") break;
        j++;
      }
      const lit = document.createElement("span");
      // 判断是 key 还是 str：往前看，跳过空白，看前一个非空字符
      let k = i - 1;
      while (k >= 0 && /\s/.test(text[k])) k--;
      const isKey = k >= 0 && text[k] === ":";
      lit.className = isKey ? "v-key" : "v-str";
      lit.textContent = text.slice(i, j + 1);
      previewPane.appendChild(lit);
      i = j + 1;
    } else if (/[0-9-]/.test(c) && (i === 0 || /[\s,:\[]/.test(text[i - 1]))) {
      // 数字
      let j = i;
      while (j < n && /[0-9.eE+\-]/.test(text[j])) j++;
      const span = document.createElement("span");
      span.className = "v-num";
      span.textContent = text.slice(i, j);
      previewPane.appendChild(span);
      i = j;
    } else if (text.startsWith("true", i) || text.startsWith("false", i)) {
      const span = document.createElement("span");
      span.className = "v-bool";
      span.textContent = text.slice(
        i,
        i + (text.startsWith("true", i) ? 4 : 5),
      );
      previewPane.appendChild(span);
      i += text.startsWith("true", i) ? 4 : 5;
    } else if (text.startsWith("null", i)) {
      const span = document.createElement("span");
      span.className = "v-null";
      span.textContent = "null";
      previewPane.appendChild(span);
      i += 4;
    } else if (/[{}\[\],:]/.test(c)) {
      const span = document.createElement("span");
      span.className = "v-punct";
      span.textContent = c;
      previewPane.appendChild(span);
      i++;
    } else {
      previewPane.appendChild(document.createTextNode(c));
      i++;
    }
  }
}

previewRefreshBtn.addEventListener("click", refreshPreview);

function updateDynamicValueBtnState(state) {
  const text = state.doc.toString();
  const sel = state.selection.main;
  const anchor = findStringAnchorAt(text, sel.from, sel.to);
  if (!anchor) {
    dynamicValueToolbarBtn.disabled = true;
    dynamicValueToolbarBtn.title =
      "把光标放进字段值里，或先选中字段值（双击字符串即可）";
  } else {
    dynamicValueToolbarBtn.disabled = false;
    const inner = text.slice(anchor.from, anchor.to);
    const hasExpr = /\{\{\$[a-zA-Z_]/.test(inner);
    let mode;
    if (sel.from !== sel.to) mode = "选中的";
    else if (anchor.hasQuotes) mode = "光标所在的";
    else mode = "即将填入的";
    dynamicValueToolbarBtn.title = hasExpr
      ? `编辑${mode}字段值的动态表达式`
      : `把${mode}字段值替换为动态表达式`;
    dynamicValueToolbarBtn.textContent = hasExpr ? "编辑表达式" : "动态值";
  }
}

/**
 * 找选区或光标所在的 string literal 锚点
 * 三种情况（按优先级）：
 *   A) 选区 (from !== to)：
 *      - 选区两端被引号包围 → from/to 在引号之间，hasQuotes=true
 *      - 选区本身是完整字符串字面量 → from+1 / to-1，hasQuotes=true
 *      - 其他情况 → null
 *   B) 光标 (from === to) 在某个 string token 内（开闭引号之间）→ hasQuotes=true
 *   C) 光标在 `:` 之后只有空白的位置（如刚打了 `"key": `）→ hasQuotes=false（插入时自动包引号）
 *   否则 → null
 */
function findStringAnchorAt(text, from, to) {
  if (from !== to) {
    const selected = text.slice(from, to);
    const left = from > 0 ? text[from - 1] : "";
    const right = to < text.length ? text[to] : "";
    if (left === '"' && right === '"') {
      return { from, to, hasQuotes: true };
    }
    if (
      selected.length >= 2 &&
      selected.startsWith('"') &&
      selected.endsWith('"')
    ) {
      return { from: from + 1, to: to - 1, hasQuotes: true };
    }
    return null;
  }
  return findStringAtCursor(text, from) || findEmptyValueAtCursor(text, from);
}

/** 光标是否在 string token 内（开闭引号之间） */
function findStringAtCursor(text, pos) {
  let left = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] === '"') {
      let bs = 0;
      for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) bs++;
      if (bs % 2 === 0) {
        left = i;
        break;
      }
    }
  }
  if (left < 0) return null;
  let right = -1;
  for (let i = left + 1; i < text.length; i++) {
    if (text[i] === '"' && text[i - 1] !== "\\") {
      right = i;
      break;
    }
  }
  if (right < 0) return null;
  if (pos < left || pos > right) return null;
  return { from: left + 1, to: right, hasQuotes: true };
}

/**
 * 光标是否在「`: ` 之后只有空白」的位置 —— 即刚打完 key + colon + space 还没填 value 的状态。
 * 返回 hasQuotes=false 的空范围，插入时由模态框自动包引号。
 */
function findEmptyValueAtCursor(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const lineEndRaw = text.indexOf("\n", pos);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const col = pos - lineStart;
  // 找当前行最近的一个 `:`（光标之前）
  let colonCol = -1;
  for (let i = col - 1; i >= 0; i--) {
    const ch = line[i];
    if (ch === ":") {
      colonCol = i;
      break;
    }
    if (ch === "," || ch === "{" || ch === "[" || ch === "}") break;
  }
  if (colonCol < 0) return null;
  // `:` 之后到光标必须只允许空白
  for (let i = colonCol + 1; i < col; i++) {
    if (!/\s/.test(line[i])) return null;
  }
  // 光标之后不是 `"` 开头（否则属于 string 内的情况，让 findStringAtCursor 处理）
  const after = line.slice(col);
  if (after.startsWith('"')) return null;
  // 光标之后也不能紧接 , } ]（否则这是上一个值的尾部，不算 value 起点）
  if (/^[,}\]]/.test(after)) return null;
  return { from: pos, to: pos, hasQuotes: false };
}

dynamicValueToolbarBtn.addEventListener("click", () => {
  const view = getEditorView();
  if (!view) return;
  const state = view.state;
  const sel = state.selection.main;
  const text = state.doc.toString();
  const anchor = findStringAnchorAt(text, sel.from, sel.to);
  if (!anchor) {
    flashToolbarHint(dynamicValueToolbarBtn, "先放进字段值");
    return;
  }
  const inner = text.slice(anchor.from, anchor.to);
  const hasExpr = /\{\{\$[a-zA-Z_]/.test(inner);
  window.__openGeneratorModal?.({
    from: anchor.from,
    to: anchor.to,
    currentValue: inner,
    initialExpr: hasExpr ? extractFirstExpr(inner) : null,
    hasQuotes: anchor.hasQuotes,
  });
});

function extractFirstExpr(s) {
  const m = /\{\{\$[a-zA-Z_][a-zA-Z0-9_.]*(?::[^}]*)?\}\}/.exec(s);
  return m ? m[0] : null;
}

/** 工具栏按钮短暂高亮提示（用于「先选中字段值」之类的反馈） */
function flashToolbarHint(btn, hint) {
  const original = btn.textContent;
  btn.textContent = hint;
  btn.classList.add("is-hint");
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove("is-hint");
  }, 1400);
}

// ============================================================
// Generator modal behavior
// ============================================================
const generatorModal = $("#generatorModal");
const generatorBackdrop = $("#generatorBackdrop");
const generatorCloseBtn = $("#generatorClose");
const generatorBackBtn = $("#generatorBack");
const generatorLocaleSelect = $("#generatorLocale");
const generatorSearchInput = $("#generatorSearch");
const generatorCategoriesEl = $("#generatorCategories");
const generatorExprText = $("#generatorExprText");
const generatorSampleText = $("#generatorSampleText");
const generatorInsertBtn = $("#generatorInsertBtn");

let generatorCatalog = null;
const generatorState = {
  selectedId: null,
  args: {},
  pendingRange: null,
  filterText: "",
};

async function openGeneratorModal({
  from,
  to,
  currentValue,
  initialExpr,
  hasQuotes,
}) {
  generatorState.pendingRange = { from, to, hasQuotes: hasQuotes !== false };
  if (!generatorCatalog) {
    generatorCatalog = await api.getGenerators();
  }
  if (initialExpr) {
    const parsed = parseInlineExpression(initialExpr);
    if (parsed) {
      generatorState.selectedId = parsed.id;
      const def = findGeneratorDef(parsed.id);
      generatorState.args = {};
      if (def)
        for (const a of def.args)
          generatorState.args[a.name] =
            parsed.args[Object.keys(parsed.args)[def.args.indexOf(a)]] ??
            a.default;
    }
  } else {
    generatorState.selectedId = null;
    generatorState.args = {};
  }
  generatorSearchInput.value = "";
  generatorState.filterText = "";
  renderGeneratorCategories();
  updateGeneratorExprAndSample();
  generatorModal.hidden = false;
}

function parseInlineExpression(s) {
  const m = /^\{\{\$([a-zA-Z_][a-zA-Z0-9_.]*)(?::([^}]*))?\}\}$/.exec(s.trim());
  if (!m) return null;
  const args = {};
  if (m[2])
    m[2].split(":").forEach((p, i) => {
      args[i] = p;
    });
  return { id: m[1], args };
}

function findGeneratorDef(id) {
  if (!generatorCatalog) return null;
  for (const cat of generatorCatalog.categories) {
    const g = cat.generators.find((x) => x.id === id);
    if (g) return g;
  }
  return null;
}

function renderGeneratorCategories() {
  if (!generatorCatalog) return;
  generatorCategoriesEl.innerHTML = "";
  const filter = generatorState.filterText.toLowerCase();
  for (const cat of generatorCatalog.categories) {
    const filtered = cat.generators.filter((g) => {
      if (!filter) return true;
      return (
        g.label.toLowerCase().includes(filter) ||
        g.id.toLowerCase().includes(filter)
      );
    });
    if (filtered.length === 0) continue;
    const catEl = document.createElement("div");
    catEl.className = "gen-cat";
    const header = document.createElement("div");
    header.className = "gen-cat-header";
    header.innerHTML = `<span>› ${cat.label}</span>`;
    catEl.appendChild(header);
    const list = document.createElement("div");
    list.className = "gen-cat-list";
    for (const g of filtered) {
      const item = document.createElement("div");
      item.className =
        "gen-item" + (g.id === generatorState.selectedId ? " is-selected" : "");
      item.innerHTML = `<span class="gen-item-label">${g.label}</span><span class="gen-item-type">$${g.id}</span>`;
      item.addEventListener("click", () => {
        generatorState.selectedId = g.id;
        const def = findGeneratorDef(g.id);
        generatorState.args = {};
        if (def)
          for (const a of def.args) generatorState.args[a.name] = a.default;
        renderGeneratorCategories();
        updateGeneratorExprAndSample();
      });
      list.appendChild(item);
      if (g.id === generatorState.selectedId) {
        const def = findGeneratorDef(g.id);
        if (def && def.args.length > 0) {
          const argsEl = document.createElement("div");
          argsEl.className = "gen-args";
          for (const a of def.args) {
            const label = document.createElement("label");
            const nameSpan = document.createElement("span");
            nameSpan.textContent = a.name;
            label.appendChild(nameSpan);
            let input;
            if (a.type === "locale") {
              input = document.createElement("select");
              for (const loc of ["zh_CN", "en"]) {
                const opt = document.createElement("option");
                opt.value = loc;
                opt.textContent = loc;
                if (loc === (generatorState.args[a.name] || a.default))
                  opt.selected = true;
                input.appendChild(opt);
              }
              input.addEventListener("change", () => {
                generatorState.args[a.name] = input.value;
                updateGeneratorExprAndSample();
              });
            } else {
              input = document.createElement("input");
              input.type =
                a.type === "int" || a.type === "float" ? "number" : "text";
              const cur = generatorState.args[a.name] ?? a.default;
              input.value = cur === undefined || cur === null ? "" : cur;
              input.addEventListener("input", () => {
                generatorState.args[a.name] = input.value;
                updateGeneratorExprAndSample();
              });
            }
            label.appendChild(input);
            argsEl.appendChild(label);
          }
          list.appendChild(argsEl);
        }
      }
    }
    catEl.appendChild(list);
    generatorCategoriesEl.appendChild(catEl);
  }
}

function buildExprText(id, args) {
  const def = findGeneratorDef(id);
  if (!def) return "";
  const argVals = def.args.map((a) => args[a.name] ?? a.default);
  const allFilled = argVals.every((v) => v !== undefined && v !== "");
  if (!allFilled) return `{{$${id}}}`;
  return `{{$${id}:${argVals.join(":")}}}`;
}

let sampleTimer = null;
function updateGeneratorExprAndSample() {
  const id = generatorState.selectedId;
  if (!id) {
    generatorExprText.textContent = "—";
    generatorSampleText.textContent = "—";
    generatorInsertBtn.disabled = true;
    return;
  }
  generatorInsertBtn.disabled = false;
  const expr = buildExprText(id, generatorState.args);
  generatorExprText.textContent = expr;
  if (sampleTimer) clearTimeout(sampleTimer);
  sampleTimer = setTimeout(async () => {
    const res = await api.getGeneratorSample(
      id,
      normalizeArgs(id, generatorState.args),
    );
    generatorSampleText.textContent = res.ok
      ? String(res.sample)
      : res.error || "生成失败";
  }, 200);
}

function normalizeArgs(id, args) {
  const def = findGeneratorDef(id);
  if (!def) return {};
  const out = {};
  for (const a of def.args) {
    const v = args[a.name];
    if (v === undefined || v === "") continue;
    if (a.type === "int") {
      const n = parseInt(v, 10);
      if (!Number.isNaN(n)) out[a.name] = n;
    } else if (a.type === "float") {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) out[a.name] = n;
    } else {
      out[a.name] = String(v);
    }
  }
  return out;
}

function closeGeneratorModal() {
  generatorModal.hidden = true;
}

generatorCloseBtn.addEventListener("click", closeGeneratorModal);
generatorBackdrop.addEventListener("click", closeGeneratorModal);
generatorBackBtn.addEventListener("click", closeGeneratorModal);
generatorSearchInput.addEventListener("input", () => {
  generatorState.filterText = generatorSearchInput.value;
  renderGeneratorCategories();
});
generatorLocaleSelect.addEventListener("change", () => {
  // v1: locale 切换仅影响 person/location 类生成器显示的 label 提示
});

generatorInsertBtn.addEventListener("click", () => {
  const id = generatorState.selectedId;
  if (!id || !generatorState.pendingRange) return;
  const expr = buildExprText(id, generatorState.args);
  // 插入目标 = 最近聚焦的编辑器（WS XML 编辑器聚焦时插到 XML 里）
  const view = getActiveEditorView();
  const { from, to, hasQuotes } = generatorState.pendingRange;
  const replacement = hasQuotes ? expr : `"${expr}"`;
  const newCursor = from + (hasQuotes ? 0 : 1);
  view.dispatch({
    changes: { from, to, insert: replacement },
    selection: { anchor: newCursor, head: newCursor + expr.length },
  });
  closeGeneratorModal();
});

window.__openGeneratorModal = openGeneratorModal;
