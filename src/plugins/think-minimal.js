const MINIMAL_PATH = 'M2 12 C4 12 4 12 6 12 L8 12 L9 5 L11 19 L13 3 L15 16 L17 12 L22 12';

export function buildMinimalThinkSvg(emotion = '') {
    const speedClass = emotion === 'fast' ? 'fast' : 'slow';
    return `<svg class="rk-think-icon rk-think-minimal ${speedClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${MINIMAL_PATH}" /></svg>`;
}
