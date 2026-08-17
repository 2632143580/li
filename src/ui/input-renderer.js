/**
 * Canvas 输入渲染器（每帧重绘）
 *
 * 职责：在 UI 画布上绘制「呼吸圆环 + 输入线条 + 装饰点 + 文本 + 光标」。
 *       提供文本测量缓存 textCache，避免每帧重复 measureText。
 *       提供 inputColors 缓存（从 CSS 变量读取），供 drawInputArea 与主题引擎刷新使用。
 *
 * 导出：inputRenderer, drawInputArea, updateInputLayout, inputState, textCache, inputColors, updateInputColors
 * 依赖：core/dom, core/state, ui/input-manager
 */
import { DOM, uiCtx, W, H } from '../core/dom.js';
import { state } from '../core/store.js';
import { TAU } from '../core/constants.js';
import { inputManager } from './input-manager.js';

/** 输入框绘制颜色缓存 — 从 CSS 变量读取，随主题/设置变化由 updateInputColors 刷新。 @type {object} */
export const inputColors = {};

/** 刷新输入框颜色缓存（从 CSS 变量读取当前配色）。主题挂载/窗口变化时调用。
 *  末尾主动 markDirty 拉起按需渲染循环——否则按需循环下换肤/resize 后输入框画布不会重绘、颜色不刷新。 @returns {void} */
export function updateInputColors() {
    const style = getComputedStyle(document.documentElement);
    inputColors.ringNormal = style.getPropertyValue('--input-ring-normal').trim();
    inputColors.ringWaiting = style.getPropertyValue('--input-ring-waiting').trim();
    inputColors.line = style.getPropertyValue('--input-line').trim();
    inputColors.dot = style.getPropertyValue('--input-dot').trim();
    inputColors.text = style.getPropertyValue('--input-text').trim();
    inputColors.cursor = style.getPropertyValue('--input-cursor').trim();
    inputRenderer.markDirty();
}

/** 输入框布局状态 @type {object} */
export const inputState = {
    /** 输入框左边缘 X（CSS 像素） @type {number} */
    startX: 0,
    /** 输入框基线 Y（CSS 像素） @type {number} */
    y: 0,
    /** 输入框最大可绘制宽度（CSS 像素） @type {number} */
    maxLen: 0,
    /** 当前输入框线条长度（动画插值目标） @type {number} */
    curLen: 0
};

/** 更新输入框位置和尺寸（随视口与字号变化） */
export function updateInputLayout() {
    inputState.startX = 40;
    inputState.y = H - 45;
    inputState.maxLen = W - 40 - 60;
    DOM.hiddenInput.style.left = inputState.startX + "px";
    DOM.hiddenInput.style.top = (inputState.y - 15) + "px";
    DOM.hiddenInput.style.width = inputState.maxLen + "px";
    DOM.hiddenInput.style.height = "30px";
    DOM.hiddenInput.style.fontSize = '16px'; // 字号设置已移除（2026-08-16），固定默认 16px
    DOM.hiddenInput.style.fontFamily = "Georgia, 'KaiTi', serif";
    DOM.hiddenInput.style.paddingLeft = "12px";
    DOM.hiddenInput.style.lineHeight = "30px";
    // 布局变化时强制下次 drawInputArea 重算文本测量
    textCache.invalidate();
}

/** 输入渲染器控制对象 — 脏标记 + 动画状态 */
export const inputRenderer = {
    /** 是否需要重绘的标记 @type {boolean} */
    _dirty: true,
    /** 线长动画是否进行中 @type {boolean} */
    _animating: false,
    /** 拉起渲染循环的钩子（由 main.js 注入为 requestRender）；markDirty 时调用以唤醒按需循环 @type {function|null} */
    requestFrame: null,

    /** 标记需要重绘；并通过 requestFrame 钩子（main.js 注入的 requestRender）自动拉起按需渲染循环，
     *  使「已停止的循环」在状态变化时被重新唤醒，而非依赖永不停的 60fps 循环。 */
    markDirty() {
        this._dirty = true;
        if (typeof this.requestFrame === 'function') this.requestFrame();
    },

    /** 设置线长动画进行中状态 @param {boolean} v */
    setAnimating(v) { this._animating = v; },

    /**
     * 判断当前帧是否需要重绘（性能门控，避免常态模式 GPU 满载）。
     *
     * 旧实现恒返回 true：呼吸圆环半径 = Math.sin(now) 每帧都变，于是 UI 画布
     * 在「用户完全空闲、没打字也没发消息」时仍每帧 clearRect + 重绘，造成移动端
     * 常态 GPU 占用 70%+。
     *
     * 新逻辑：仅在确有连续画面需求时才重绘——
     *   - state.waiting：AI 思考中，呼吸环需持续脉冲（保留原有「思考指示」语义）；
     *   - _dirty：文本/布局变化（打字、resize、主动消息）需重画；
     *   - _animating：输入线长插值未收敛时需继续补帧。
     * 三者皆否即空闲 → 返回 false，UI 画布整帧不重绘，空闲 GPU 归零。
     * 代价：输入环在静止态不再「呼吸」（仅在思考/打字时呼吸），属可接受的微小视觉损失。
     *
     * @param {number} now - requestAnimationFrame 时间戳
     * @returns {boolean}
     */
    shouldRedraw(now) {
        if (state.waiting) return true;   // AI 思考：呼吸环持续脉冲
        if (this._dirty) return true;     // 文本/布局变化待重画
        if (this._animating) return true; // 线长插值未收敛
        return false;                     // 空闲：整帧不重绘
    }
};

