/**
 * 词云面板 v3：词频列表 + 指定词查询 + 快捷词条 + 可选专业分词（jieba-wasm）。
 * 文件曾用名 wordcloud.js，2026-08-15 更名 wordcloud-panel.js——去掉云图绘制后
 * 原文件名易与「画图」混淆，实际本模块只是面板交互，不绘制任何图形。
 *
 * v3 变更（2026-08-14 用户拍板，遵循「用户直达」UX：能直达就直达、无下拉、无二次点击）：
 *   1. 去掉云图绘制 —— 删除 wordcloud 库依赖（不再内联进单文件产物），只保留列表视图。
 *   2. 「指定词查询」：输入 / 点列表词 / 点快捷词条，三种入口都直达结果条，
 *      即时显示该词在当前对话的总次数与用户/AI 拆分；未命中如实提示。
 *   3. 「分词模式」= 一键直达分段按钮「轻量 | 专业」（非下拉、无二次点击）：
 *      专业 = jieba-wasm（CDN 首次动态加载约 4MB，词典二进制存 Cache Storage，之后打开若已缓存则默认启用，失败自动回退轻量）。
 *   4. 「快捷词条」：查过的词自动收录（去重、最新在前、上限 10、localStorage 持久化），
 *      点词条直接再查（免输入）；删除 = 右键或长按（词条上不放叉，保持小而净）。
 *   5. 点列表里的词 = 直接查询（填入输入框 + 列表行高亮 + 结果条更新），免手打。
 *
 * 数据链路：getCurrentPath() → analyzeWordFreq({ topN:0, segment: 当前分词器 }) → 全量词频表。
 *   列表只展示前 TOP_N；指定词查询走全量表 Map 反查——分词只做一次、多处消费。
 *   停用词 / 纯数字 / minLength 过滤统一在 analyzer 管线内执行，轻量与 jieba 行为一致。
 *
 * 分色依据（列表比例条 + 图例，不是随意挑的颜色）：
 *   三个语义角色固定色相、两两分离 ≥85°，任何主题下都不混淆——
 *     用户 = 暖橙(20°) / AI = 冷蓝(205°) / 双方各半 = 绿(140°)。
 *   饱和度/明度从主题 --color-accent 取手感（饱和度夹 50%~85%），并随面板明暗自适应。
 */

import { DOM } from '../../core/dom.js';
import { getCurrentPath } from '../../chat/tree.js';
import { analyzeWordFreq, setActiveSegmenter, getActiveSegmenter } from '../../core/wordcloud-analyzer.js';
import { moderator } from '../../engines/moderator-engine.js'; // 禁词引擎：词频「禁词」tab 复用 words[].count（待办 Phase5）

/** 列表展示的词数上限（全量表仍在内存中，查询不受此限制）。 @type {number} */
const TOP_N = 100;
/** 用户占比高于此值判定为「用户说得多」。 @type {number} */
const USER_DOMINANT = 0.6;
/** 用户占比低于此值判定为「AI 说得多」。 @type {number} */
const AI_DOMINANT = 0.4;
/** 快捷词持久化键（独立键，存最近查过的词）。 @type {string} */
const QUICK_KEY = 'li.wordcloudQuickWords';
/** 快捷词条上限：太多会挤占面板。 @type {number} */
const QUICK_MAX = 10;
/** 长按删除阈值（毫秒）：触控设备按住词条超过此值判定为删除而非点击。 @type {number} */
const LONG_PRESS_MS = 600;
/** jieba-wasm CDN 入口（esm 模块）。已实测 2.4.0 导出 default(init)/cut/initSync 等，**没有 load()**。 @type {string} */
const JIEBA_URL = 'https://cdn.jsdelivr.net/npm/jieba-wasm@2.4.0/+esm';
/** jieba-wasm 词典二进制（init 需要它，约 3.8 MB，需单独下载）。 @type {string} */
const JIEBA_WASM_URL = 'https://cdn.jsdelivr.net/npm/jieba-wasm@2.4.0/pkg/web/jieba_rs_wasm_bg.wasm';
/** jieba 加载总超时（ms）：模块/词典下载都可能挂起，超时按失败处理回退轻量。 @type {number} */
const JIEBA_TIMEOUT_MS = 30000;
/** 词典持久化缓存名（Cache Storage：首次下载后存本地，刷新页面免重下；file:// 等环境自动退化）。 @type {string} */
const JIEBA_CACHE_NAME = 'li-jieba-wasm-v1';
/** 列表分组 tab 的顺序与精简字样（**AI 最左**；用户拍板：去掉圆点与数量，仅留字样 ai/你/双方）。 @type {Array<{key:string,label:string}>} */
const ROLE_GROUPS = [
    { key: 'ai', label: 'ai' },
    { key: 'user', label: '你' },
    { key: 'both', label: '双方' }
];

