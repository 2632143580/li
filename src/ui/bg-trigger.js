/**
 * AI 消息触发背景切换引擎
 *
 * 触发源：api.js / main.js 在「AI 流式回复完成」时通过 bus.emit(EVENTS.ASSISTANT_DONE, fullText) 广播。
 *   两条完成路径都广播同一事件 → 本模块只订阅一次，天然避免双触发；再叠加 500ms 防抖（last-wins），
 *   满足"高频连续触发只执行最后一次"。
 *
 * 匹配语义（需求三/四/五/十二）：
 *   扫描该条完整 AI 文本，对每个已上传图的触发词做精确/通配/正则匹配（全局模式由面板统一选择）。
 *   打分：精确=3、通配=2、正则=1；同模式按词长加权（越长越具体 → 分越高）。
 *   取最高分；最高分并列多张 → 随机取一张兜底（即"先具体匹配，再随机"）。
 *   无命中 → 保持当前背景不变、不报错（需求二十）。
 *   已固定背景（pinnedId 非空）→ 跳过自动切换（需求十·固定）。
 *
 * 依赖：core/bus, core/dom, core/store, core/idb, ui/bg-image
 */
import { bus, EVENTS } from '../core/bus.js';
import { DOM } from '../core/dom.js';
import { state } from '../core/store.js';
import {
    getAllImagesMeta, getImage, getSetting, putSetting, defaultSettings
} from '../core/idb.js';
import { applyBlob, pinBackground } from './bg-image.js';

const DEBOUNCE_MS = 500;

/** 防抖定时器句柄 @type {number|null} */
let debounceTimer = null;
/** 待处理的最后一条 AI 文本 @type {string} */
let pendingText = '';

/** 通配符（* 任意字符）转正则串；其余正则元字符转义，避免用户输入被当作正则语法。 @param {string} w */
function wildcardToRegex(w) {
    return w.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
}

/**
 * 单条触发词对文本是否命中。
 * @param {string} word - 触发词
 * @param {string} text - AI 文本
 * @param {'exact'|'wildcard'|'regex'} mode - 全局匹配模式
 * @returns {boolean}
 */
function testWord(word, text, mode) {
    if (!word) return false;
    try {
        if (mode === 'exact') return text.includes(word);          // 精确：区分大小写子串
        if (mode === 'wildcard') return new RegExp(wildcardToRegex(word), 'i').test(text); // 通配：* 任意
        if (mode === 'regex') return new RegExp(word, 'i').test(text); // 正则：用户自带语法
    } catch (_) {
        return false; // 非法正则/通配 → 视为不命中，不抛错
    }
    return false;
}

/** 模式基础分 @param {string} mode @returns {number} */
function baseScore(mode) {
    return mode === 'exact' ? 3 : mode === 'wildcard' ? 2 : 1;
}

/**
 * 更新常驻指示器（需求十九：固定位置显示当前背景名称/来源）。
 * @param {string|null} name - 当前背景名；null 表示无背景
 */
function updateIndicator(name) {
    const el = DOM.bgCurrentIndicator;
    if (!el) return;
    if (name) {
        el.textContent = '背景：' + name;
        el.classList.add('show');
    } else {
        el.classList.remove('show');
    }
}

/**
 * 核心：对一条 AI 文本执行匹配与切换。
 * @param {string} text - 完整 AI 回复文本
 */
async function evaluate(text) {
    const settings = (await getSetting()) || defaultSettings();

    // 固定背景优先：跳过自动切换，仅刷新指示器
    if (settings.pinnedId) {
        const meta = await getAllImagesMeta();
        const cur = meta.find((m) => m.id === settings.pinnedId);
        updateIndicator(cur ? cur.name : null);
        return;
    }

    const meta = await getAllImagesMeta();
    if (!meta.length) return;

    const mode = settings.globalMode || 'exact';
    const hits = []; // { id, score }
    for (const img of meta) {
        const words = (img.triggerWords || '')
            .split(/[,\n，]/)
            .map((s) => s.trim())
            .filter(Boolean);
        let best = 0;
        for (const w of words) {
            if (testWord(w, text, mode)) {
                // 同模式按词长加权（越长越具体 → 分越高）
                const s = baseScore(mode) + Math.min(w.length, 50) * 0.001;
                if (s > best) best = s;
            }
        }
        if (best > 0) hits.push({ id: img.id, score: best });
    }
    if (!hits.length) return; // 无命中 → 保持当前，不报错

    // 取最高分；并列则随机兜底
    const maxScore = Math.max(...hits.map((h) => h.score));
    const top = hits.filter((h) => h.score === maxScore);
    const chosenId = top[Math.floor(Math.random() * top.length)].id;

    const rec = await getImage(chosenId);
    if (!rec) return;

    await applyBlob(rec.blob);
    settings.currentId = chosenId;
    await putSetting(settings);
    updateIndicator(rec.name);
}

/**
 * 初始化：订阅 AI 完成事件，做 500ms 防抖（last-wins）。
 * 由 main.js 在 init 阶段调用一次。
 */
export function initBgTriggers() {
    bus.on(EVENTS.ASSISTANT_DONE, (text) => {
        pendingText = text;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            evaluate(pendingText);
        }, DEBOUNCE_MS);
    });
}

/** 供手动操作（固定/清除）后刷新指示器。 */
export async function refreshTriggerIndicator() {
    const settings = (await getSetting()) || defaultSettings();
    if (settings.pinnedId) {
        const meta = await getAllImagesMeta();
        const cur = meta.find((m) => m.id === settings.pinnedId);
        updateIndicator(cur ? cur.name : null);
    } else {
        updateIndicator(null);
    }
}
