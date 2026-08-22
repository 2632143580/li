const MINIMAL_PATH = 'M2 12 C4 12 4 12 6 12 L8 12 L9 5 L11 19 L13 3 L15 16 L17 12 L22 12';

export function buildMinimalThinkSvg(emotion = 'calm') {
    // 与 ECG 组件共用四态命名，避免极简形态退化成只有快/慢两种表现。
    const emotionClass = ['calm', 'excited', 'sad', 'thinking'].includes(emotion) ? emotion : 'calm';
    return `<svg class="rk-think-icon rk-think-minimal ${emotionClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${MINIMAL_PATH}" /></svg>`;
}