/** 判断一个词归入哪个角色桶（与分色同一套阈值：user≥0.6 / ai≤0.4 / 其余双方各半）。 */
function groupOf(byRole) {
    const u = (byRole && byRole.user) || 0;
    const a = (byRole && byRole.assistant) || 0;
    const total = u + a;
    if (total === 0) return 'both';
    const ratio = u / total;
    if (ratio >= USER_DOMINANT) return 'user';
    if (ratio <= AI_DOMINANT) return 'ai';
    return 'both';
}

/** 全量词频表（列表 TOP_N 与指定词查询共用这一次分词结果）。 @type {Array<{word:string,count:number,byRole:Object<string,number>}>} */
let currentFreq = [];
/** 词 → 条目，指定词查询的反查表。 @type {Map<string, {count:number,byRole:Object<string,number>}>} */
const freqIndex = new Map();
/** 当前生效的分词模式。 @type {'light'|'jieba'} */
let segmentMode = 'light';
/** jieba 实例缓存（首次加载后复用，跨面板开关保持）。 @type {object|null} */
let jieba = null;
/** jieba 是否正在加载（加载中忽略重复点击，专业按钮显示填充进度）。 @type {boolean} */
let jiebaLoading = false;
/** jieba 上次加载是否失败（常驻状态行如实显示，可重试）。 @type {boolean} */
let jiebaFailed = false;
/** 当前查询词（小写），列表行高亮依据。 @type {string} */
let queryWord = '';
/** 当前选中的分组 tab（'ai'|'user'|'both'）；默认 AI（用户拍板），若该组为空则回退首个非空组。 @type {string} */
let activeGroupKey = 'ai';
/** 快捷词列表（最新在前）。 @type {string[]} */
let quickWords = [];
/** 上次长按删除的时间戳，用于抑制长按后紧跟的 click。 @type {number} */
let lastLongPressAt = 0;

/**
 * 解析 "rgb(r, g, b)" / "rgba(r, g, b, a)" / "rgb(r g b)" 为 [r,g,b]（0-255）。
 * 解析失败返回回退值。 @returns {[number,number,number]}
 */
function parseRgb(str, fallback) {
    if (!str) return fallback;
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return fallback;
    const nums = m[1].split(/[,\s]+/).filter(Boolean).map(Number);
    if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) return fallback;
    return [nums[0], nums[1], nums[2]];
}

/** rgb(0-255) → [h(0-360), s(0-1), l(0-1)]。 */
function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
}

