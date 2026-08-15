// 导入 WSDL 弹窗：粘贴/本地文件 → 解析预览（新增/更新/保留计数）→ 确认合并（spec §5/§6.③）
export function initImportWsdlDialog({ els, api, onImported }) {
  let target = null;   // 目标 service 对象（来自 state.services，含 operations/hasWsdl）
  let parsed = null;   // 最近一次解析预览结果

  const reset = () => {
    els.importWsdlText.value = '';
    els.importWsdlFile.value = '';
    els.importWsdlPreview.hidden = true;
    els.importWsdlPreview.textContent = '';
    els.importWsdlSummary.textContent = '';
    els.importWsdlError.hidden = true;
    els.importWsdlConfirm.disabled = true;
    parsed = null;
  };

  const open = (service) => {
    target = service;
    reset();
    els.importWsdlModal.hidden = false;
    els.importWsdlText.focus();
  };
  const close = () => {
    els.importWsdlModal.hidden = true;
  };
  const fail = (msg) => {
    els.importWsdlError.textContent = msg;
    els.importWsdlError.hidden = false;
  };

  els.importWsdlFile.addEventListener('change', async () => {
    const f = els.importWsdlFile.files?.[0];
    if (!f) return;
    els.importWsdlText.value = await f.text();
  });

  els.importWsdlParseBtn.addEventListener('click', async () => {
    const text = els.importWsdlText.value.trim();
    if (!text) return fail('请先粘贴 WSDL 内容或选择文件');
    els.importWsdlError.hidden = true;
    try {
      parsed = await api.parseWsdl(text);
    } catch (e) {
      parsed = null;
      els.importWsdlPreview.hidden = true;
      els.importWsdlSummary.textContent = '';
      els.importWsdlConfirm.disabled = true;
      return fail(e?.message || 'WSDL 解析失败');
    }
    const existing = new Set((target.operations || []).map((o) => o.name));
    const incoming = new Set(parsed.operations.map((o) => o.name));
    const add = parsed.operations.filter((o) => !existing.has(o.name)).length;
    const upd = parsed.operations.length - add;
    const keep = (target.operations || []).filter((o) => !incoming.has(o.name)).length;
    els.importWsdlSummary.textContent = `将新增 ${add} 个、更新 ${upd} 个、保留 ${keep} 个操作（同名操作的响应配置会保留）`;
    els.importWsdlPreview.textContent = parsed.operations.length
      ? parsed.operations
          .map((o) => `${o.name}${o.soapAction ? `  (${o.soapAction})` : ''}`)
          .join('\n')
      : '（未解析到 operation，导入后可在详情页手工添加）';
    els.importWsdlPreview.hidden = false;
    els.importWsdlConfirm.disabled = false;
  });

  els.importWsdlConfirm.addEventListener('click', async () => {
    if (!parsed || !target) return;
    try {
      const updated = await api.importServiceWsdl(target.id, els.importWsdlText.value.trim());
      await onImported(updated);
      close();
    } catch (e) {
      fail(e?.message || '导入失败');
    }
  });

  els.importWsdlClose.addEventListener('click', close);
  els.importWsdlBackdrop.addEventListener('click', close);
  els.importWsdlCancel.addEventListener('click', close);
  return { open, close };
}