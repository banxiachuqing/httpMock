// 消息通知 toast —— 顶部居中横幅（spec 2026-08-17）
const TOAST_DURATION = { success: 2500, error: 3500, info: 2500 };
const MARK = { success: "✓", error: "✗", info: "·" };

let container = null;
const timers = new Map(); // HTMLElement -> timeoutId

function ensureContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  container.setAttribute("aria-live", "polite");
  document.body.appendChild(container);
  return container;
}

function kindOf(el) {
  return el.classList.contains("toast-error")
    ? "error"
    : el.classList.contains("toast-success")
      ? "success"
      : "info";
}

function dismiss(el) {
  clearTimeout(timers.get(el));
  timers.delete(el);
  el.classList.remove("show");
  setTimeout(() => el.remove(), 200); // 匹配退场过渡时长
}

function scheduleDismiss(el) {
  clearTimeout(timers.get(el));
  const t = setTimeout(() => dismiss(el), TOAST_DURATION[kindOf(el)]);
  timers.set(el, t);
}

/**
 * @param {{ type?: 'success'|'error'|'info', message: string }} opts
 */
export function showToast({ type = "info", message } = {}) {
  if (!["success", "error", "info"].includes(type)) type = "info";
  const c = ensureContainer();

  // 同文案同类型已有气泡在显示：重置其计时，不新增叠加
  for (const other of c.querySelectorAll(".toast")) {
    if (
      kindOf(other) === type &&
      other.querySelector(".toast-msg")?.textContent === message
    ) {
      scheduleDismiss(other);
      return;
    }
  }

  const el = document.createElement("div");
  el.className = `toast toast-${type}`;

  const mark = document.createElement("span");
  mark.className = "toast-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = MARK[type];

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "✕";
  close.addEventListener("click", () => dismiss(el));

  el.append(mark, msg, close);
  el.addEventListener("mouseenter", () => clearTimeout(timers.get(el)));
  el.addEventListener("mouseleave", () => scheduleDismiss(el));

  c.appendChild(el);
  // 入场动画：下一帧补 .show 才有过渡效果
  requestAnimationFrame(() => el.classList.add("show"));
  scheduleDismiss(el);
}