/** sRGB 相对亮度（0-1），用于判断面板是暗底还是亮底。 */
function relativeLuminance([r, g, b]) {
    const f = (c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 组装 css hsl 字符串（h:0-360, s/l:0-1）。 */
function hslCss(h, s, l) {
    return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 分色：三个语义角色固定色相（用户=暖橙 / AI=冷蓝 / 双方各半=绿），两两分离 ≥85°，
 * 任何主题下都明显可分；明度按面板明暗自动调整以保证可读。返回值供列表比例条上色
 * @returns {{user:string, ai:string, both:string}}
 */
function readRoleColors() {
    // 词云已内嵌消息导航「词频」pane，从导航面板表面读取主题 token（面板未创建时回落默认）
    const surface = document.getElementById('msg-nav');
    // 读主题 accent token，作为饱和/明度手感来源
    const accentStr = surface ? getComputedStyle(surface).getPropertyValue('--color-accent').trim() : '';
    const accentRgb = parseRgb(accentStr || 'rgb(120,160,220)', [120, 160, 220]);
    const [, accentS] = rgbToHsl(accentRgb);

    // 面板明暗：读模态框背景亮度，决定文字色明度带（暗面板→亮字，亮面板→暗字）
    const bgRgb = parseRgb(surface ? getComputedStyle(surface).backgroundColor : '', [20, 20, 28]);
    const Lt = relativeLuminance(bgRgb) < 0.35 ? 0.70 : 0.42;
    const St = clamp(accentS, 0.50, 0.85);   // 饱和度沿用主题基调，夹在安全区间

    const HUE_USER = 20, HUE_AI = 205, HUE_BOTH = 140, HUE_WARN = 352;
    const user = hslCss(HUE_USER, St, Lt);
    const ai = hslCss(HUE_AI, St, Lt);
    const both = hslCss(HUE_BOTH, St, Lt);
    const warn = hslCss(HUE_WARN, St, Lt);

    return { user, ai, both, warn };
}

/** 切换当前显示的分组 tab：高亮对应 tab、显示对应组容器（其余隐藏）。 @param {string} key 'user'|'ai'|'both' */
function switchGroup(key) {
    const list = DOM.wordcloudList;
    if (!list) return;
    activeGroupKey = key;
    for (const t of list.querySelectorAll('.wc-tab')) {
        t.classList.toggle('active', t.dataset.group === key);
    }
    for (const p of list.querySelectorAll('.wc-group')) {
        p.classList.toggle('active', p.dataset.group === key);
    }
}

/**
 * 渲染词频列表：按角色分「用户说得多 / AI 说得多 / 双方各半」三组，**顶部标签（tab）切换**，
 * 一次只显示一组（替代原 <details> 手风琴，也规避了原生折叠 UI）；tab 带色点 + 数量，
 * 空组 tab 置灰禁用。组内词行结构不变：词 + 比例条 + 次数。
 * @param {Array<{word:string,count:number,byRole:Object<string,number>}>} freq 待展示词条（通常已 slice 到 TOP_N）
 */
function renderList(freq) {
    const list = DOM.wordcloudList;
    list.innerHTML = '';
    if (!freq.length) return;

    const max = freq[0].count;
    const colors = readRoleColors();

    // 先按角色**全量**分桶（不截断）——避免「前 100 词被单一角色主导词挤满、
    // 其他角色的词看不到且 tab 误显为空」；展示时每组各自取 TOP_N
    const buckets = { user: [], ai: [], both: [] };
    for (const item of freq) buckets[groupOf(item.byRole)].push(item);

    // 生效组：优先恢复上次选中的组；若该组为空（切换分词后词分布变化）则回退首个非空组
    const firstNonEmpty = ROLE_GROUPS.find((g) => buckets[g.key].length) || ROLE_GROUPS[0];
    const activeKey = buckets[activeGroupKey] && buckets[activeGroupKey].length ? activeGroupKey : firstNonEmpty.key;

    const tabs = document.createElement('div');
    tabs.className = 'wc-tabs';
    const panels = document.createElement('div');
    panels.className = 'wc-panels';

    for (const g of ROLE_GROUPS) {
        const items = buckets[g.key].slice(0, TOP_N);   // 组内截断展示，空组判定用全量桶

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'wc-tab';
        tab.dataset.group = g.key;
        if (!items.length) tab.setAttribute('aria-disabled', 'true');   // 空组：淡化但仍可点（点开显示「（无）」）
        tab.textContent = g.label;                                       // 精简字样，无圆点无数量
        tab.addEventListener('click', () => switchGroup(g.key));
        tabs.appendChild(tab);

        const panel = document.createElement('div');
        panel.className = 'wc-group';
        panel.dataset.group = g.key;
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'wc-empty';
            empty.textContent = '（无）';
            panel.appendChild(empty);
        }
        for (const { word, count, byRole } of items) {
            const row = document.createElement('div');
            row.className = 'wc-row';

            const w = document.createElement('span');
            w.className = 'wc-word';
            w.textContent = word;

            const track = document.createElement('span');
            track.className = 'wc-track';

            const bar = document.createElement('span');
            bar.className = 'wc-bar';
            // 以最高频词为 100% 基准；下限 4% 保证极低频条仍然看得见
            bar.style.width = Math.max(4, Math.round((count / max) * 100)) + '%';
            bar.style.background = colors[g.key];
            track.appendChild(bar);

            const c = document.createElement('span');
            c.className = 'wc-count';
            c.textContent = String(count);

            row.append(w, track, c);
            panel.appendChild(row);
        }
        panels.appendChild(panel);
    }

    // 「禁词」tab：复用 moderator.words（{word,count}），按 count 降序；无词库时为「（无）」
    const banned = (moderator.words || [])
        .slice()
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, TOP_N);
    const bTab = document.createElement('button');
    bTab.type = 'button';
    bTab.className = 'wc-tab';
    bTab.dataset.group = 'banned';
    if (!banned.length) bTab.setAttribute('aria-disabled', 'true');
    bTab.textContent = '禁词';
    bTab.addEventListener('click', () => switchGroup('banned'));
    tabs.appendChild(bTab);

    const bPanel = document.createElement('div');
    bPanel.className = 'wc-group';
    bPanel.dataset.group = 'banned';
    if (!banned.length) {
        const empty = document.createElement('div');
        empty.className = 'wc-empty';
        empty.textContent = '（无）';
        bPanel.appendChild(empty);
    }
    for (const { word, count } of banned) {
        const row = document.createElement('div');
        row.className = 'wc-row';

        const w = document.createElement('span');
        w.className = 'wc-word';
        w.textContent = word;

        const track = document.createElement('span');
        track.className = 'wc-track';

        const bar = document.createElement('span');
        bar.className = 'wc-bar';
        bar.style.width = Math.max(4, Math.round((count / Math.max(1, banned[0].count)) * 100)) + '%';
        bar.style.background = colors.warn;
        track.appendChild(bar);

        const c = document.createElement('span');
        c.className = 'wc-count';
        c.textContent = String(count);

        row.append(w, track, c);
        bPanel.appendChild(row);
    }
    panels.appendChild(bPanel);

    list.append(tabs, panels);
    switchGroup(activeKey);          // 应用初始选中 tab（含恢复上次选中）
    applyHitHighlight();
}

/** 按当前查询词给列表行加高亮（命中词在列表里一眼可见）。
 *  若命中词不在当前显示的分组，自动切到该组 tab——保证高亮可见（用户直达：点词查询即见结果）。 */
function applyHitHighlight() {
    if (!DOM.wordcloudList) return;
    const rows = DOM.wordcloudList.querySelectorAll('.wc-row');
    let hitGroupKey = null;
    let activeHit = false;        // 命中词是否已在当前激活组（是则不切 tab）
    for (const row of rows) {
        const w = row.querySelector('.wc-word');
        const isHit = !!w && w.textContent === queryWord && queryWord !== '';
        row.classList.toggle('hit', isHit);
        if (isHit) {
            const panel = row.closest('.wc-group');
            const g = panel && panel.dataset.group;
            if (g === activeGroupKey) activeHit = true;   // 命中已在当前激活组：不打断、不跳 tab
            if (g) hitGroupKey = g;
        }
    }
    // 仅当命中词不在当前激活组时才切 tab（用户直达：搜到的词在别组才定位过去）；
    // 命中已在当前组则保持，避免「点击高频词被强制跳到禁词组」（禁词面板最后 append，会覆盖 hitGroupKey）
    if (!activeHit && hitGroupKey && hitGroupKey !== activeGroupKey) switchGroup(hitGroupKey);
}

/** 更新提示栏文案（词总数 + 当前分词模式说明）。 */
function updateNote() {
    if (!DOM.wordcloudNote) return;
    if (!currentFreq.length) {
        DOM.wordcloudNote.textContent = '当前对话没有可分析的文本。';
        return;
    }
    const segLabel = segmentMode === 'jieba' ? '（专业分词 jieba）' : '（轻量分词）';
    // 「条形颜色区分角色」：图例已按用户要求移除，颜色语义由 tab 字样承担；删除手势提示常驻此处
    DOM.wordcloudNote.textContent = `共 ${currentFreq.length} 个词，按出现次数降序，条形颜色区分角色${segLabel}。右键/长按删除快捷查询`;
}

/** 设置提示栏文案（含加载中/回退等临时状态）。 @param {string} msg */
function setNote(msg) {
    if (DOM.wordcloudNote) DOM.wordcloudNote.textContent = msg;
}

/**
 * 渲染「专业词库加载状态」常驻行：未加载 / 加载中 / 已加载 / 加载失败。
 * 状态行固定在工具栏下方，回答「专业词库是否已加载」，成功失败都不一闪而过。
 */
function renderJiebaStatus() {
    const el = DOM.wordcloudStatus;
    if (!el) return;
    el.classList.remove('idle', 'loading', 'ok', 'fail');
    let text, cls;
    if (jiebaLoading) {
        text = '专业词库：加载中…';
        cls = 'loading';
    } else if (jieba) {
        text = '专业词库：已加载';
        cls = 'ok';
    } else if (jiebaFailed) {
        text = '专业词库：加载失败（网络或 CDN 不可达），点「专业」可重试';
        cls = 'fail';
    } else {
        text = '专业词库：未加载（当前轻量分词）';
        cls = 'idle';
    }
    el.textContent = text;
    el.classList.add(cls);
}

/**
 * 带超时的 Promise 包装：第三方网络加载「完成」依赖外部世界，必须超时兜底，
 * 否则 CDN 请求挂起会让 await 永久 pending、加载态永远不结束（用户铁律：凡 await 第三方初始化一律加超时竞速）。
 * @param {Promise<any>} promise
 * @param {number} ms 超时毫秒数
 * @param {string} message 超时错误信息
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

/**
 * 带进度下载二进制（fetch + ReadableStream 累计字节）。
 * Content-Length 缺失或无需进度时退化：一次性取回、无回调。
 * @param {string} url
 * @param {(ratio:number)=>void} [onProgress] 0..1
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchBinary(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !total || !onProgress) return res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(Math.min(1, received / total));
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
}

/** 更新专业按钮底部填充的**真实下载进度**与状态行。 @param {number} ratio 0..1 */
function updateJiebaProgress(ratio) {
    const btn = DOM.wordcloudSegJieba;
    if (btn) btn.style.setProperty('--wc-progress', Math.round(ratio * 100) + '%');
    const el = DOM.wordcloudStatus;
    if (el && jiebaLoading) {
        el.textContent = `专业词库：下载中 ${Math.round(ratio * 100)}%（约 3.8MB）…`;
        el.classList.remove('idle', 'loading', 'ok', 'fail');
        el.classList.add('loading');
    }
}

/**
 * 取词典 wasm 二进制：**Cache Storage 优先**（首次下载后存本地，刷新/重开免重新下载）；
 * 未命中才走网络（带真实进度）；file:// 等无 Cache API 的环境自动退化走网络（浏览器 HTTP 缓存兜底）。
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchJiebaWasm() {
    try {
        const cache = await caches.open(JIEBA_CACHE_NAME);
        const hit = await cache.match(JIEBA_WASM_URL);
        if (hit) return await hit.arrayBuffer();
    } catch (_) { /* 无 Cache API（file:// 等），走网络 */ }
    const buf = await fetchBinary(JIEBA_WASM_URL, updateJiebaProgress);
    try {
        const cache = await caches.open(JIEBA_CACHE_NAME);
        await cache.put(JIEBA_WASM_URL, new Response(buf, { headers: { 'Content-Type': 'application/wasm' } }));
    } catch (_) { /* 写缓存失败不影响本次使用 */ }
    return buf;
}

