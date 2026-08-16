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

// ---- 模板：输入框 Canvas 配色 ----
/** 深色组输入框配色（默认暗底暖色系） @type {object} */
export const DARK_INPUT = {
    '--input-ring-normal': 'rgba(200,220,180,.15)',
    '--input-ring-waiting': 'rgba(240, 180, 100, .25)',
    '--input-line': 'rgba(201,127,74,.6)',
    '--input-dot': 'rgba(212,163,115,.3)',
    '--input-text': 'rgba(240,208,160,.95)',
    '--input-cursor': 'rgba(240,208,160,.8)'
};
/** 浅色组输入框配色（浅底深色字/线） @type {object} */
export const LIGHT_INPUT = {
    '--input-ring-normal': 'rgba(30, 50, 80, .15)',
    '--input-ring-waiting': 'rgba(200, 140, 60, .35)',
    '--input-line': 'rgba(160, 100, 60, .55)',
    '--input-dot': 'rgba(30, 50, 80, .18)',
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
    '--white-a08': 'rgba(0,0,0,.13)', '--white-a10': 'rgba(0,0,0,.16)', '--white-a20': 'rgba(0,0,0,.32)',
    '--white-a30': 'rgba(0,0,0,.48)', '--white-a35': 'rgba(0,0,0,.55)', '--white-a40': 'rgba(0,0,0,.6)', '--white-a45': 'rgba(0,0,0,.65)', '--white-a50': 'rgba(0,0,0,.7)',
    '--white-a60': 'rgba(0,0,0,.8)', '--white-a70': 'rgba(0,0,0,.85)', '--white-a80': 'rgba(0,0,0,.9)', '--white-a90': 'rgba(0,0,0,.95)'
}

// ---- 模板：气泡底色 cssText（默认气泡透明，必须注入底色才有「气泡」视觉） ----
/** 深色组气泡底色（半透明白底，AI 略浅 user 略深） @type {string} */
export const DARK_BUBBLE_CSS = `.chat-bubble--ai{background:rgba(255,255,255,.06);padding:10px 14px}.chat-bubble--user{background:rgba(255,255,255,.1);padding:10px 14px}`;
/** 浅色组气泡底色（半透明深底） @type {string} */
export const LIGHT_BUBBLE_CSS = `.chat-bubble--ai{background:rgba(0,0,0,.04);padding:10px 14px}.chat-bubble--user{background:rgba(0,0,0,.07);padding:10px 14px}`;

/**
 * 快速配色表：键 = 配色名（存 settings.quickTheme，显示为圆点 title），
 * 值 = { swatch, tokens, cssText }。
 * @type {object<string, {swatch: string, tokens: object<string,string>, cssText: string}>}
 */
