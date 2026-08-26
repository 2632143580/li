// ================================================================
//  快速配色（色块选择器，第 3 步）
//  数据源 plugins/quick-themes.js；应用走 ThemeEngine 通道（与用户导入的主题插件同路）。
//  点击内置色块 → applyQuickTheme：唯一槽位切换 + 持久化 quickTheme。星空插件已移除，背景现为纯 CSS 底色，无需在此同步/卸载动画背景。
//  自定义配色：色块条末尾的「+」圆点 → 底部抽屉粘贴颜色代码 → 持久化(localStorage 独立键) + 应用 + 启动恢复 + 删除（桌面右键色块 / 移动端抽屉内列表按钮）。
//  单色方案另带「撞色强度」滑块（创建表单 + 已保存列表每项各一），按方案持久化；多色/渐变无单色跳色故不显示。
// ================================================================

/**
 * 快速配色事件绑定与配色应用（Stage 3 解耦产出，原 quick-theme 段落）。
 * 依赖 DOM 门面、state、ThemeEngine、plugins/quick-themes、storage。
 */
import { DOM } from '../../core/dom.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { Logger } from '../../core/logger.js';
import { armClickConfirm } from './click-confirm.js';
import { state } from '../../core/store.js';
import { ThemeEngine } from '../../engines/theme-engine.js';
import {
    QUICK_THEMES, getCssBrightness,
    DARK_INPUT, LIGHT_INPUT, DARK_BUBBLE_CSS, LIGHT_BUBBLE_CSS, LIGHT_WHITE_ALPHA,
    buildModalTokens
} from '../../plugins/quick-themes.js';
import { saveToLocal } from '../../core/storage.js';

/** 当前快速配色在 ThemeEngine 中的注册 id（唯一槽位，切换前先卸载旧的） @type {string|null} */
let activeQuickThemeId = null;

/** 自定义配色持久化键名（独立于主存档白名单，避免被过滤） @type {string} */
const CUSTOM_KEY = 'li_custom_schemes';
/** 内存中的自定义配色列表 @type {Array<{id:string,name:string,swatch:string,cssText:string,tokens:object}>} */
let customSchemes = [];
/** 当前激活的自定义配色 id（null = 未激活） @type {string|null} */
let activeCustomId = null;
/** 创建表单里「撞色强度」滑块的当前值（用户气泡互补色调入页面的百分比，默认 56） @type {number} */
let currentCreateMix = 56;
/** 列表项滑块拖动时，待应用的方案 id（rAF 节流，避免拖动期间每帧重复挂载主题） @type {string|null} */
let pendingApplyId = null;
/** 当前挂起的 rAF 句柄（0 = 无） @type {number} */
let applyRaf = 0;

/**
 * 单槽挂载（内置 / 自定义共用一个 ThemeEngine 槽位，互斥）。
 * @param {{name:string, cssText:string, tokens:object}} scheme - 配色对象
 * @param {string} id - ThemeEngine 注册 id
 * @returns {void}
 */
function mountScheme(scheme, id) {
    if (activeQuickThemeId) {
        ThemeEngine.unmount(activeQuickThemeId);
        activeQuickThemeId = null;
    }
    ThemeEngine.register(id, { meta: { name: scheme.name, cssText: scheme.cssText, tokens: scheme.tokens } });
    ThemeEngine.mount(id);
    activeQuickThemeId = id;
}

/**
 * 应用快速配色（唯一槽位）：
 * 1. 若已有快速配色主题挂着 → 先 ThemeEngine.unmount（避免多组配色叠加打架）
 * 2. 用该组 tokens 包装成主题对象 → ThemeEngine.register + mount（与用户主题插件同通道）
 * 3. 持久化 settings.quickTheme（storage 白名单自动纳入）+ 刷新色块高亮
 * @param {string} name - QUICK_THEMES 的键（配色名）
 * @returns {boolean} 是否应用成功（QUICK_THEMES 无此键返回 false）
 */
export function applyQuickTheme(name) {
    const theme = QUICK_THEMES[name];
    if (!theme) return false;

    mountScheme(theme, 'quick_theme_' + name);
    state.settings.quickTheme = name;
    // 切到内置配色时清空自定义激活态（单槽互斥），并保留自定义列表
    activeCustomId = null;
    saveToLocal(name);
    saveCustomSchemes(null);
    refreshHighlights();
    return true;
}