/**
 * 检测专业词库是否已缓存到 Cache Storage（首次下载后本地留存，刷新/重开免重下）。
 * 命中仅说明词典二进制在本地——内存实例（jieba）仍需重新初始化（import 模块 + mod.default(buf)），
 * 但能省去约 3.8MB 词典下载耗时，实现近秒开。无 Cache API（file:// 等）视作未缓存。
 * @returns {Promise<boolean>}
 */
async function hasCachedJieba() {
    try {
        const cache = await caches.open(JIEBA_CACHE_NAME);
        return !!(await cache.match(JIEBA_WASM_URL));
    } catch (_) {
        return false;
    }
}

/**
 * 加载 jieba-wasm 并缓存实例。**已实测**（node 跑通 2.4.0）：
 * ① import 模块（小）→ ② 取词典 wasm（Cache Storage 优先，未命中走网络带真实进度）→ ③ `mod.default(buffer)` 初始化 → `mod.cut(text,true)` 返回 string[]。
 * 失败/超时抛错，由调用方回退轻量并如实提示。
 * @returns {Promise<object>} jieba 模块（含 cut 等导出）
 */
async function loadJieba() {
    if (jieba) return jieba;
    const mod = await withTimeout(import(JIEBA_URL), JIEBA_TIMEOUT_MS, '加载 jieba 模块超时（网络或 CDN 不可达）');
    const buf = await withTimeout(fetchJiebaWasm(), JIEBA_TIMEOUT_MS, '加载 jieba 词库超时（约 3.8MB，网络或 CDN 不可达）');
    await withTimeout(mod.default(buf), 10000, 'jieba 初始化超时');
    jieba = mod;
    return mod;
}

