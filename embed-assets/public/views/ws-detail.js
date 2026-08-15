// WS 服务详情页：operation 侧栏 + XML 响应编辑（spec §6.③）
import { navigate } from "../router.js";
import { createEditor } from "../editor.js";
import { serviceAddress } from "./ws-services.js";

let ctx = null; // { els, state, api }
let xmlEditor = null; // createEditor 实例（懒挂载）
let previewTimer = null;

function currentService(state) {
  return (
    (state.services || []).find(
      (s) => s.id === state.route.serviceId && s.port === state.route.port,
    ) || null
  );
}

function currentOperation(state) {
  const s = currentService(state);
  return s?.operations.find((o) => o.id === state.selectedOperationId) || null;
}

function replaceService(state, updated) {
  const i = (state.services || []).findIndex((s) => s.id === updated.id);
  if (i >= 0) state.services[i] = updated;
}

function wsMarkDirty() {
  const { state, els } = ctx;
  if (state.dirty) return;
  state.dirty = true;
  els.wsLastSaved.textContent = "未保存";
  els.wsLastSaved.style.color = "var(--amber)";
}

function wsFlash(text, color) {
  const { state, els } = ctx;
  els.wsLastSaved.textContent = text;
  els.wsLastSaved.style.color = `var(--${color})`;
  setTimeout(() => {
    els.wsLastSaved.style.color = state.dirty ? "var(--amber)" : "";
    els.wsLastSaved.textContent = state.dirty ? "未保存" : "已保存";
  }, 1600);
}

// ====== 渲染 ======

export function renderServiceDetail() {
  const { state, els } = ctx;
  const s = currentService(state);
  if (!s) return;
  els.serviceHeaderName.textContent = s.name;
  els.serviceHeaderPath.textContent = s.path;
  els.serviceEnabledToggle.checked = s.enabled !== false;

  ensureXmlEditor();
  xmlEditor?.view.requestMeasure();

  // 选中项兜底：未选或已失效时选第一个 operation
  if (!currentOperation(state)) {
    state.selectedOperationId = s.operations[0]?.id || null;
  }
  renderOperationList();
  renderOperationEditor();
}

function renderOperationList() {
  const { state, els } = ctx;
  const s = currentService(state);
  const ops = s?.operations || [];
  els.operationCount.textContent = String(ops.length);
  els.operationList.innerHTML = "";
  for (const op of ops) {
    const li = document.createElement("li");
    li.className =
      "endpoint-item" +
      (op.id === state.selectedOperationId ? " selected" : "");
    li.dataset.id = op.id;
    li.setAttribute("role", "option");
    li.setAttribute(
      "aria-selected",
      op.id === state.selectedOperationId ? "true" : "false",
    );

    const nameRow = document.createElement("div");
    nameRow.className = "endpoint-name-row";
    const nameSpan = document.createElement("span");
    nameSpan.className = "endpoint-name";
    nameSpan.textContent = op.name;
    const badge = document.createElement("span");
    badge.className = "port-type-badge";
    badge.dataset.type = op.responseType === "fault" ? "ws" : "http";
    badge.textContent =
      op.responseType === "fault" ? "Fault" : String(op.status || 200);
    nameRow.append(nameSpan, badge);

    const meta = document.createElement("div");
    meta.className = "endpoint-meta";
    const action = document.createElement("span");
    action.className = "endpoint-path";
    action.textContent = op.soapAction || "（按 Body 匹配）";
    meta.append(action);

    li.append(nameRow, meta);
    li.addEventListener("click", () => {
      if (state.dirty && !confirm("有未保存的修改，是否放弃？")) return;
      state.selectedOperationId = op.id;
      state.dirty = false;
      renderOperationList();
      renderOperationEditor();
    });
    els.operationList.appendChild(li);
  }
}

function renderOperationEditor() {
  const { state, els } = ctx;
  const op = currentOperation(state);
  if (!op) {
    els.wsEditorEmpty.hidden = false;
    els.wsEditorForm.hidden = true;
    return;
  }
  els.wsEditorEmpty.hidden = true;
  els.wsEditorForm.hidden = false;
  els.wsOperationId.textContent = `id: ${op.id.slice(0, 8)}…`;
  if (!state.dirty) {
    els.wsOpName.value = op.name;
    els.wsOpSoapAction.value = op.soapAction || "";
    els.wsOpStatus.value = op.status || 200;
    els.wsResponseType.value = op.responseType || "normal";
    xmlEditor?.setValue(op.responseXml || "");
    els.wsLastSaved.textContent = "已保存";
    els.wsLastSaved.style.color = "";
  }
  updateWsMeta();
  validateWsXml();
  scheduleWsPreview();
}

