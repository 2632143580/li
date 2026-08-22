/**
 * 爱心图标（独立模块，2026-08-23 从 ecg-heart.js 拆出）。
 *
 * 拆出的目的：把爱心作为独立可替换单元，便于后期单独更换/扩展爱心样式
 * （如换形状、换内部折线、甚至多套爱心按设置切换），而不动波形组件。
 *
 * 颜色不写死，改由 .rk-love-* class 走 rk-love-* 主题令牌（chat.css 定义），随深浅主题自适应：
 *   surface=主题背景、heart=主题色、line=底块同色镂空刻进爱心（深浅皆可见）。
 * 这是「爱心 + 它里面的折线」——它俩是一体的，恒显，不受任何开关控制。
 *
 * 导出：buildLoveSvg（内联 SVG 字符串）。
 */

/** love-svg.txt 原始两元素（100% 还原，顺序与属性不变）：爱心 path + 其内部爱心折线 path。 */
const LOVE_HEART_PATH = 'M 50 30 C 50 25, 40 10, 25 20 C 10 30, 10 50, 30 65 C 40 75, 50 85, 50 85 C 50 85, 60 75, 70 65 C 90 50, 90 30, 75 20 C 60 10, 50 25, 50 30 Z';
const LOVE_ECG_PATH = 'M 22 45 L 32 45 L 38 25 L 45 65 L 50 45 L 78 45';

/**
 * love.svg 组件（恒显）：love-svg.txt 几何原样（100×100 viewBox、爱心/心电折线 path、round 端点）。
 * @returns {string} 内联 SVG 字符串
 */
export function buildLoveSvg() {
    return '<svg class="rk-love-ico" viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
        + '<rect class="rk-love-bg" width="100" height="100" />'
        + '<path class="rk-love-heart" d="' + LOVE_HEART_PATH + '" />'
        + '<path class="rk-love-ecg" d="' + LOVE_ECG_PATH + '" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />'
        + '</svg>';
}