/**
 * jieba 专业分词器（注入 analyzeWordFreq 的 segment 选项）。
 * 已实测：`cut(text, true)` 返回 string[]（如 我|爱|北京|天安门）；结果小写、去空白，过滤统一交给 analyzer 管线。
 * cut 出错时向上抛，由 analyze() 捕获并回退轻量（不静默丢数据）。
 * @param {string} text
 * @returns {string[]}
 */
function jiebaSegment(text) {
    const inst = jieba;
    if (!inst) return [];
    return inst.cut(text, true).map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/**
 * 分块跑词频统计：把消息节点数组按块拆分，逐块调用 analyzeWordFreq 并合并词频，
 * 块间通过 setTimeout(0) 让出主线程，避免大对话点开词云时一次性长任务卡住 UI（D3 卡顿根因）。
 * @param {Array<object>} nodes 消息节点数组（同 analyzeWordFreq 入参）
 * @param {object} options analyzeWordFreq 选项
 * @returns {Promise<Array<{word:string,count:number,byRole:Object<string,number>}>>} 合并降序词频表
 */
async function analyzeWordFreqChunked(nodes, options) {
    const CHUNK = 200; // 每块消息数：约几 ms，块间让出主线程
    /** 词 → { count, byRole:Map<role,count> } @type {Map<string, {count:number, byRole:Map<string,number>}>} */
    const merged = new Map();
    for (let i = 0; i < nodes.length; i += CHUNK) {
        const part = analyzeWordFreq(nodes.slice(i, i + CHUNK), options);
        for (const item of part) {
            let acc = merged.get(item.word);
            if (!acc) { acc = { count: 0, byRole: new Map() }; merged.set(item.word, acc); }
            acc.count += item.count;
            for (const [role, c] of Object.entries(item.byRole)) {
                acc.byRole.set(role, (acc.byRole.get(role) || 0) + c);
            }
        }
        // 让出主线程：把后续块推迟到下一个宏任务，避免长任务卡 UI
        await new Promise((r) => setTimeout(r, 0));
    }
    const list = [...merged.entries()].map(([word, { count, byRole }]) => ({
        word, count, byRole: Object.fromEntries(byRole)
    }));
    list.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
    return list;
}

/** 分析代次：每次 analyze 自增，落后（被新的分析取代）的结果丢弃，避免快速切换分词模式时结果错乱。 @type {number} */
let analyzeSeq = 0;

/**
 * 用当前分词模式重新分析全量词频：建反查表 → 渲染列表 → 刷新查询结果 → 更新提示。
 * 改为异步分块（analyzeWordFreqChunked），分析期间列表显示"分析中…"占位，避免大对话主线程卡顿（D3）。
 * jieba 分词异常时回退轻量并如实提示，不让用户拿到残缺数据。
 */
async function analyze() {
    const mySeq = ++analyzeSeq;
    if (DOM.wordcloudList) DOM.wordcloudList.innerHTML = '<div class="wc-empty">分析中…</div>';

    const path = getCurrentPath();
    const opts = { includeRoles: ['user', 'assistant'], topN: 0 };
    try {
        // 同步「当前分词器」给消息导航等共用方：专业模式用 jiebaSegment，否则默认轻量
        setActiveSegmenter(segmentMode === 'jieba' && jieba ? jiebaSegment : undefined);
        currentFreq = await analyzeWordFreqChunked(path, { ...opts, segment: getActiveSegmenter() });
    } catch (e) {
        if (mySeq !== analyzeSeq) return; // 已被更新的分析取代，丢弃本结果
        segmentMode = 'light';
        setSegActive('light');
        setActiveSegmenter(undefined);
        currentFreq = await analyzeWordFreqChunked(path, { ...opts, segment: getActiveSegmenter() });
        setNote('专业分词出错，已回退轻量分词。');
    }

    if (mySeq !== analyzeSeq) return; // 已被更新的分析取代，丢弃本结果

    freqIndex.clear();
    for (const item of currentFreq) freqIndex.set(item.word, item);

    renderList(currentFreq);   // 全量传入：分组后各组各自截断 TOP_N（避免单角色主导词挤掉其他组）
    refreshQuery();
    updateNote();
}

/**
 * 刷新「指定词查询」：把结果写进独立结果条（三种状态同一位，不闪位置）。
 * 命中 → 词名 + 总次数 + 用户/AI 拆分，并把词收进快捷区；未命中 → 如实提示。
 * 结果条用 textContent 构建，避免用户输入被当作 HTML 注入。
 */
function refreshQuery() {
    const input = DOM.wordcloudQuery;
    const result = DOM.wordcloudQueryResult;
    if (!input || !result) return;
    result.innerHTML = '';
    result.classList.remove('miss');

    const word = input.value.trim().toLowerCase();
    queryWord = word;
    if (!word) { applyHitHighlight(); return; }

    const entry = freqIndex.get(word);
    if (!entry) {
        result.classList.add('miss');
        const span = document.createElement('span');
        span.className = 'wc-result-word';
        span.textContent = `「${word}」未出现（或命中停用词被过滤）`;
        result.appendChild(span);
        applyHitHighlight();
        return;
    }

    const u = entry.byRole.user || 0;
    const a = entry.byRole.assistant || 0;
    const wEl = document.createElement('span');
    wEl.className = 'wc-result-word';
    wEl.textContent = `「${word}」`;
    const cEl = document.createElement('span');
    cEl.className = 'wc-result-count';
    cEl.textContent = `共 ${entry.count} 次`;
    const sEl = document.createElement('span');
    sEl.className = 'wc-result-split';
    sEl.textContent = `用户 ${u} · AI ${a}`;
    result.append(wEl, cEl, sEl);

    addQuick(word);
    applyHitHighlight();
}

/* —— 快捷词条：查过的词自动收录，点一下直接再查；右键 / 长按删除 —— */

/** 读取持久化的快捷词。 @returns {string[]} */
function loadQuickWords() {
    try {
        const raw = localStorage.getItem(QUICK_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x) : [];
    } catch (_) { return []; }
}

/** 持久化快捷词。 @param {string[]} words */
function saveQuickWords(words) {
    try { localStorage.setItem(QUICK_KEY, JSON.stringify(words)); } catch (_) { /* 隐私模式等忽略 */ }
}

/** 收录一个查询词：去重、最新在前、截断上限。 @param {string} word */
function addQuick(word) {
    quickWords = [word, ...quickWords.filter((w) => w !== word)].slice(0, QUICK_MAX);
    saveQuickWords(quickWords);
    renderQuick();
}

/** 移除一个快捷词（右键 / 长按触发）。 @param {string} word */
function removeQuick(word) {
    quickWords = quickWords.filter((w) => w !== word);
    saveQuickWords(quickWords);
    renderQuick();
}

/** 渲染快捷词条区：每个词条 = 点击查询 / 右键或长按删除（词条上不放叉，保持小而净）。 */
function renderQuick() {
    const box = DOM.wordcloudQuick;
    if (!box) return;
    box.innerHTML = '';

    if (!quickWords.length) {
        box.classList.add('empty');
        return;
    }
    box.classList.remove('empty');

    const label = document.createElement('span');
    label.className = 'wc-quick-label';
    label.textContent = '快捷';
    box.appendChild(label);

    for (const word of quickWords) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'wc-chip';
        chip.textContent = word;
        // 删除手势提示改由提示栏常驻文案承担（wordcloud-note），词条本身不再挂悬浮提示
        chip.addEventListener('click', () => {
            // 长按删除后紧跟着的 click 要抑制，避免刚删又查
            if (Date.now() - lastLongPressAt < 400) return;
            if (DOM.wordcloudQuery) DOM.wordcloudQuery.value = word;
            refreshQuery();
        });
        chip.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            lastLongPressAt = Date.now();
            removeQuick(word);
        });
        // 触控长按删除：按住 600ms 触发，松开/滑动取消；用 pointer 事件统一鼠标长按与触控
        let pressTimer = 0;
        chip.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;   // 只响应左键/触摸
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => {
                lastLongPressAt = Date.now();
                removeQuick(word);
            }, LONG_PRESS_MS);
        });
        const cancelPress = () => { clearTimeout(pressTimer); };
        chip.addEventListener('pointermove', cancelPress);
        chip.addEventListener('pointerup', cancelPress);
        chip.addEventListener('pointercancel', cancelPress);
        chip.addEventListener('pointerleave', cancelPress);
        box.appendChild(chip);
    }
}

