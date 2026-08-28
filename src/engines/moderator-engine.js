/**
 * 禁止词引擎（极简版）
 *
 * 职责：词库的存取（state.settings.moderator，随存档序列化）、AI 回复文本扫描、触发次数统计、前缀生成。
 *       不做任何发送逻辑拦截——命中后仅通过 bus 广播事件，由 UI 层决定如何提示，
 *       保持「引擎只管识别与统计、UI 管交互」的单一职责。
 *
 * 导出：moderator（单例，import 即完成初始化与事件订阅）
 * 依赖：core/bus（订阅 ASSISTANT_DONE，扫描 AI 回复完成文本）、core/store（state.settings）、core/storage（debouncedSave）
 */
import { bus, EVENTS } from '../core/bus.js';
import { state } from '../core/store.js';
import { debouncedSave } from '../core/storage.js';

/** 禁止词引擎类 */
class ModeratorEngine {
    constructor() {
        /** 词库条目数组：{ word:string, count:number }，count 为该词累计触发次数 @type {Array<{word:string, count:number}>} */
        this.words = [];
        /** 前缀模板：整段包裹在括号里，支持 {words} 占位符（运行时替换为命中词，用户可自由编辑） @type {string} */
        this.prefixTemplate = '（警告：已触发禁止词「{words}」，请更换表达方式）';
        /** 是否启用过滤：false 时引擎跳过扫描（由面板头部开关控制） @type {boolean} */
        this.enabled = true;
        // 构造时不读盘：此时 state.settings 仍为 DEFAULT_SETTINGS，main 在 loadFromLocal 后显式调 load() 还原存档
        this._initListener(); // 订阅 AI 回复完成事件，进入被动扫描状态
    }

    /** 从 state.settings.moderator 恢复词库与模板（损坏数据静默降级为默认值） @returns {void} */
    load() {
        const m = state.settings.moderator;
        if (m && typeof m === 'object') {
            // 词库与模板分别兜底：缺哪项用哪项默认，不互相拖累
            this.words = Array.isArray(m.words) ? m.words : [];
            this.prefixTemplate = (typeof m.prefixTemplate === 'string' && m.prefixTemplate)
                ? m.prefixTemplate : this.prefixTemplate;
            this.enabled = (typeof m.enabled === 'boolean') ? m.enabled : true;
        }
    }

    /** 持久化词库与模板：写回 state.settings.moderator 并防抖落盘（纳入 settings 序列化） @returns {void} */
    save() {
        state.settings.moderator = { words: this.words, prefixTemplate: this.prefixTemplate, enabled: this.enabled };
        debouncedSave();
    }

    /**
     * 批量解析文本并同步词库：支持逗号、顿号、换行分隔；自动去重（同词只留一条，
     * 保留原计数——否则「a, a, b」会生成两条 a 且新 a 计数归零）。
     * @param {string} text 用户粘贴的原始文本
     * @returns {void}
     */
    syncWordsByText(text) {
        // 按 逗号/顿号/换行 切分，trim 后过滤空项
        const items = text.split(/[,，\n\r、]/).map(t => t.trim()).filter(t => t);
        // 旧词 → 旧计数 映射表，供新条目继承历史触发次数
        const oldCounts = {};
        this.words.forEach(w => { oldCounts[w.word] = w.count || 0; });
        // 用 Set 去重保序：同词只保留首现位置，杜绝重复条目
        this.words = [...new Set(items)].map(item => ({
            word: item,
            count: oldCounts[item] || 0
        }));
        this.save();
    }

    /** 词库转字符串（逗号+空格分隔），供配置面板 textarea 回填 @returns {string} */
    getWordsString() {
        return this.words.map(w => w.word).join(', ');
    }

    /**
     * 扫描文本命中词库：命中即累计触发次数并落盘。
     * @param {string} text 待扫描文本（AI 回复全文）
     * @returns {Array<{word:string, count:number}>} 命中的词条数组（空 = 未命中）
     */
    checkText(text) {
        if (!this.enabled) return [];          // 开关关闭：跳过扫描（命中提示不再触发）
        const hits = [];
        this.words.forEach(w => {
            if (text.includes(w.word)) {          // 子串包含即算命中（含中英文混合场景）
                hits.push(w);
                w.count = (w.count || 0) + 1;     // 触发次数 +1（统计与识别触发）
            }
        });
        if (hits.length > 0) this.save();         // 有命中才写盘，避免每次扫描都触发 localStorage 写入
        return hits;
    }

    /**
     * 用命中词替换模板中的 {words} 占位符，生成待填入输入框的前缀。
     * @param {Array<{word:string, count:number}>} hits 命中词条
     * @returns {string} 生成的前缀（整段带括号，用户可再编辑）
     */
    generatePrefix(hits) {
        const wordsStr = hits.map(h => h.word).join(' / ');
        return this.prefixTemplate.replace(/\{words\}/g, wordsStr);
    }

    /** 订阅 AI 回复完成事件：命中后广播 MODERATOR_HIT 通知 UI @returns {void} */
    _initListener() {
        bus.on(EVENTS.ASSISTANT_DONE, (text) => {
            if (!text) return;                    // 空回复不扫描
            const hits = this.checkText(text);
            if (hits.length > 0) {
                bus.emit(EVENTS.MODERATOR_HIT, hits); // 引擎 → UI：交 UI 层弹提示
            }
        });
    }
}

/** 禁止词引擎单例：副作用导入即完成加载与订阅 */
export const moderator = new ModeratorEngine();