/**
 * 应用自定义配色（用户粘贴生成）。
 * @param {string} id - 自定义配色 id
 * @returns {boolean} 是否应用成功
 */
export function applyCustomScheme(id) {
    const scheme = customSchemes.find(s => s.id === id);
    if (!scheme) return false;

    mountScheme(scheme, 'custom_theme_' + id);
    // 切到自定义配色时清空内置 quickTheme 记忆（单槽互斥），并存自定义激活态
    state.settings.quickTheme = null;
    activeCustomId = id;
    saveCustomSchemes(id);
    saveToLocal(null, true);
    refreshHighlights();
    return true;
}

// ================================================================
//  自定义配色：颜色代码解析与配色构建
// ================================================================

/** 把常见颜色写法归一化为 #rrggbb 或 rgb(r,g,b) @param {string} c @returns {string|null} */
function normalizeColor(c) {
    c = c.trim();
    if (c.startsWith('#')) {
        let h = c.slice(1);
        if (h.length === 3) h = h.split('').map(x => x + x).join('');
        if (h.length === 6 || h.length === 8) return '#' + h;
        return null;
    }
    const mm = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (mm) return `rgb(${mm[1]},${mm[2]},${mm[3]})`;
    return null;
}

/** 从任意文本中抽取所有颜色 token（hex / rgb / rgba） @param {string} str @returns {string[]} */
function extractColors(str) {
    const colors = [];
    const hexRe = /#[0-9a-fA-F]{3,8}/g;
    const rgbRe = /rgba?\([^)]*\)/gi;
    let m;
    while ((m = hexRe.exec(str))) colors.push(m[0]);
    while ((m = rgbRe.exec(str))) colors.push(m[0]);
    const seen = new Set();
    return colors.map(normalizeColor).filter(Boolean).filter(c => !seen.has(c) && seen.add(c));
}

/** 颜色 → [r,g,b,a] @param {string} c @returns {number[]|null} */
function toRgb(c) {
    if (c.startsWith('#')) {
        let h = c.slice(1);
        if (h.length === 3) h = h.split('').map(x => x + x).join('');
        if (h.length === 6) h += 'ff';
        if (h.length === 8) { /* 含 alpha，取 rgb 三通道 */ }
        const n = parseInt(h, 16);
        return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, (n >> 0) & 255];
    }
    const mm = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return mm ? [+mm[1], +mm[2], +mm[3], 255] : null;
}

/** [r,g,b] → #rrggbb @param {number[]} rgb @returns {string} */
function rgbToHex(rgb) {
    return '#' + rgb.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}

/** 多色求平均（用于渐变兜底底色与明暗判定） @param {number[][]} rgbs @returns {number[]} */
function avgColor(rgbs) {
    const n = rgbs.length;
    const s = rgbs.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
    return [s[0] / n, s[1] / n, s[2] / n];
}

/** 饱和度（0~1），用于挑选强调色 @param {number[]} rgb @returns {number} */
function saturation(rgb) {
    const max = Math.max(...rgb), min = Math.min(...rgb);
    return max === 0 ? 0 : (max - min) / max;
}

/** 数值夹取 @param {number} v @param {number} lo @param {number} hi @returns {number} */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * 把粘贴的颜色代码解析成完整配色对象（swatch / cssText / tokens）。
 * - 渐变约束：渐变只能进 cssText 的 body 规则，--color-bg 仍用纯色兜底（否则输入框 Canvas / color-mix 会崩）。
 * @param {string} code - 用户粘贴的内容
 * @param {number} [accentMix=56] - 用户气泡「互补跳色」混入页面底色的百分比（0~70），由抽屉滑块控制
 * @returns {{swatch:string, cssText:string, tokens:object}|null}
 */