/* —— 分词模式：一键直达分段按钮 —— */

/** 切换分段按钮的激活态（'light' / 'jieba' / 'none'=加载中都不实心，让填充进度可见）。 @param {'light'|'jieba'|'none'} mode */
function setSegActive(mode) {
    if (DOM.wordcloudSegLight) DOM.wordcloudSegLight.classList.remove('active', 'loading');
    if (DOM.wordcloudSegJieba) DOM.wordcloudSegJieba.classList.remove('active', 'loading');
    if (mode === 'light' && DOM.wordcloudSegLight) DOM.wordcloudSegLight.classList.add('active');
    else if (mode === 'jieba' && DOM.wordcloudSegJieba) DOM.wordcloudSegJieba.classList.add('active');
}

/**
 * 应用分词模式并（必要时）加载 jieba 后重新分析。
 * 点「专业」立即进入加载态：两按钮都不实心，专业按钮从底部**真实进度**填充（下载到哪填到哪）；
 * 加载成功 → 专业实心激活；失败/超时 → 回退轻量并如实提示（可再点重试）。
 * @param {'light'|'jieba'} mode
 */
async function applySegmentMode(mode) {
    if (jiebaLoading) return;                 // 加载中忽略重复点击
    segmentMode = mode;

    if (mode === 'jieba' && !jieba) {
        jiebaLoading = true;
        jiebaFailed = false;
        setSegActive('none');
        if (DOM.wordcloudSegJieba) DOM.wordcloudSegJieba.classList.add('loading');
        renderJiebaStatus();
        let loadError = null;
        try {
            await loadJieba();
        } catch (e) {
            loadError = e;
        }
        // 先复位 loading 标志与进度，再统一渲染状态（否则 renderJiebaStatus 会误显示「加载中」并永久卡死）
        jiebaLoading = false;
        if (DOM.wordcloudSegJieba) {
            DOM.wordcloudSegJieba.classList.remove('loading');
            DOM.wordcloudSegJieba.style.removeProperty('--wc-progress');
        }
        if (loadError) {
            segmentMode = 'light';
            jiebaFailed = true;
            setSegActive('light');
            renderJiebaStatus();
            analyze();
            return;
        }
        setSegActive('jieba');                // 加载成功 → 实心激活
        renderJiebaStatus();
        analyze();
        return;
    }

    setSegActive(mode);
    renderJiebaStatus();
    analyze();
}

