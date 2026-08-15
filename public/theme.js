// 主题系统：system / light / dark → 解析生效值 → data-theme + Tauri 壳联动
// spec: docs/superpowers/specs/2026-08-15-theme-system-design.md
const VALID = new Set(['system', 'light', 'dark']);
const CACHE_KEY = 'mockserver.theme';

let current = 'system';
let media = null;
const listeners = new Set();

/**
 * 纯函数：设置值 + 系统偏好 → 生效主题
 * @param {string} setting
 * @param {boolean} prefersDark
 * @returns {'light'|'dark'}
 */
export function resolveTheme(setting, prefersDark) {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/** 注册主题生效值变化回调（如 CodeMirror 联动） */
export function onThemeChange(fn) {
  listeners.add(fn);
}

function mediaQuery() {
  if (!media) media = window.matchMedia('(prefers-color-scheme: dark)');
  return media;
}

function applyResolved(resolved) {
  document.documentElement.dataset.theme = resolved;
  if (window.__TAURI__) {
    document.documentElement.classList.add('tauri');
    try {
      window.__TAURI__.app.setTheme(resolved);
    } catch {
      /* 壳不支持时忽略（浏览器模式 / 旧壳） */
    }
  }
  listeners.forEach((fn) => fn(resolved));
}

/**
 * 应用主题设置。system 模式下挂 matchMedia change 监听跟随系统。
 * @param {string} setting
 */
export function applyTheme(setting) {
  current = VALID.has(setting) ? setting : 'system';
  const mq = mediaQuery();
  applyResolved(resolveTheme(current, mq.matches));
  try {
    localStorage.setItem(CACHE_KEY, current);
  } catch {
    /* 隐私模式等场景忽略 */
  }
  mq.onchange = () => {
    if (current !== 'system') return;
    applyResolved(resolveTheme(current, mq.matches));
  };
}

/** 当前设置值（三态） */
export function currentSetting() {
  return current;
}
