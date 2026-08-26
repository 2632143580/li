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
import { ensureKeysObject, KEY_PROVIDERS } from '../../core/utils.js';
import { saveToLocal, saveSession } from '../../core/storage.js';
import { renumberTreeIds } from '../../core/sessions.js';
import { serializeTree, ensureNodeDefaults } from '../../core/tree-core.js';
import { updateInputLayout } from '../input-manager.js';
import {
    applySettings, migrateErrorFlags,
    getLastNodeInPath, renderChat, initChatTree, updateCacheUI, resetMonitorStats
} from '../../chat/tree.js';
import { clearAutoQueue } from '../../engines/tts-engine.js'; // 修⑥：清空对话即停播放 + 清空自动朗读队列

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
        // keys 槽位白名单浅拷（剔除运行时可能被写入的 custom 槽位，与 cleanSettingsForSave 同口径）
        if (cleanSettings.keys) {
            const keyObj = {};
            for (const p of KEY_PROVIDERS) keyObj[p] = cleanSettings.keys[p] || '';
            cleanSettings.keys = keyObj;
        }
        // 脱敏 + 不序列化：导出备份不得含 LLM / 云端 TTS 的端点 / 密钥 / 模型。
        // url 是死的、key 存本地、模型现拉存本地——三者只活在本机 localStorage，绝不随备份文件泄露。
        const masked = JSON.parse(JSON.stringify(cleanSettings));
        delete masked.apiUrl;     // LLM 端点
        delete masked.apiKey;     // LLM 密钥
        delete masked.keys;       // 按服务商密钥
        delete masked.model;      // LLM 模型（现拉，非硬编码）
        delete masked.ttsCloud;   // 云端 TTS 整体（baseUrl / model / apiKey / voice）
        // 序列化：保留换行但不带缩进空格。
        // 缩进空格量随聊天树深度平方增长（曾致导出 518KB），故用 \t 缩进生成带换行的 JSON 后删掉所有 \t，
        // 仅留换行（1 字节/个，线性、几乎不占空间）——可读且体积回落到裸数据量，JSON.parse 仍兼容。
        const dataStr = JSON.stringify({
            settings: masked,
            // 白名单序列化（P4-10）：与 persistSession 落盘同口径，剔除节点运行时标记
            chatTree: serializeTree(state.chatTree)
        }, null, '\t').replace(/\t/g, '');
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
                    // 白名单合并：只接受 DEFAULT_SETTINGS 存在的键，防止备份文件夹带未知/恶意键污染运行时（修 P2 ⑤）。
                    // 密钥字段（apiKey/keys/ttsCloud）不随导入覆盖——导出已脱敏为 ''，若回灌会清空用户当前真实 Key；
                    // 用户导入后自行重填即可（你已确认「key 无所谓」）。
                    const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
                    // 密钥与端点 / 模型均不随导入覆盖（导出已剔除，回灌会清空用户当前真实配置）；
                    // 用户导入后自行重填 / 重新拉取即可。涵盖 llm 的 apiUrl/model/apiKey/keys 与 tts 整体。
                    const SECRET_KEYS = new Set(['apiUrl', 'model', 'apiKey', 'keys', 'ttsCloud']);
                    for (const key in importedData.settings) {
                        if (!allowedKeys.has(key) || SECRET_KEYS.has(key)) continue;
                        state.settings[key] = importedData.settings[key];
                    }
                    ensureKeysObject(state.settings);
                }
                if (importedData.chatTree && importedData.chatTree.role === 'system') {
                    // 整树重编号：用全局 msgIdCounter 统一分配 id，杜绝导入树与现有会话 id 撞车（否则 domCache 串台 / 后台回调写错气泡）
                    renumberTreeIds(importedData.chatTree);
                    state.chatTree = importedData.chatTree;
                    ensureNodeDefaults(state.chatTree); // 补回序列化省略的默认值（selectedChildIndex/reasoning/children/isError）
                    migrateErrorFlags(state.chatTree);  // 精确推导 isError 标记
                }
                applySettings();
                updateInputLayout();
                closeAllModals();
                state.currentEndNode = getLastNodeInPath(state.chatTree);
                renderChat();
                saveSession(state.activeSessionId); // 落当前会话键 + 重建索引条目（标题/计数/预览）
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
        clearAutoQueue(); // 修⑥：清空对话即停当前播放 + 清空自动朗读队列（避免旧消息后台继续响）
        initChatTree();
        updateCacheUI(0);
        resetMonitorStats(); // 新一轮对话：累计 token / 缓存等归零
        saveToLocal('已清空');
    }, { armedText: '再次点击确认清空' });
}