/**
 * 打开面板：恢复快捷词 → 打开模态框 → 按「专业词库是否已缓存」决定默认分词模式。
 * 用户铁律（打开一律轻量）已改为：若 Cache Storage 已留存专业词库（首次下载后），
 * 直接启用专业分词（省下载、近秒开）；首次无缓存仍轻量起步，避免一开面板就触发 3.8MB 下载。
 */
export async function openWordCloud() {
    quickWords = loadQuickWords();
    renderQuick();
    if (DOM.wordcloudQuery) DOM.wordcloudQuery.value = '';
    const cached = await hasCachedJieba();
    applySegmentMode(cached ? 'jieba' : 'light');
}

/** 绑定词云面板的全部交互事件（仅在模块初始化时调用一次）。词云已内嵌消息导航的「词频」pane，
 * 关闭由面板整体（遮罩点击 / ✕ / Esc）统一处理，此处只绑内容交互；节点移动后监听器仍随节点保留。 */
import { registerUI } from '../../core/registry.js';
registerUI('wordcloud', bindWordCloudEvents);

export function bindWordCloudEvents() {
    // 指定词查询：输入防抖 150ms 实时刷新 + Enter 立即查询
    if (DOM.wordcloudQuery) {
        let debounce = 0;
        DOM.wordcloudQuery.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(refreshQuery, 150);
        });
        DOM.wordcloudQuery.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); refreshQuery(); }
        });
    }

    // 点列表里的词 = 直接查询（用户直达，免输入）：委托到列表容器
    if (DOM.wordcloudList) {
        DOM.wordcloudList.addEventListener('click', (e) => {
            const row = e.target.closest('.wc-row');
            if (!row) return;
            const w = row.querySelector('.wc-word');
            if (!w) return;
            if (DOM.wordcloudQuery) DOM.wordcloudQuery.value = w.textContent;
            refreshQuery();
        });
    }

    // 分词模式：一键直达分段按钮（点「专业」立即切换，无下拉、无二次点击）
    // 点「已在生效」的按钮 = 无操作，避免无谓的重新分词把列表折叠态/滚动位置打回原形
    if (DOM.wordcloudSegLight) DOM.wordcloudSegLight.addEventListener('click', () => {
        if (segmentMode !== 'light') applySegmentMode('light');
    });
    if (DOM.wordcloudSegJieba) DOM.wordcloudSegJieba.addEventListener('click', () => {
        if (segmentMode !== 'jieba') applySegmentMode('jieba');
    });
}
