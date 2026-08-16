/**
 * 轻量可见提示（toast）—— 把「静默失败」暴露给用户。
 *
 * 典型用途：云端 TTS 合成失败、音色缺失等「点了没声音却无任何反馈」的场景，
 * 用一条底部浮层明确告诉用户原因，而不是只在 console 里 warn（用户发现不了）。
 *
 * 设计约束：全部 DOM 操作包在 typeof document 守卫内；本模块在 Node 单测环境被 import 时
 * 零副作用（showToast 在非浏览器环境直接 return），故可被 engines/tts-engine 安全引用。
 *
 * 样式在 styles/tts.css 的 .toast-host / .toast 段（主题 token 化）。
 * @param {string} msg 提示文案 @param {'info'|'warn'|'error'} [type='info'] @param {number} [ms=3200] 停留毫秒
 */
let host = null;

/** 惰性取/建宿主容器（仅浏览器环境有效） @returns {HTMLElement|null} */
function ensureHost() {
    if (typeof document === 'undefined') return null;
    if (host && document.body.contains(host)) return host;
    host = document.getElementById('toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.className = 'toast-host';
        document.body.appendChild(host);
    }
    return host;
}

export function showToast(msg, type = 'info', ms = 3200) {
    const h = ensureHost();
    if (!h) return; // 非浏览器环境静默
    const el = document.createElement('div');
    el.className = 'toast toast--' + type;
    el.textContent = msg; // textContent 防注入
    h.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 250);
    }, ms);
}
