const MINIMAL_PATH = 'M2 12 C4 12 4 12 6 12 L8 12 L9 5 L11 19 L13 3 L15 16 L17 12 L22 12';

/**
 * 构建 Kimi 极简流光 SVG。
 * @param {string} [emotion='calm'] 情绪：calm/excited/sad/thinking（决定动画速度/颜色，见 chat.css）
 * @param {string} [size='md'] 尺寸：xs/sm/md/lg/xl（与 ECG 监护仪共用尺寸档，决定宽高/描边）
 * @returns {string} SVG HTML 字符串
 */
export function buildMinimalThinkSvg(emotion = 'calm', size = 'md') {
    // 与 ECG 组件共用四态命名，避免极简形态退化成只有快/慢两种表现。
    const emotionClass = ['calm', 'excited', 'sad', 'thinking'].includes(emotion) ? emotion : 'calm';
    const sizeClass = ['xs', 'sm', 'md', 'lg', 'xl'].includes(size) ? size : 'md';
    return `<svg class="rk-think-icon rk-think-minimal ${emotionClass} sz-${sizeClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${MINIMAL_PATH}" /></svg>`;
}
