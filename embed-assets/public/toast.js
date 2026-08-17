// 消息通知 toast —— 顶部居中横幅（spec 2026-08-17，2026-08-17 视觉升级）
// 零依赖；容器首次调用时动态创建，不改 index.html。
const TOAST_DURATION = { success: 2500, error: 3500, info: 2500 };

// 类型色徽章图标（内联 SVG，stroke 风格，与 Cinematic Dark Glass 色板一致）
const ICONS = {
  success:
    '<svg class="toast-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.8 8.3l2.2 2.1 4.2-4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error:
    '<svg class="toast-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  info:
    '<svg class="toast-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.1v3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor"/></svg>',
};

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
  setTimeout(() => el.remove(), 140); // 匹配退场过渡时长
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
  el.style.setProperty("--toast-duration", `${TOAST_DURATION[type]}ms`);

  const icon = document.createElement("span");
  icon.className = "toast-badge";
  icon.innerHTML = ICONS[type];

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "✕";
  close.addEventListener("click", () => dismiss(el));

  el.append(icon, msg, close);
  el.addEventListener("mouseenter", () => clearTimeout(timers.get(el)));
  el.addEventListener("mouseleave", () => scheduleDismiss(el));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss(el);
  });

  c.appendChild(el);
  // 入场动画：下一帧补 .show 才有过渡效果
  requestAnimationFrame(() => el.classList.add("show"));
  scheduleDismiss(el);
}