// ====== 编辑器 / 校验 / 预览 ======

function ensureXmlEditor() {
  if (xmlEditor) return;
  xmlEditor = createEditor({
    host: ctx.els.xmlEditorHost,
    language: "xml",
    onChange: () => {
      wsMarkDirty();
      updateWsMeta();
      validateWsXml();
      scheduleWsPreview();
    },
  });
}

function updateWsMeta() {
  const { els } = ctx;
  const text = xmlEditor ? xmlEditor.getValue() : "";
  const lines = text === "" ? 0 : text.split("\n").length;
  els.wsLineCount.textContent = `${lines} 行`;
  els.wsCharCount.textContent = `${text.length} 字符`;
}

function setWsValidation(state_, text) {
  const { els } = ctx;
  els.wsValidationStatus.dataset.state = state_;
  els.wsValidationStatus.querySelector(".val-text").textContent = text;
  els.wsValidationStatus.querySelector(".val-mark").textContent =
    state_ === "valid" ? "✓" : state_ === "invalid" ? "✗" : "·";
}

function validateWsXml() {
  const text = xmlEditor ? xmlEditor.getValue().trim() : "";
  if (!text) return setWsValidation("empty", "空");
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror"))
    return setWsValidation("invalid", "XML 不合法");
  setWsValidation("valid", "合法");
}

// 面向元素型 SOAP XML 的简单缩进格式化；混合内容（文本与子元素同行）不做美化
function formatXml(text) {
  const compact = text.replace(/>\s+</g, "><").trim();
  const tokens = compact.match(/<[^>]+>|[^<]+/g) || [];
  let indent = 0;
  const lines = [];
  for (const tok of tokens) {
    if (/^<\//.test(tok)) indent = Math.max(0, indent - 1);
    if (/\S/.test(tok)) lines.push("  ".repeat(indent) + tok);
    if (/^<[^!?/](?:[^>]*[^/])?>$/.test(tok)) indent++;
  }
  return lines.join("\n");
}

function scheduleWsPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshWsPreview, 300);
}

async function refreshWsPreview() {
  const { els, api } = ctx;
  const text = xmlEditor ? xmlEditor.getValue() : "";
  if (!text.trim()) {
    els.wsPreviewPane.textContent = "// 在左侧编辑响应 XML，此处显示解析结果";
    setWsPreviewMeta("", "就绪", 0, 0);
    els.wsPreviewBanner.hidden = true;
    return;
  }
  let res;
  try {
    res = await api.preview(text, "text");
  } catch {
    els.wsPreviewBanner.textContent = "预览暂不可用";
    els.wsPreviewBanner.hidden = false;
    setWsPreviewMeta("has-errors", "离线", 0, 1);
    return;
  }
  els.wsPreviewBanner.hidden = true;
  els.wsPreviewPane.textContent = res.resolved;
  setWsPreviewMeta(
    res.errors.length > 0 ? "has-errors" : "is-resolved",
    res.errors.length > 0 ? "部分解析" : "已解析",
    res.exprCount,
    res.errors.length,
  );
}

function setWsPreviewMeta(state_, label, exprCount, errCount) {
  const { els } = ctx;
  els.wsPreviewMeta.className = "meta " + state_;
  els.wsPreviewMetaLabel.textContent = label;
  els.wsPreviewExprStat.innerHTML = `表达式 <strong>${exprCount}</strong>`;
  els.wsPreviewErrStat.innerHTML = `错误 <strong>${errCount}</strong>`;
  els.wsPreviewErrStat.style.display = errCount > 0 ? "" : "none";
}

// ====== 事件接线 ======

