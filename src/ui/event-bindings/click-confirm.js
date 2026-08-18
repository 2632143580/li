/**
 * 二次点击确认（inline confirm）—— 替代原生 confirm()。
 *
 * 痛点：原生 confirm() 是浏览器模态弹窗，打断操作流、移动端体验差、样式不可控，
 *       且一次误点就执行毁灭性操作（清空对话 / 删除配色）。
 * 做法：调用一次即绑定，首次触发进入「待确认」态，同一元素再次触发才执行动作；
 *       超过 resetMs 无操作自动复位。
 *
 * 触发事件可配置：默认 'click'（按钮）；色块点用 'contextmenu'（右键），
 *       避免与「左键点击=应用配色」的委托点击冲突。
 * 待确认态的视觉表达（不弹气泡，纯元素自身状态变化）：
 *   - 文本按钮（<button> 有文字）：把文字翻成 armedText（如「删除」→「确认删除?」）；
 *   - 图标 / 色块（无文字）：把内容直接换成「?」问号（垃圾桶图标变 ?、色块上叠 ?），
 *     配 .armed 红色脉冲环。
 * 执行时 stopPropagation + preventDefault，防止元素上其他委托点击（如色块应用）误触发。
 */

/** 当前处于「待确认」态的元素与复位上下文 @type {object|null} */
let armedState = null;

/**
 * 复位「待确认」态：清定时器、去 .armed、还原内容（文字或 innerHTML）、还原 title。
 * @returns {void}
 */
function clearArmed() {
    if (!armedState) return;
    const { el, timer, hadTitle, originalTitle, originalHTML, originalText, hasText } = armedState;
    clearTimeout(timer);
    el.classList.remove('armed');
    if (hasText) el.textContent = originalText;
    else el.innerHTML = originalHTML;
    if (hadTitle) el.setAttribute('title', originalTitle);
    else el.removeAttribute('title');
    armedState = null;
}

/**
 * 进入「待确认」态：记录原状态、加警示类、翻文字或换成「?」、起自动复位定时器。
 * @param {HTMLElement} el - 目标元素
 * @param {{armedText:string, resetMs:number}} cfg - 配置
 * @returns {void}
 */
function arm(el, cfg) {
    const hasText = el.tagName === 'BUTTON' && el.textContent.trim().length > 0;
    const hadTitle = el.hasAttribute('title');
    const originalTitle = hadTitle ? el.getAttribute('title') : null;
    const originalHTML = el.innerHTML;
    const originalText = hasText ? el.textContent : null;

    el.classList.add('armed');
    if (hasText) {
        el.textContent = cfg.armedText; // 文本按钮：翻成确认文字
    } else {
        el.innerHTML = '?';             // 图标 / 色块：直接变成问号（不再浮气泡）
    }
    el.setAttribute('title', cfg.armedText);
    const timer = setTimeout(clearArmed, cfg.resetMs);
    armedState = { el, timer, hadTitle, originalTitle, originalHTML, originalText, hasText };
}

/**
 * 绑定二次点击确认（替代 confirm）。调用一次即绑定，内部自管「锁定↔执行」切换。
 * @param {HTMLElement} el - 目标按钮 / 元素
 * @param {() => void} action - 再次触发时执行的动作（毁灭性操作）
 * @param {{armedText?: string, resetMs?: number, trigger?: string}} [opts]
 *        - armedText: 待确认态提示（文本按钮翻成它；图标/色块作 title 与「?」语义），默认「再次点击确认」
 *        - resetMs: 自动复位毫秒数，默认 3000
 *        - trigger: 触发事件，默认 'click'；色块点用 'contextmenu'（右键）
 * @returns {void}
 */
export function armClickConfirm(el, action, opts = {}) {
    if (el.__armedBound) return; // 已绑定：切换逻辑由内部监听处理，外部重复调用忽略
    el.__armedBound = true;
    const cfg = { armedText: opts.armedText || '再次点击确认', resetMs: opts.resetMs || 3000 };
    const ev = opts.trigger || 'click';
    el.addEventListener(ev, (e) => {
        e.preventDefault();
        if (armedState && armedState.el === el) {
            e.stopPropagation();
            clearArmed();
            action();
            return;
        }
        if (armedState) clearArmed();
        arm(el, cfg);
    });
}