// 文本布局缓存 — 避免每帧重复 measureText（60fps 下省 ~120 次/秒）
/** 文本测量缓存对象 @type {object} */
export const textCache = {
    /** 缓存键：fullText + fontSize + maxLen @type {string} */
    key: '',
    /** 截断后实际显示的文本 @type {string} */
    displayText: '',
    /** 显示文本宽度 @type {number} */
    displayWidth: 0,
    /** 完整文本 @type {string} */
    fullText: '',
    /** 完整文本宽度 @type {number} */
    fullWidth: 0,

    /** 文本或布局参数变化时更新缓存 @param {string} fullText @param {number} fontSize @param {number} maxLen @param {CanvasRenderingContext2D} ctx */
    update(fullText, fontSize, maxLen, ctx) {
        const key = fullText + '|' + fontSize + '|' + maxLen;
        if (key === this.key) return; // 未变化，跳过

        this.key = key;
        this.fullText = fullText;
        ctx.font = `${fontSize}px Georgia,'KaiTi',serif`;

        const maxTextWidth = maxLen - 24;
        const fullWidth = ctx.measureText(fullText).width;
        this.fullWidth = fullWidth;

        // 超长时截取「尾部最长、宽度不超 maxTextWidth 的子串」显示（保留正在输入的尾部，丢弃开头历史超长部分）。
        // 旧实现逐字 displayText.slice(1) 后 measureText：每次 measure 内部要处理整串、共 O(n²) 字符测量，
        // 长粘贴（maxCharsPerNode=50000）会卡顿且吃掉开头。现用二分定长，measureText 仅 O(log n) 次。
        let displayText = fullText;
        if (fullWidth > maxTextWidth && fullText.length > 1) {
            let lo = 1, hi = fullText.length; // lo 从 1 起：至少保留 1 字（与原 slice(1) 兜底语义一致）
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                const w = ctx.measureText(fullText.slice(fullText.length - mid)).width;
                if (w <= maxTextWidth) lo = mid;
                else hi = mid - 1;
            }
            displayText = fullText.slice(fullText.length - lo);
        }
        this.displayText = displayText;
        this.displayWidth = ctx.measureText(displayText).width;
    },

    /** 清除缓存（强制下次重算） */
    invalidate() { this.key = ''; }
};

/**
 * 绘制输入区域到 UI Canvas
 * 包含：脉冲圆环、输入线条、装饰点、文本、光标
 * @param {number} now - requestAnimationFrame 时间戳
 */
export function drawInputArea(now) {
    const ctx = uiCtx;
    ctx.clearRect(0, 0, W, H);
    const b = inputState;

    const fullText = inputManager.text + (inputManager.composing ? inputManager.compData : "");
    const fontSize = 16; // 字号设置已移除（2026-08-16），固定默认 16px，与 DOM.hiddenInput 一致
    ctx.font = `${fontSize}px Georgia,'KaiTi',serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    // 文本布局缓存 — 仅在文本/字号/布局变化时重算 measureText
    textCache.update(fullText, fontSize, b.maxLen, ctx);
    const displayText = textCache.displayText;
    const displayWidth = textCache.displayWidth;

    // 输入线条长度平滑动画
    const targetLen = Math.max(50, displayWidth + 24);
    b.curLen += (targetLen - b.curLen) * 0.12;
    inputRenderer.setAnimating(Math.abs(targetLen - b.curLen) > 0.5);

    // 脉冲圆环 — 等待状态时增强
    if (state.waiting) {
        ctx.strokeStyle = inputColors.ringWaiting;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(b.startX - 6, b.y, 14 + 3 * Math.sin(now * 0.006), 0, TAU);
        ctx.stroke();
    } else {
        ctx.strokeStyle = inputColors.ringNormal;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(b.startX - 6, b.y, 12 + 2 * Math.sin(now * 0.004), 0, TAU);
        ctx.stroke();
    }

    // 输入线条
    ctx.strokeStyle = inputColors.line;
    ctx.lineWidth = 1 + Math.min(3, fullText.length * 0.04);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(b.startX, b.y);
    ctx.lineTo(b.startX + b.curLen, b.y);
    ctx.stroke();

    // 装饰性点
    for (let d = 25; d < b.curLen; d += 30) {
        ctx.fillStyle = inputColors.dot;
        ctx.beginPath();
        ctx.ellipse(b.startX + d, b.y, 3, 1.5, 0, 0, TAU);
        ctx.fill();
    }

    // 已按当前最新状态绘制完毕 → 清除脏标记，避免空闲态被 shouldRedraw 误判为仍需重绘。
    // 后续文本/布局变化会经 markDirty() 重新置脏触发下一帧。
    inputRenderer._dirty = false;

}
