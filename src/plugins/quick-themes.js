/**
 * 快速配色数据表（宿主内置，非插件）
 *
 * 来源：文档/拍板/GLM最终方案.txt（色系数据自 色系.html / v4.html 精选映射）。
 * 机制：每组 = swatch（圆点色）+ tokens（CSS 变量覆盖）+ cssText（气泡底色等宿主默认外观）。
 *       applyQuickTheme 包装成主题对象走 ThemeEngine.register + mount（与用户主题插件同通道）。
 *
 * 映射规则（人工定稿）：
 *   - --color-bg            ← 色板主背景色
 *   - --color-user/--color-ai ← 前景文字色：深背景配浅字、浅背景配深字
 *   - --color-accent*       ← 强调色系（bright/solid/glow/dim/soft）
 *   - --color-user-bright   ← 用户侧强调提亮
 *   - --color-error         ← 错误/警示红
 *   - --input-*             ← 输入框 Canvas 绘制配色（随背景明暗微调）
 *   - --bg-modal/--bg-select/--bg-input ← 模态框/下拉/全屏编辑器背景：深浅配色一致，统一由 buildModalTokens(baseHex, isLight) 直接以主题基色（--color-bg）为底色（rgba(base, 0.96/0.98/0.98)）生成，不掺白、不借用强调色、不做 color-mix（用户要求原汁原味）；仅 --modal-elevation 浅/深数值不同（浅色基色近白需更强调才「浮起」）。
 *   - 浅色组额外覆盖 --white-a* 为同透明度黑色（浅背景上白色透明文字不可见）
 *   - cssText 给 .chat-bubble--ai/--user 注入底色+内边距（默认气泡透明，不给底色=「气泡消失」）
 *
 * 契约：全部 token 名均在 hooks.json 白名单内（含刻意新增的 --modal-elevation 模态框浮起投影 token，hooks.json 已登记）；不再新增其它 token。
 * 注：radius / transition / black-alpha 系列保持全局默认，不在此覆盖。
 */

// ---- 模板：输入框文字配色 ----
/** 深色组输入框配色（漆夜金暖白文字/光标） @type {object} */
export const DARK_INPUT = {
    '--input-text': 'rgba(232,230,227,.95)',
    '--input-cursor': 'rgba(232,230,227,.8)'
};
/** 浅色组输入框配色（浅底深色字） @type {object} */
export const LIGHT_INPUT = {
    '--input-text': 'rgba(30, 50, 80, .95)',
    '--input-cursor': 'rgba(30, 50, 80, .8)'
};

// ---- 模板：模态框/面板背景（深浅共用单一函数） ----
// 历史：旧版浅色曾用 color-mix(#fff + 基色/强调色) 给弹窗染色/掺白，深色则 rgba(基色,0.96) 直填，两套写法不一致且浅色改了用户的色。
// 现统一：深浅都直接以 --color-bg（主题基色）为底色（rgba(base,0.96/0.98/0.98)），不走 color-mix、不掺白、不借用强调色。
// 分离感由 --modal-elevation（强调色描边/光晕）提供，不靠改色。
// 深浅仅 --modal-elevation 数值不同：浅色基色近白，需 18px 光晕+2px 描边才显「浮起」；深色用 14px 光晕+1px 描边。

