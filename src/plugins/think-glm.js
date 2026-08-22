/**
 * GLM 双线流光思维链图标（源自 ffffffff/组件glm.html 的 think-icon）。
 *
 * 视觉：一条 SVG 路径画两遍——
 *   ① track：暗底轨迹（opacity 0.15），勾勒波形轮廓；
 *   ② flow：高亮脉冲（stroke-dasharray + dashoffset 动画），沿轨迹流动。
 * 与 Kimi 单线流光(think-minimal)的区别：GLM 有暗底轨迹衬底，Kimi 只有单条脉冲线。
 *
 * 颜色：继承 currentColor（随父元素文字色自适应深浅气泡），非思考态由 CSS 暂停动画(见 chat.css .reasoning:not(.thinking))。
 * 情绪：四态共用同一路径，仅动画速度/颜色不同（对齐 think-minimal 的 calm/excited/sad/thinking）。
 * 尺寸：与 ECG/Kimi 共用 ecgSize（xs/sm/md/lg/xl）。
 *
 * 依赖：无（纯 SVG 字符串）
 */

/** 波形路径（与组件glm.html 一致：平段+尖峰） */
const GLM_PATH = 'M2,10 H14 L16,5 L18,15 L20,7 L22,10 H38';

/**
 * 构建 GLM 双线流光 SVG。
 * @param {string} [emotion='calm'] 情绪：calm/excited/sad/thinking（决定动画速度/颜色，见 chat.css）
 * @param {string} [size='md'] 尺寸：xs/sm/md/lg/xl
 * @returns {string} SVG HTML 字符串
 */
export function buildGlmThinkSvg(emotion = 'calm', size = 'md') {
    const emotionClass = ['calm', 'excited', 'sad', 'thinking'].includes(emotion) ? emotion : 'calm';
    const sizeClass = ['xs', 'sm', 'md', 'lg', 'xl'].includes(size) ? size : 'md';
    // track + flow 共用同一路径，flow 叠加 dash 动画；currentColor 继承父色，暗底轨迹 opacity 0.15
    return `<svg class="rk-think-icon rk-think-glm ${emotionClass} sz-${sizeClass}" viewBox="0 0 40 20" aria-hidden="true" focusable="false">`
        + `<path class="track" d="${GLM_PATH}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.15"/>`
        + `<path class="flow" d="${GLM_PATH}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="8 38"/>`
        + `</svg>`;
}
