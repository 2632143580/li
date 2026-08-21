/**
 * 思维链图标插件：爱心 + 心电图波形（监护仪式），纯图标无文字。
 *
 * 设计来源：用户上传的 love.svg（白色爱心 + 黑色心电图折线合体图）。
 * 去黑底 rect，颜色交主题：爱心 fill 用 --color-accent，心电图 stroke 用 --color-accent。
 *
 * 关键：爱心与心电图是「两个独立组件」——
 *   - buildHeartSvg() 只产爱心（取自用户 love.svg 的 path），可独立复用 / 单独定位。
 *   - buildEcgSvg(emotion) 只产心电图折线（按情绪换波形），可独立复用 / 单独动画。
 *   - buildEcgHeartSvg() 仅做组合（两者并列），保持向后兼容；渲染层也可分别取两个组件自行排版。
 *
 * 情绪视觉挂钩（用户预留需求）：ECG_WAVEFORMS 按 emotion 返回不同波形 path，
 *   渲染层传 node._emotion（默认 'calm'）→ 后期接插件即可按情绪换波形，无需改渲染结构。
 *
 * 依赖：无
 */

/** 爱心路径（取自用户 love.svg，去黑底，fill 交主题）。 @type {string} */
export const HEART_PATH = 'M 50 30 C 50 25, 40 10, 25 20 C 10 30, 10 50, 30 65 C 40 75, 50 85, 50 85 C 50 85, 60 75, 70 65 C 90 50, 90 30, 75 20 C 60 10, 50 25, 50 30 Z';

/**
 * 心电图波形表（按情绪分档）。默认 calm = 用户 love.svg 的原始折线（单拍）。
 * 后期扩展：excited = 更密更高尖峰；sad = 趋于平直；thinking = 双峰……只在此追加，渲染层不动。
 * @type {Object<string,string>}
 */
export const ECG_WAVEFORMS = {
    calm:    'M 22 45 L 32 45 L 38 25 L 45 65 L 50 45 L 78 45',
    excited: 'M 18 45 L 26 45 L 30 18 L 36 72 L 42 45 L 58 45 L 62 18 L 68 72 L 74 45 L 82 45',
    thinking:'M 20 45 L 30 45 L 34 30 L 40 60 L 46 45 L 54 45 L 60 28 L 66 62 L 72 45 L 80 45',
    sad:     'M 22 48 L 40 48 L 50 52 L 60 48 L 78 48'
};

/**
 * 爱心组件（独立 <svg>）：取自用户 love.svg 的白色爱心 path，fill 交主题色。
 * @returns {string} 内联 SVG 字符串
 */
export function buildHeartSvg() {
    return '<svg class="rk-ico rk-heart-ico" viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
        + '<path class="rk-heart" d="' + HEART_PATH + '"/></svg>';
}

/**
 * 心电图组件（独立 <svg>）：按情绪取波形 path，stroke 交主题色。与爱心是两个独立组件。
 * @param {string} [emotion='calm'] 情绪键，决定心电图波形（见 ECG_WAVEFORMS）
 * @returns {string} 内联 SVG 字符串
 */
export function buildEcgSvg(emotion = 'calm') {
    const wave = ECG_WAVEFORMS[emotion] || ECG_WAVEFORMS.calm;
    return '<svg class="rk-ico rk-ecg-ico" viewBox="0 0 100 100" aria-hidden="true" focusable="false" preserveAspectRatio="none">'
        + '<path class="rk-ecg" d="' + wave + '"/></svg>';
}

/**
 * 组合（向后兼容）：爱心 + 心电图 两个独立 <svg> 并列。
 * 渲染层也可改用 buildHeartSvg() / buildEcgSvg() 单独取两个组件自行排版。
 * @param {string} [emotion='calm'] 情绪键
 * @returns {string} 内联 SVG 字符串
 */
export function buildEcgHeartSvg(emotion = 'calm') {
    return buildHeartSvg() + buildEcgSvg(emotion);
}