/** #rrggbb → [r,g,b] @param {string} h @returns {number[]} */
function hexToRgbArr(h) {
    const n = parseInt(String(h).replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 生成弹窗/下拉/全屏编辑器背景 token（深浅配色共用，保证逻辑单一、修一处即全局生效）。
 * 底色直接以主题基色（--color-bg）为底色：--bg-modal rgba(base,0.96) / --bg-select rgba(base+6,0.98) / --bg-input rgba(base-4,0.98)。
 * --modal-elevation：浅色组 18px 光晕+2px 描边；深色组 14px 光晕+1px 描边。
 * @param {string} baseHex - 主题基色 #rrggbb
 * @param {boolean} isLight - 是否浅色配色（决定 --modal-elevation 数值）
 * @returns {object} 含 --bg-modal/--bg-select/--bg-input/--modal-elevation
 */
export function buildModalTokens(baseHex, isLight) {
    const [r, g, b] = hexToRgbArr(baseHex);
    const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return {
        '--bg-modal': `rgba(${r},${g},${b},0.96)`,
        '--bg-select': `rgba(${cl(r + 6)},${cl(g + 6)},${cl(b + 6)},0.98)`,
        '--bg-input': `rgba(${cl(r - 4)},${cl(g - 4)},${cl(b - 4)},0.98)`,
        '--modal-elevation': isLight
            ? '0 0 18px var(--color-accent-glow), 0 0 0 2px var(--color-accent-glow)'
            : '0 0 14px var(--color-accent-glow), 0 0 0 1px var(--color-accent-glow)'
    };
}

// ---- 模板：白色透明度序列覆盖（浅色组专用） ----
/** 浅色组把 --white-a* 覆盖为同透明度黑色（浅背景上白色透明文字不可见） @type {object} */
export const LIGHT_WHITE_ALPHA = {
    '--white-a03': 'rgba(0,0,0,.05)', '--white-a05': 'rgba(0,0,0,.08)', '--white-a06': 'rgba(0,0,0,.10)',
    '--white-a08': 'rgba(0,0,0,.13)', '--white-a10': 'rgba(0,0,0,.16)', '--white-a12': 'rgba(0,0,0,.19)', '--white-a20': 'rgba(0,0,0,.32)',
    '--white-a30': 'rgba(0,0,0,.48)', '--white-a35': 'rgba(0,0,0,.55)', '--white-a40': 'rgba(0,0,0,.6)', '--white-a45': 'rgba(0,0,0,.65)', '--white-a50': 'rgba(0,0,0,.7)',
    '--white-a60': 'rgba(0,0,0,.8)', '--white-a70': 'rgba(0,0,0,.85)', '--white-a80': 'rgba(0,0,0,.9)', '--white-a90': 'rgba(0,0,0,.95)'
}

// ---- 模板：气泡底色 cssText（默认气泡透明，必须注入底色才有「气泡」视觉） ----
// alpha 均以 calc(α * var(--bubble-opacity)) 书写：吃「消息气泡不透明度」滑块（:root token，tree.js applyBubbleOpacity 写入），
// 与默认皮肤 waifu.css / 语音条 tts.css / 错误泡 chat.css 同一消费模式（契约见 tokens.css 与 PLUGIN_CONTRACT.md）。
/** 深色组气泡底色（半透明白底，AI 略浅 user 略深） @type {string} */
export const DARK_BUBBLE_CSS = `.chat-bubble--ai{background:rgba(255,255,255,calc(.06 * var(--bubble-opacity)));padding:10px 14px}.chat-bubble--user{background:rgba(255,255,255,calc(.1 * var(--bubble-opacity)));padding:10px 14px}`;
/** 浅色组气泡底色（半透明深底） @type {string} */
export const LIGHT_BUBBLE_CSS = `.chat-bubble--ai{background:rgba(0,0,0,calc(.04 * var(--bubble-opacity)));padding:10px 14px}.chat-bubble--user{background:rgba(0,0,0,calc(.07 * var(--bubble-opacity)));padding:10px 14px}`;

/**
 * 快速配色表：键 = 配色名（存 settings.quickTheme，显示为圆点 title），
 * 值 = { swatch, tokens, cssText }。
 * @type {object<string, {swatch: string, tokens: object<string,string>, cssText: string}>}
 */
export const QUICK_THEMES = {
    // 漆夜金（唯一配色，也是 tokens.css :root 默认主题）
    '漆夜金': {
        swatch: '#0E1014',
        cssText: DARK_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#0E1014',
            '--color-user': 'rgba(232,230,227,.95)', '--color-ai': 'rgba(200,200,205,.95)',
            '--color-accent': 'rgba(232,230,227,.9)', '--color-accent-soft': 'rgba(232,230,227,.12)',
            '--color-accent-bright': 'rgba(255,255,255,.9)', '--color-accent-solid': 'rgba(255,255,255,1)',
            '--color-accent-glow': 'rgba(232,230,227,.4)', '--color-accent-dim': 'rgba(232,230,227,.25)',
            '--color-user-bright': 'rgba(232,230,227,.9)', '--color-error': 'rgba(229,72,77,.9)',
            ...DARK_INPUT, ...buildModalTokens('#0E1014', false)
        }
    }
};

/**
 * 计算 CSS 颜色值的感知亮度（0~255），用于判定背景明暗。
 * 支持 hex(#rrggbb) 与 rgba() 两种格式；rgba 取 RGB 通道（忽略 alpha）。
 * 算法与色系.html 的 getBrightness 一致：0.299R + 0.587G + 0.114B。
 * @param {string} cssColor - CSS 颜色值（'#F0F4F8' 或 'rgba(8,11,20,.4)'）
 * @returns {number} 亮度值，0=纯黑 255=纯白；解析失败返回 255（按浅色兜底）
 */
export function getCssBrightness(cssColor) {
    const s = String(cssColor || '').trim();
    const hex = s.match(/^#([0-9a-fA-F]{6})$/);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return (0.299 * ((n >> 16) & 255)) + (0.587 * ((n >> 8) & 255)) + (0.114 * (n & 255));
    }
    const rgba = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgba) {
        return (0.299 * +rgba[1]) + (0.587 * +rgba[2]) + (0.114 * +rgba[3]);
    }
    return 255;
}
