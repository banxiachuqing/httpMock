// 确认弹窗 —— 复用现有 .modal 体系，替代系统 confirm()（2026-08-17）
// confirmDialog({ title, message, danger, confirmText, cancelText }) → Promise<boolean>
// 零依赖；DOM 动态创建；Esc / 点遮罩 / ✕ / 取消 → false，确认按钮 → true。

const ICON_DANGER =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6v4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="12" r="1" fill="currentColor"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.1v3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor"/></svg>';

/**
 * @param {{
 *   title: string,
 *   message: string,
 *   danger?: boolean,                 // true → 红色警告样式 + 红色确认按钮（删除类操作）
 *   confirmText?: string,             // 默认「确定」
 *   cancelText?: string,              // 默认「取消」
 * }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title,
  message,
  danger = false,
  confirmText = "确定",
  cancelText = "取消",
} = {}) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "modal modal-confirm";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const panel = document.createElement("div");
    panel.className = "modal-panel modal-confirm-panel";

    const head = document.createElement("header");
    head.className = "modal-confirm-head";

    const icon = document.createElement("span");
    icon.className = `modal-confirm-icon ${danger ? "modal-confirm-icon--danger" : "modal-confirm-icon--info"}`;
    icon.innerHTML = danger ? ICON_DANGER : ICON_INFO;

    const titleEl = document.createElement("h3");
    titleEl.className = "modal-confirm-title";
    titleEl.textContent = title;
    titleEl.id = `confirm-title-${Date.now()}`;

    const close = document.createElement("button");
    close.className = "btn btn-icon modal-confirm-x";
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "✕";
    close.addEventListener("click", () => finish(false));

    head.append(icon, titleEl, close);

    const body = document.createElement("div");
    body.className = "modal-confirm-body";
    body.id = `confirm-desc-${Date.now()}`;
    const p = document.createElement("p");
    p.textContent = message;
    body.appendChild(p);

    const foot = document.createElement("footer");
    foot.className = "modal-confirm-foot";

    const cancel = document.createElement("button");
    cancel.className = "btn btn-ghost";
    cancel.textContent = cancelText;
    cancel.addEventListener("click", () => finish(false));

    const ok = document.createElement("button");
    ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    ok.textContent = confirmText;
    ok.addEventListener("click", () => finish(true));

    foot.append(cancel, ok);
    panel.append(head, body, foot);
    modal.append(backdrop, panel);
    document.body.appendChild(modal);

    modal.setAttribute("aria-labelledby", titleEl.id);
    modal.setAttribute("aria-describedby", body.id);

    // 焦点管理：初始焦点在确认按钮；Esc 取消；Tab 在对话框内循环
    const focusables = [close, cancel, ok];
    ok.focus();
    const onKeydown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Tab") {
        const i = focusables.indexOf(document.activeElement);
        if (i === -1) {
          ok.focus();
        } else {
          const next = e.shiftKey ? i - 1 : i + 1;
          focusables[(next + focusables.length) % focusables.length].focus();
        }
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeydown, true);

    backdrop.addEventListener("click", () => finish(false));

    function finish(result) {
      document.removeEventListener("keydown", onKeydown, true);
      modal.remove();
      resolve(result);
    }
  });
}