export const QUICK_THEMES = {
    // ---- 深色系 ----
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
    },
    '暗夜紫': {
        swatch: '#14121A',
        cssText: DARK_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#14121A',
            '--color-user': 'rgba(232,230,240,.95)', '--color-ai': 'rgba(184,182,200,.95)',
            '--color-accent': 'rgba(167,139,250,.9)', '--color-accent-soft': 'rgba(167,139,250,.15)',
            '--color-accent-bright': 'rgba(200,180,255,.9)', '--color-accent-solid': 'rgba(167,139,250,1)',
            '--color-accent-glow': 'rgba(167,139,250,.45)', '--color-accent-dim': 'rgba(167,139,250,.28)',
            '--color-user-bright': 'rgba(220,208,250,.9)', '--color-error': 'rgba(229,72,77,.9)',
            ...DARK_INPUT, ...buildModalTokens('#14121A', false)
        }
    },
    '深海蓝': {
        swatch: '#1B2A47',
        cssText: DARK_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#1B2A47',
            '--color-user': 'rgba(226,238,252,.95)', '--color-ai': 'rgba(180,200,225,.95)',
            '--color-accent': 'rgba(110,135,245,.92)', '--color-accent-soft': 'rgba(110,135,245,.15)',
            '--color-accent-bright': 'rgba(160,180,255,.92)', '--color-accent-solid': 'rgba(110,135,245,1)',
            '--color-accent-glow': 'rgba(110,135,245,.45)', '--color-accent-dim': 'rgba(110,135,245,.28)',
            '--color-user-bright': 'rgba(230,210,150,.9)', '--color-error': 'rgba(229,72,77,.9)',
            ...DARK_INPUT, ...buildModalTokens('#1B2A47', false)
        }
    },
    '焦糖棕': {
        swatch: '#3E2723',
        cssText: DARK_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#3E2723',
            '--color-user': 'rgba(239,235,233,.95)', '--color-ai': 'rgba(215,204,200,.95)',
            '--color-accent': 'rgba(255,171,145,.9)', '--color-accent-soft': 'rgba(255,171,145,.14)',
            '--color-accent-bright': 'rgba(255,190,170,.9)', '--color-accent-solid': 'rgba(255,171,145,1)',
            '--color-accent-glow': 'rgba(255,171,145,.4)', '--color-accent-dim': 'rgba(255,171,145,.25)',
            '--color-user-bright': 'rgba(255,190,170,.9)', '--color-error': 'rgba(239,83,80,.9)',
            ...DARK_INPUT, ...buildModalTokens('#3E2723', false)
        }
    },
    '敦煌红': {
        swatch: '#8B3A3A',
        cssText: DARK_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#8B3A3A',
            '--color-user': 'rgba(255,239,213,.95)', '--color-ai': 'rgba(240,217,181,.95)',
            '--color-accent': 'rgba(222,82,72,.92)', '--color-accent-soft': 'rgba(222,82,72,.15)',
            '--color-accent-bright': 'rgba(255,130,120,.92)', '--color-accent-solid': 'rgba(222,82,72,1)',
            '--color-accent-glow': 'rgba(222,82,72,.45)', '--color-accent-dim': 'rgba(222,82,72,.28)',
            '--color-user-bright': 'rgba(255,239,213,.9)', '--color-error': 'rgba(255,120,100,.95)',
            ...DARK_INPUT, ...buildModalTokens('#8B3A3A', false)
        }
    },
    // ---- 浅色系 ----
    '米兰白': {
        swatch: '#F0F4F8',
        cssText: LIGHT_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#F0F4F8',
            '--color-user': 'rgba(44,62,80,.95)', '--color-ai': 'rgba(70,90,110,.95)',
            '--color-accent': 'rgba(216,140,92,.95)', '--color-accent-soft': 'rgba(216,140,92,.12)',
            '--color-accent-bright': 'rgba(169,106,62,.95)', '--color-accent-solid': 'rgba(183,110,62,1)',
            '--color-accent-glow': 'rgba(216,140,92,.35)', '--color-accent-dim': 'rgba(216,140,92,.25)',
            '--color-user-bright': 'rgba(201,123,74,.95)', '--color-error': 'rgba(229,72,77,.95)',
            ...LIGHT_INPUT, ...buildModalTokens('#F0F4F8', true), ...LIGHT_WHITE_ALPHA
        }
    },
    '莫兰迪': {
        swatch: '#E5E5E0',
        cssText: LIGHT_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#E5E5E0',
            '--color-user': 'rgba(74,74,69,.95)', '--color-ai': 'rgba(92,92,86,.95)',
            '--color-accent': 'rgba(138,154,135,.95)', '--color-accent-soft': 'rgba(138,154,135,.14)',
            '--color-accent-bright': 'rgba(107,123,104,.95)', '--color-accent-solid': 'rgba(107,123,104,1)',
            '--color-accent-glow': 'rgba(138,154,135,.35)', '--color-accent-dim': 'rgba(138,154,135,.25)',
            '--color-user-bright': 'rgba(107,123,104,.95)', '--color-error': 'rgba(181,123,123,.95)',
            ...LIGHT_INPUT, ...buildModalTokens('#E5E5E0', true), ...LIGHT_WHITE_ALPHA
        }
    },
    '青竹翠': {
        swatch: '#E8F5E9',
        cssText: LIGHT_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#E8F5E9',
            '--color-user': 'rgba(27,94,32,.95)', '--color-ai': 'rgba(46,125,50,.95)',
            '--color-accent': 'rgba(76,140,80,.95)', '--color-accent-soft': 'rgba(76,140,80,.12)',
            '--color-accent-bright': 'rgba(27,94,32,.9)', '--color-accent-solid': 'rgba(46,125,50,1)',
            '--color-accent-glow': 'rgba(76,140,80,.3)', '--color-accent-dim': 'rgba(76,140,80,.22)',
            '--color-user-bright': 'rgba(27,94,32,.9)', '--color-error': 'rgba(211,47,47,.95)',
            ...LIGHT_INPUT, ...buildModalTokens('#E8F5E9', true), ...LIGHT_WHITE_ALPHA
        }
    },
    '燕麦色': {
        swatch: '#EFEBE9',
        cssText: LIGHT_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#EFEBE9',
            '--color-user': 'rgba(62,39,35,.95)', '--color-ai': 'rgba(78,52,46,.95)',
            '--color-accent': 'rgba(93,64,55,.95)', '--color-accent-soft': 'rgba(93,64,55,.12)',
            '--color-accent-bright': 'rgba(62,39,35,.9)', '--color-accent-solid': 'rgba(93,64,55,1)',
            '--color-accent-glow': 'rgba(93,64,55,.3)', '--color-accent-dim': 'rgba(93,64,55,.22)',
            '--color-user-bright': 'rgba(62,39,35,.9)', '--color-error': 'rgba(211,47,47,.95)',
            ...LIGHT_INPUT, ...buildModalTokens('#EFEBE9', true), ...LIGHT_WHITE_ALPHA
        }
    },
    '珊瑚粉': {
        swatch: '#FFF0F0',
        cssText: LIGHT_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#FFF0F0',
            '--color-user': 'rgba(106,27,42,.95)', '--color-ai': 'rgba(142,36,53,.95)',
            '--color-accent': 'rgba(184,120,110,.95)', '--color-accent-soft': 'rgba(184,120,110,.12)',
            '--color-accent-bright': 'rgba(106,27,42,.9)', '--color-accent-solid': 'rgba(184,120,110,1)',
            '--color-accent-glow': 'rgba(184,120,110,.3)', '--color-accent-dim': 'rgba(184,120,110,.22)',
            '--color-user-bright': 'rgba(142,36,53,.9)', '--color-error': 'rgba(211,47,47,.95)',
            ...LIGHT_INPUT, ...buildModalTokens('#FFF0F0', true), ...LIGHT_WHITE_ALPHA
        }
    },
    '雾蓝脏粉': {
        swatch: '#8AA9B8',
        cssText: LIGHT_BUBBLE_CSS,
        tokens: {
            '--color-bg': '#8AA9B8',
            '--color-user': 'rgba(30,50,70,.95)', '--color-ai': 'rgba(40,60,80,.95)',
            '--color-accent': 'rgba(212,165,165,.95)', '--color-accent-soft': 'rgba(212,165,165,.16)',
            '--color-accent-bright': 'rgba(242,226,213,.95)', '--color-accent-solid': 'rgba(212,165,165,1)',
            '--color-accent-glow': 'rgba(212,165,165,.4)', '--color-accent-dim': 'rgba(212,165,165,.28)',
            '--color-user-bright': 'rgba(242,226,213,.95)', '--color-error': 'rgba(200,70,70,.95)',
            ...LIGHT_INPUT, ...buildModalTokens('#8AA9B8', true), ...LIGHT_WHITE_ALPHA
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