export function initServiceDetail({
  els,
  state,
  api,
  refreshAll,
  importDialog,
}) {
  ctx = { els, state, api };

  els.backToPortBtn.addEventListener("click", () =>
    navigate(`#/port/${state.route.port}`),
  );

  els.serviceEnabledToggle.addEventListener("change", async () => {
    const s = currentService(state);
    if (!s) return;
    try {
      const updated = await api.updateService(s.id, {
        enabled: els.serviceEnabledToggle.checked,
      });
      replaceService(state, updated);
    } catch (e) {
      els.serviceEnabledToggle.checked = !els.serviceEnabledToggle.checked;
      alert("切换失败：" + (e?.message || "未知错误"));
    }
  });

  els.importWsdlBtn.addEventListener("click", () => {
    const s = currentService(state);
    if (s) importDialog().open(s);
  });

  els.copyServiceAddrBtn.addEventListener("click", () => {
    const s = currentService(state);
    if (s) navigator.clipboard.writeText(serviceAddress(s));
  });

  els.deleteServiceBtn.addEventListener("click", async () => {
    const s = currentService(state);
    if (!s) return;
    // 注意：dirty 不能在确认放弃后立刻清零 —— 若用户放弃确认（取消删除），
    // 未保存的编辑必须保留（否则下次切换 operation 时会被 !state.dirty guard 静默丢弃）
    if (
      state.dirty &&
      !confirm("有未保存的修改，删除服务将放弃这些修改。继续？")
    )
      return;
    if (
      !confirm(
        `确认删除服务 ${s.name}（${s.path}）？其下 ${(s.operations || []).length} 个操作将一并删除。`,
      )
    )
      return;
    try {
      await api.deleteService(s.id);
      state.dirty = false;
      await refreshAll();
      navigate(`#/port/${s.port}`);
    } catch (e) {
      alert("删除失败：" + (e?.message || "未知错误"));
    }
  });

  const createOp = async () => {
    const s = currentService(state);
    if (!s) return;
    try {
      const updated = await api.createOperation(s.id, {
        name: `op${(s.operations || []).length + 1}`,
      });
      replaceService(state, updated);
      state.selectedOperationId =
        updated.operations[updated.operations.length - 1]?.id || null;
      state.dirty = false;
      renderServiceDetail();
    } catch (e) {
      alert("新建操作失败：" + (e?.message || "未知错误"));
    }
  };
  els.newOperationBtn.addEventListener("click", createOp);
  els.wsEmptyNewBtn.addEventListener("click", createOp);

  for (const f of [
    els.wsOpName,
    els.wsOpSoapAction,
    els.wsOpStatus,
    els.wsResponseType,
  ]) {
    f.addEventListener("input", () => wsMarkDirty());
  }

  els.wsFormatBtn.addEventListener("click", () => {
    if (!xmlEditor) return;
    const text = xmlEditor.getValue();
    if (!text.trim()) return;
    xmlEditor.setValue(formatXml(text));
    wsMarkDirty();
    setWsValidation("valid", "已格式化");
    updateWsMeta();
    scheduleWsPreview();
  });

  els.wsValidateBtn.addEventListener("click", () => validateWsXml());

  els.wsDynamicBtn.addEventListener("click", () => {
    if (!xmlEditor) return;
    const view = xmlEditor.view;
    const sel = view.state.selection.main;
    const text = view.state.doc.toString();
    const selected = text.slice(sel.from, sel.to);
    const m = /\{\{\$[a-zA-Z_][^}]*\}\}/.exec(selected);
    window.__openGeneratorModal?.({
      from: sel.from,
      to: sel.to,
      currentValue: selected,
      initialExpr: m ? m[0] : null,
      hasQuotes: true, // XML 纯文本插入，不包引号
    });
  });

  els.wsSaveOpBtn.addEventListener("click", async () => {
    const s = currentService(state);
    const op = currentOperation(state);
    if (!s || !op) return;
    const body = {
      name: els.wsOpName.value.trim(),
      soapAction: els.wsOpSoapAction.value.trim(),
      status: Number(els.wsOpStatus.value) || 200,
      responseType: els.wsResponseType.value,
      responseXml: xmlEditor ? xmlEditor.getValue() : "",
    };
    try {
      const updated = await api.updateOperation(s.id, op.id, body);
      replaceService(state, updated);
      state.selectedOperationId = op.id;
      state.dirty = false;
      renderOperationList();
      wsFlash("已保存", "green");
    } catch (e) {
      wsFlash("✗ 保存失败", "red");
    }
  });

  els.wsRevertBtn.addEventListener("click", () => {
    state.dirty = false;
    renderOperationEditor();
  });

  els.wsDeleteOpBtn.addEventListener("click", async () => {
    const s = currentService(state);
    const op = currentOperation(state);
    if (!s || !op) return;
    if (!confirm(`确认删除操作 ${op.name}？`)) return;
    try {
      const updated = await api.deleteOperation(s.id, op.id);
      replaceService(state, updated);
      state.selectedOperationId = updated.operations[0]?.id || null;
      state.dirty = false;
      renderServiceDetail();
    } catch (e) {
      alert("删除失败：" + (e?.message || "未知错误"));
    }
  });

  els.wsPreviewRefreshBtn.addEventListener("click", () => refreshWsPreview());
}