function buildSchemeFromCode(code, accentMix = 56) {
    let trimmed = (code || '').trim();
    if (!trimmed) return null;
    // 容错：去掉 `background:` / `background-color:` 前缀与结尾分号（色系.html 等工具可能包裹成 `background: ...;`），
    // 否则会生成 `body{background:background:...}` 非法 CSS，导致渐变失效。
    trimmed = trimmed.replace(/^background(?:-color)?\s*:\s*/i, '').replace(/;+\s*$/, '');
    if (!trimmed) return null;
    const colors = extractColors(trimmed);
    if (colors.length === 0) return null;

    const isGradient = /gradient\(/i.test(trimmed) || colors.length > 1;
    let gradientCss = null;
    if (/gradient\(/i.test(trimmed)) {
        gradientCss = trimmed;
    } else if (colors.length > 1) {
        gradientCss = `linear-gradient(135deg, ${colors.join(', ')})`;
    }

    const rgbs = colors.map(toRgb).filter(Boolean);
    if (rgbs.length === 0) return null;
    const base = avgColor(rgbs);                 // 渐变/多色的兜底底色（单色不再用它做基色，见下）
    let baseHex = rgbToHex(base);

    // 单色新规则（用户拍板）：基色用默认主题基色（tokens.css :root 原版深色），
    // 用户贴的色填充「强调色」（小面交互高亮）——页面底色保持原版，不一片纯色；
    // 渐变/多色保留现状（渐变铺 body 大面 + avg 兜底基色）。
    const DEFAULT_BG_HEX = '#080b14';
    if (rgbs.length === 1) baseHex = DEFAULT_BG_HEX;
    // 主题明暗判定（根治浅底描边隐形的边界情况）：
    // 单色 = 基色固定默认深 → 恒为深色主题（白描边/浅文字）；
    // 渐变/多色 = 取【最暗色段】的亮度——渐变含暗段就按深色主题处理，
    // 避免「深渐变背景 + 浅主题黑描边」在暗段隐形（avg 平均色会掩盖暗段）。
    let isLight;
    if (rgbs.length === 1) {
        isLight = false;
    } else {
        isLight = Math.min(...rgbs.map(c => getCssBrightness(rgbToHex(c)))) >= 150;
    }

    // 强调色：单色 = 用户色（不再自动跳色——不可预期，替用户做色彩决策）；
    // 渐变/多色保留现状：取饱和度最高的一档（有多个色可依据，属确定性挑选）。
    let accentRgb;
    if (rgbs.length === 1) {
        accentRgb = rgbs[0];
    } else {
        accentRgb = rgbs[0];
        let bestSat = -1;
        for (const c of rgbs) { const s = saturation(c); if (s > bestSat) { bestSat = s; accentRgb = c; } }
    }
    // 强调色 RGB 统一夹取 0–255：用户粘贴 rgb(300,0,0) 这类越界写法时，
    // toRgb 不夹取会原样带出 300，使下方所有 rgba(${a[0]},...) token 变成非法 CSS（整组配色失效）。
    // 此处一次性夹取，覆盖 accent-bright/soft/solid/glow/dim/user-bright 全部派生 token。
    const a = accentRgb.map(v => Math.max(0, Math.min(255, Math.round(v))));

    const tokens = {};
    tokens['--color-bg'] = baseHex;
    if (isLight) {
        tokens['--color-user'] = 'rgba(44,62,80,.95)';
        tokens['--color-ai'] = 'rgba(70,90,110,.95)';
    } else {
        tokens['--color-user'] = 'rgba(232,230,227,.95)';
        tokens['--color-ai'] = 'rgba(200,200,205,.95)';
    }
    tokens['--color-accent'] = `rgba(${a[0]},${a[1]},${a[2]},.9)`;
    tokens['--color-accent-soft'] = `rgba(${a[0]},${a[1]},${a[2]},.14)`;
    tokens['--color-accent-bright'] = `rgba(${clamp(a[0] + 30, 0, 255)},${clamp(a[1] + 30, 0, 255)},${clamp(a[2] + 30, 0, 255)},.95)`;
    tokens['--color-accent-solid'] = `rgba(${a[0]},${a[1]},${a[2]},1)`;
    tokens['--color-accent-glow'] = `rgba(${a[0]},${a[1]},${a[2]},.4)`;
    tokens['--color-accent-dim'] = `rgba(${a[0]},${a[1]},${a[2]},.28)`;
    tokens['--color-user-bright'] = `rgba(${clamp(a[0] + 30, 0, 255)},${clamp(a[1] + 30, 0, 255)},${clamp(a[2] + 30, 0, 255)},.9)`;
    tokens['--color-error'] = isLight ? 'rgba(211,47,47,.95)' : 'rgba(229,72,77,.9)';

    if (isLight) {
        // 浅色自定义配色：弹窗背景直接以基色为底色（与深色自定义配色一致，原汁原味），
        // 不再做 color-mix 染色 / 掺白 / 借用强调色。
        Object.assign(tokens, buildModalTokens(baseHex, true));
        for (const k in LIGHT_WHITE_ALPHA) tokens[k] = LIGHT_WHITE_ALPHA[k];
        for (const k in LIGHT_INPUT) tokens[k] = LIGHT_INPUT[k];
    } else {
        Object.assign(tokens, buildModalTokens(baseHex, false));
        for (const k in DARK_INPUT) tokens[k] = DARK_INPUT[k];
    }

    // 气泡底色：单色方案把「互补跳色」混入页面底色着色用户气泡（混入比例 = accentMix，由抽屉「撞色强度」滑块控制；
    // AI 气泡用更淡的同跳色，比例固定为 round(accentMix*0.43)，保持与用户气泡一致的撞色观感），让整页看得到撞色层次，
    // 解决「单色全红、只有按钮有强调色」的问题；多色/渐变方案沿用原白/黑微调透明气泡（外观不变）。
    // alpha 全部吃 --bubble-opacity（消息气泡不透明度滑块；user 泡混的是不透明 --color-bg，需外层再叠一层 color-mix 降 alpha）。
    let bubbleCss;
    if (rgbs.length === 1) {
        bubbleCss = `.chat-bubble--ai{background:color-mix(in srgb, var(--color-accent) calc(${Math.round(accentMix * 0.43)}% * var(--bubble-opacity)), transparent);padding:10px 14px}`
                  + `.chat-bubble--user{background:color-mix(in srgb, color-mix(in srgb, var(--color-accent) ${accentMix}%, var(--color-bg)) calc(100% * var(--bubble-opacity)), transparent);padding:10px 14px}`;
    } else {
        bubbleCss = isLight ? LIGHT_BUBBLE_CSS : DARK_BUBBLE_CSS;
    }
    const cssText = (isGradient && gradientCss ? `body{background:${gradientCss}} ` : '') + bubbleCss;
    // swatch 圆点色：单色显示用户色（强调色），渐变显示渐变，多色用兜底基色
    const swatch = (isGradient && gradientCss) ? gradientCss : (rgbs.length === 1 ? rgbToHex(accentRgb) : baseHex);

    // isSingle：标记该方案是否为单色（仅单色才有「撞色强度」滑块；多色/渐变无单色跳色概念）
    return { swatch, cssText, tokens, isSingle: rgbs.length === 1 };
}

// ================================================================
//  自定义配色：持久化
// ================================================================

/** 从 localStorage 读取自定义配色列表与激活项 @returns {{schemes:object[], activeId:string|null}} */
function loadCustomSchemes() {
    try {
        const raw = localStorage.getItem(CUSTOM_KEY);
        if (!raw) return { schemes: [], activeId: null };
        const data = JSON.parse(raw);
        return {
            schemes: Array.isArray(data.schemes) ? data.schemes : [],
            activeId: data.activeId || null
        };
    } catch (e) {
        Logger.warn('[CustomScheme] 读取失败', e);
        return { schemes: [], activeId: null };
    }
}

/** 写入自定义配色列表与激活项 @param {string|null} activeId */
function saveCustomSchemes(activeId) {
    try {
        localStorage.setItem(CUSTOM_KEY, JSON.stringify({ schemes: customSchemes, activeId: activeId ?? null }));
    } catch (e) {
        Logger.warn('[CustomScheme] 保存失败', e);
    }
}

// ================================================================
//  渲染与高亮
// ================================================================

/** 渲染色块圆点（内置 + 自定义 + 「+」），并高亮当前选中项 @returns {void} */
function renderQuickThemePalette() {
    const palette = DOM.quickThemePalette;
    if (!palette) return;
    palette.innerHTML = '';
    // 内置配色
    for (const [name, theme] of Object.entries(QUICK_THEMES)) {
        const dot = document.createElement('div');
        dot.className = 'qt-dot';
        dot.dataset.qt = name;
        dot.style.setProperty('--swatch', theme.swatch);
        dot.title = name;
        palette.appendChild(dot);
    }
    // 自定义配色
    for (const scheme of customSchemes) {
        const dot = document.createElement('div');
        dot.className = 'qt-dot qt-custom';
        dot.dataset.cs = scheme.id;
        dot.style.setProperty('--swatch', scheme.swatch);
        dot.title = scheme.name;
        // 右键二次确认删除：trigger=contextmenu，避免与「左键点击=应用配色」冲突
        armClickConfirm(dot, () => deleteCustomScheme(scheme.id), { trigger: 'contextmenu', armedText: '再次点击删除（右键）' });
        palette.appendChild(dot);
    }
    // 「+」添加圆点
    const add = document.createElement('div');
    add.className = 'qt-dot qt-add';
    add.dataset.add = '1';
    add.textContent = '+';
    palette.appendChild(add);

    refreshHighlights();
}

/** 刷新色块选中高亮（内置按 quickTheme，自定义按 activeCustomId） @returns {void} */
function refreshHighlights() {
    const palette = DOM.quickThemePalette;
    if (!palette) return;
    palette.querySelectorAll('.qt-dot').forEach(d => {
        let active = false;
        if (d.dataset.qt) active = d.dataset.qt === state.settings.quickTheme;
        else if (d.dataset.cs) active = d.dataset.cs === activeCustomId;
        d.classList.toggle('active', active);
    });
}

// ================================================================
//  自定义配色：抽屉与交互
// ================================================================

/** 打开自定义配色底部抽屉 @returns {void} */
function openCustomSchemeModal() {
    const m = DOM.customSchemeModal;
    if (!m) return;
    DOM.customSchemeInput.value = '';
    // 重置创建表单的撞色强度到默认（新配色独立设定，不继承上一个方案的强度）
    currentCreateMix = 56;
    if (DOM.customSchemeMix) {
        DOM.customSchemeMix.value = '56';
        // 新配色尚未输入，撞色强度滑块无意义（多色/渐变无单色跳色），先隐藏整行
        const row = DOM.customSchemeMix.closest('.cs-mix-row');
        if (row) row.style.display = 'none';
    }
    renderCustomSchemeList();
    openModal('custom-scheme-modal');
    // 不主动 focus textarea：移动端 focus 会立即弹出软键盘遮挡面板，用户可能只想浏览已有配色。
    // 用户点击输入框时自然聚焦弹键盘（用户手势触发，Chrome 不拦截）。
}

/** 关闭自定义配色底部抽屉 @returns {void} */
function closeCustomSchemeModal() {
    closeAllModals();
}

/** 渲染自定义配色管理列表（抽屉内，移动端可触屏删除；桌面也可用，不依赖右键） @returns {void} */
function renderCustomSchemeList() {
    const list = DOM.customSchemeList;
    if (!list) return;
    list.innerHTML = '';
    if (customSchemes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'cs-list-empty';
        empty.textContent = '暂无，先在上方粘贴颜色代码保存';
        list.appendChild(empty);
        return;
    }
    for (const scheme of customSchemes) {
        const row = document.createElement('div');
        row.className = 'cs-item';
        const sw = document.createElement('span');
        sw.className = 'cs-item-swatch';
        sw.style.background = scheme.swatch;
        const name = document.createElement('span');
        name.className = 'cs-item-name';
        name.textContent = scheme.name;
        row.appendChild(sw);
        row.appendChild(name);
        // 仅单色方案有「撞色强度」滑块（多色/渐变无单色跳色概念，滑块无意义）
        if (scheme.isSingle) {
            const mixWrap = document.createElement('div');
            mixWrap.className = 'cs-item-mix';
            const mix = document.createElement('input');
            mix.type = 'range';
            mix.min = '0';
            mix.max = '70';
            mix.step = '1';
            mix.value = String(scheme.mix ?? 56);
            mix.className = 'slider';
            mix.addEventListener('input', () => onItemMixInput(scheme.id, +mix.value));
            mixWrap.appendChild(mix);
            row.appendChild(mixWrap);
        }
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'cs-item-del';
        del.textContent = '删除';
        armClickConfirm(del, () => deleteCustomScheme(scheme.id), { armedText: '确认删除?' });
        row.appendChild(del);
        list.appendChild(row);
    }
}

/**
 * 列表项「撞色强度」滑块拖动：就地重算该方案的 cssText 并持久化；
 * 若此方案当前激活，则实时刷新真实页面气泡（让用户直接看到撞色浓淡变化）。
 * 重算用持久化的原始代码（scheme.code），仅气泡底色随 mix 变，其余 token 不变。
 * @param {string} id - 自定义配色 id
 * @param {number} mix - 新的撞色强度（0~70）
 * @returns {void}
 */
function onItemMixInput(id, mix) {
    const scheme = customSchemes.find(s => s.id === id);
    if (!scheme || !scheme.isSingle) return;
    const rebuilt = buildSchemeFromCode(scheme.code, mix);
    if (!rebuilt) return;
    scheme.cssText = rebuilt.cssText;
    scheme.mix = mix;
    saveCustomSchemes(activeCustomId);
    // 仅当它是当前激活方案才实时刷新整页（rAF 节流，避免拖动期间每帧重复挂载主题）
    if (activeCustomId === id) scheduleCustomApply(id);
}

/** rAF 节流地重新应用某方案，用于滑块拖动即时重应用 @param {string} id @returns {void} */
function scheduleCustomApply(id) {
    pendingApplyId = id;
    if (applyRaf) return;
    applyRaf = requestAnimationFrame(() => {
        applyRaf = 0;
        const pid = pendingApplyId;
        pendingApplyId = null;
        if (pid) applyCustomScheme(pid);
    });
}

/**
 * 创建表单输入时：仅解析判断方案是否为单色，决定「撞色强度」滑块整行显隐（多色/渐变/空输入隐藏）。
 * 不再做缩略图实时预览（已移除）。
 * @param {string} code - 粘贴的颜色代码
 * @returns {void}
 */
function syncCreateMixRow(code) {
    const mix = DOM.customSchemeMix;
    if (!mix) return;
    const row = mix.closest('.cs-mix-row');
    if (!row) return;
    const scheme = (code || '').trim() ? buildSchemeFromCode(code, currentCreateMix) : null;
    row.style.display = (scheme && scheme.isSingle) ? '' : 'none';
}

/** 无效输入提示：保存按钮抖动（复用 chat.css @keyframes shake；替代原生 alert） @returns {void} */
function shakeSaveButton() {
    const btn = DOM.customSchemeSave;
    if (!btn) return;
    btn.classList.remove('js-shake');
    void btn.offsetWidth; // 重置动画（连续点击可再次触发）
    btn.classList.add('js-shake');
    btn.addEventListener('animationend', function h() {
        btn.classList.remove('js-shake');
        btn.removeEventListener('animationend', h);
    });
}

/** 从抽屉保存自定义配色并应用 @returns {void} */
function saveCustomSchemeFromModal() {
    const code = DOM.customSchemeInput.value.trim();
    const scheme = buildSchemeFromCode(code, currentCreateMix);
    if (!scheme) {
        shakeSaveButton(); // 无效输入：保存按钮抖动提示（替代原生 alert）
        showThemeFeedback('无效颜色代码'); // 文字提示：抖动只是动效，用户未必懂原因，补一句可读反馈
        return;
    }
    scheme.id = 'cs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    scheme.name = '自定义 ' + (customSchemes.length + 1);
    scheme.code = code;                       // 持久化原始代码，供列表滑块就地重算 cssText
    scheme.mix = currentCreateMix;            // 持久化撞色强度，供列表滑块恢复该方案同款强度
    customSchemes.push(scheme);
    saveCustomSchemes(scheme.id);
    closeCustomSchemeModal();
    renderQuickThemePalette();
    renderCustomSchemeList();
    applyCustomScheme(scheme.id);
    saveToLocal(scheme.name);
}

/** 删除自定义配色（确认由调用方二次点击接管，本函数只做删除） @param {string} id @returns {void} */
function deleteCustomScheme(id) {
    customSchemes = customSchemes.filter(s => s.id !== id);
    if (activeCustomId === id) {
        activeCustomId = null;
        if (activeQuickThemeId) {
            ThemeEngine.unmount(activeQuickThemeId);
            activeQuickThemeId = null;
        }
        saveToLocal(null, true);
    }
    saveCustomSchemes(activeCustomId);
    renderQuickThemePalette();
    renderCustomSchemeList();
}

/** 渲染色块圆点并绑定点击（顶栏常驻，启动时调用一次；事件委托挂在容器上） @returns {void} */
import { registerUI } from '../../core/registry.js';
registerUI('quick-theme', bindQuickThemeEvents);

export function bindQuickThemeEvents() {
    const palette = DOM.quickThemePalette;
    if (!palette) return;

    // 启动：加载并恢复自定义配色（激活项自动应用；单槽与内置互斥）
    const loaded = loadCustomSchemes();
    customSchemes = loaded.schemes;
    activeCustomId = (loaded.activeId && customSchemes.some(s => s.id === loaded.activeId)) ? loaded.activeId : null;
    renderQuickThemePalette();
    if (activeCustomId) applyCustomScheme(activeCustomId);

    // 色块点击：内置 / 自定义 / 添加
    palette.addEventListener('click', (e) => {
        const dot = e.target.closest('.qt-dot');
        if (!dot) return;
        if (dot.dataset.add) { openCustomSchemeModal(); return; }
        if (dot.dataset.cs) { applyCustomScheme(dot.dataset.cs); return; }
        if (dot.dataset.qt) { applyQuickTheme(dot.dataset.qt); }
    });


    // 抽屉交互
    if (DOM.customSchemeModal) {
        // 点击遮罩空白处关闭
        DOM.customSchemeModal.addEventListener('click', (e) => {
            if (e.target === DOM.customSchemeModal) closeCustomSchemeModal();
        });
        DOM.customSchemeCancel.addEventListener('click', closeCustomSchemeModal);
        DOM.customSchemeSave.addEventListener('click', saveCustomSchemeFromModal);
        // 输入时仅同步「撞色强度」滑块显隐（单色才显示）；不再做缩略图实时预览
        DOM.customSchemeInput.addEventListener('input', () => syncCreateMixRow(DOM.customSchemeInput.value));
        // 创建表单「撞色强度」滑块：拖动即更新当前强度，保存时写入方案（不显示数字，纯调节）
        if (DOM.customSchemeMix) {
            DOM.customSchemeMix.addEventListener('input', () => {
                currentCreateMix = +DOM.customSchemeMix.value;
            });
        }
    }

    // 左右方向键循环切换配色（内置 + 自定义）
    bindSchemeHotkeys();
}

/**
 * 左右方向键切换配色：← / → 在「内置配色 + 自定义配色」合并顺序里循环切换并立即应用。
 * 守卫：输入框聚焦（聊天隐藏输入框 / 文本域 / contentEditable）时不触发，避免干扰打字与光标移动；
 * 带 Ctrl/Alt/Meta 等修饰键也不触发（留给浏览器/其他快捷键）。
 * @returns {void}
 */
function bindSchemeHotkeys() {
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        const builtin = Object.keys(QUICK_THEMES);
        const order = [...builtin, ...customSchemes.map(s => s.id)];
        if (order.length === 0) return;
        let idx;
        if (state.settings.quickTheme) idx = builtin.indexOf(state.settings.quickTheme);
        else if (activeCustomId) idx = builtin.length + customSchemes.findIndex(s => s.id === activeCustomId);
        else idx = -1;
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = (idx + dir + order.length) % order.length;
        const id = order[next];
        e.preventDefault();
        if (QUICK_THEMES[id]) applyQuickTheme(id);
        else applyCustomScheme(id);
        showThemeFeedback(QUICK_THEMES[id] ? id : '自定义配色');
    });
}

/** 热键切换后的主题名反馈（复用 save-indicator，无独立 toast 组件） @param {string} name */
function showThemeFeedback(name) {
    const ind = DOM.saveIndicator;
    if (!ind) return;
    ind.textContent = '主题：' + name;
    ind.classList.add('show');
    clearTimeout(ind._feedbackT);
    ind._feedbackT = setTimeout(() => ind.classList.remove('show'), 1500);
}
