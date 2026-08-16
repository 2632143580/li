/**
 * 全量导入 / 导出 / 清空 事件绑定（Stage 3 解耦产出，原 bindDataExchangeEvents）。
 * 仅依赖 DOM 门面、state 单例、storage 与 chat/tree 的渲染/重置活函数。
 */
import { DOM } from '../../core/dom.js';
import { Logger } from '../../core/logger.js';
import { armClickConfirm } from './click-confirm.js';
import { state } from '../../core/store.js';
import { DEFAULT_SETTINGS } from '../../core/constants.js';
import { closeAllModals } from '../../core/modal.js';
import { ensureKeysObject } from '../../core/utils.js';
import { saveToLocal } from '../../core/storage.js';
import { updateInputLayout } from '../input-renderer.js';
import {
    applySettings, findMaxId, migrateErrorFlags,
    getLastNodeInPath, renderChat, initChatTree, updateCacheUI, resetMonitorStats
} from '../../chat/tree.js';

/** 全量导入 / 导出 / 清空 */
import { registerUI } from '../../core/registry.js';
registerUI('data-exchange', bindDataExchangeEvents);

export function bindDataExchangeEvents() {
    // 全量导出
    DOM.btnExportAll.addEventListener('click', () => {
        // 导出按 DEFAULT_SETTINGS 白名单过滤 settings（与 saveToLocal 落盘同款）：
        // 防止历史存档残留的已删除设置键（如旧版 maxTokens）被带进备份 JSON
        const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
        const cleanSettings = {};
        for (const key in state.settings) {
            if (allowedKeys.has(key)) cleanSettings[key] = state.settings[key];
        }
        const dataStr = JSON.stringify({
            settings: cleanSettings,
            chatTree: state.chatTree
        }, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `li_backup_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 100);
    });

    // 全量导入
    DOM.btnImportAll.addEventListener('click', () => DOM.fileImportAll.click());
    DOM.fileImportAll.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedData = JSON.parse(event.target.result);
                if (importedData.settings && typeof importedData.settings === 'object') {
                    Object.assign(state.settings, importedData.settings);
                    ensureKeysObject(state.settings);
                }
                if (importedData.chatTree && importedData.chatTree.role === 'system') {
                    state.chatTree = importedData.chatTree;
                    state.msgIdCounter = Math.max(state.msgIdCounter, findMaxId(state.chatTree));
                    migrateErrorFlags(state.chatTree);
                }
                applySettings();
                updateInputLayout();
                closeAllModals();
                state.currentEndNode = getLastNodeInPath(state.chatTree);
                renderChat();
                saveToLocal('已导入');
            } catch (err) {
                alert("解析备份文件失败");
                Logger.error('[Import] 全量导入解析失败', err);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // 清空对话：二次点击确认（替代原生 confirm，避免打断操作流、移动端友好）
    armClickConfirm(DOM.btnClearChat, () => {
        initChatTree();
        updateCacheUI(0);
        resetMonitorStats(); // 新一轮对话：累计 token / 缓存等归零
        saveToLocal('已清空');
    }, { armedText: '再次点击确认清空' });
}
