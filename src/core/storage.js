/**
 * 持久化存储 — localStorage 读写
 *
 * 职责：把 state 的 chatTree / settings / stats / msgIdCounter 落盘与回载。
 *       存档采用「白名单」策略：只有 DEFAULT_SETTINGS 出现的键才写入，未来新增配置自动纳入。
 *       监控统计（stats）跨刷新保留，清空对话时由 resetMonitorStats 归零。
 *
 * 导出：saveToLocal, loadFromLocal, debouncedSave
 * 依赖：core/logger, core/state, core/dom, core/tree-core（migrateErrorFlags, getLastNodeInPath）
 */
import { Logger } from './logger.js';
import { showToast } from './toast.js'; // 保存/加载失败改为可见提示（不再仅 console.warn 静默）
import { state } from './store.js';
import { DEFAULT_SETTINGS, STORAGE_KEY } from './constants.js';
import { ensureKeysObject } from './utils.js';
import { DOM } from './dom.js';
import { migrateErrorFlags, getLastNodeInPath } from './tree-core.js';

/** 防抖保存定时器句柄 @type {number|null} */
let saveTimer = null;
/** 保存指示器显隐定时器句柄 @type {number|null} */
let indicatorTimer = null;

/**
 * 保存状态到 localStorage
 * @param {string} [message='已保存'] - 显示在指示器上的消息；传 null 表示不更新文案
 * @param {boolean} [silent=false] - 静默模式，不显示指示器动画
 */
export function saveToLocal(message = '已保存', silent = false) {
    try {
        // 1. 动态生成白名单：基于 DEFAULT_SETTINGS 的键，未来新增配置自动纳入存档
        const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));

        // 2. 深拷贝 settings，仅保留白名单内字段，避免写入运行时派生数据
        const cleanSettings = {};
        for (const key in state.settings) {
            if (allowedKeys.has(key)) {
                cleanSettings[key] = state.settings[key];
            }
        }

        // 3. 落盘：chatTree + 清洗后的 settings + 监控统计 + 自增计数器 + 版本号
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            chatTree: state.chatTree,
            settings: cleanSettings,      // 使用清洗后的对象（白名单过滤）
            stats: state.stats,           // 累计 token / 缓存等监控数据（对话级，跨刷新保留）
            msgIdCounter: state.msgIdCounter,
            version: 3
        }));

        if (!silent && message) {
            DOM.saveIndicator.textContent = message;
            DOM.saveIndicator.classList.add('show');
            clearTimeout(indicatorTimer);
            indicatorTimer = setTimeout(() => {
                DOM.saveIndicator.classList.remove('show');
            }, 1200);
        }
    } catch (e) {
        // 保存失败原仅 console.warn（用户无感知，属共因 B 静默失败）。
        // 典型场景：localStorage 写满（大量聊天/语音缓存）→ QuotaExceededError。
        // 改为可见 toast，让用户知道存档可能不完整。
        if (e && e.name === 'QuotaExceededError') {
            showToast('存档空间不足，部分对话或设置可能未能保存，建议清理对话或导出备份', 'error', 5000);
        } else {
            Logger.warn('[Storage] 保存失败', e);
        }
    }
}

/** 防抖保存 — 800ms 内多次调用合并为一次，降低频繁写入。 @returns {void} */
export function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveToLocal(null, true), 800);
}

/**
 * 从 localStorage 加载状态
 * @returns {boolean} 是否加载成功（无存档 / 结构非法时返回 false）
 */
export function loadFromLocal() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return false;
        const data = JSON.parse(saved);
        if (!data.chatTree || data.chatTree.role !== 'system') return false;

        state.chatTree = data.chatTree;
        state.msgIdCounter = data.msgIdCounter || 0;

        if (data.settings && typeof data.settings === 'object') {
            // 白名单过滤回载：只合并 DEFAULT_SETTINGS 存在的键（防止历史存档残留的
            // 已删除设置进入运行时——否则会随 state.settings 流入导出；落盘侧本就白名单，此过滤保证两边一致）
            const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
            const filtered = {};
            for (const key in data.settings) {
                if (allowedKeys.has(key)) filtered[key] = data.settings[key];
            }
            Object.assign(state.settings, filtered);
            ensureKeysObject(state.settings);
            if (!Array.isArray(state.settings.availableModels)) {
                state.settings.availableModels = [];
            }
        }

        // 合并监控统计（累计 token 等），缺失字段用 state.stats 默认值补齐
        if (data.stats && typeof data.stats === 'object') {
            Object.assign(state.stats, data.stats);
        }

        migrateErrorFlags(state.chatTree);                 // 旧数据推导 isError 标记
        state.currentEndNode = getLastNodeInPath(state.chatTree); // 恢复到当前路径末端
        return true;
    } catch (e) {
        // 坏存档（半截 JSON / 结构非法）解析失败：若不清除，下次刷新仍读它 → 永久失败循环。
        // 清档 + 提示，让用户从干净状态启动（聊天记录会丢，但能正常进入；留着坏档才会卡死）。
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 清不掉也无所谓，下一行已 return false */ }
        showToast('本地存档已损坏，已重置为空白会话', 'warn', 5000);
        Logger.warn('[Storage] 加载失败，已清除坏存档', e);
        return false;
    }
}
