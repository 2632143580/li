/**
 * 设置面板事件绑定（Stage 3 解耦产出，原 bindSettingsEvents）。
 *
 * 红线相关：本模块通过 `setTempSettings()` 整体替换暂存对象（定义见 temp-settings.js），
 * 对 tempSettings 的逐属性赋值保持原样（对 import 活绑定改属性合法）。
 * 本模块级可变状态仅被本函数使用，原属 api.js，随 bindSettingsEvents 一并迁入。
 *

 */
import { DOM } from '../../core/dom.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { Logger } from '../../core/logger.js';
import { state } from '../../core/store.js';
import { saveToLocal, saveSession } from '../../core/storage.js';
import { getProviderByUrl, safeParseInt, ensureKeysObject } from '../../core/utils.js';
import { DEFAULT_SETTINGS } from '../../core/constants.js';
import { tempSettings, setTempSettings } from './temp-settings.js';
import { updateInputLayout } from '../input-renderer.js';
import {
    applySettings, checkProviderMatch, populateModelSelect,
    showModelOptions, hideModelOptions
} from '../../chat/tree.js';
import { renderChat } from '../render/tree-render.js';
import { matchThinkingPreset } from '../../core/thinking.js';
import { armClickConfirm } from './click-confirm.js';

/**
 * 系统提示词「当前编辑值」：会话级覆盖的暂存。
 * 文本输入框改的是「当前会话」的覆盖值（null = 继承全局默认）；「设为全局默认」才写到 state.settings.sysPrompt。
 * @type {string}
 */
let pendingSysPrompt = '';

/** 沉浸预览前的已提交遮罩值 —— 取消时用于回退实时预览的改动 @type {number} */
let bgDimPreviewBackup = 0.4;

/** 打开设置面板时思维链两开关的已提交快照 —— 保存时对比，变更才 renderChat（避免无谓重渲染） @type {{show:boolean, auto:boolean}} */
let reasoningSnapshot = { show: true, auto: true };

/**
 * 渲染「思考强度」分段（用户 2026-08-22 要求）：按 tempSettings.model 匹配预设（core/thinking.js）。
 * 无预设模型隐藏整行；有效值不在选项内时回落预设默认（换模型后旧档位自动归位）。
 * @returns {void}
 */
function renderThinkingUI() {
    if (!DOM.setThinkingRow || !DOM.setThinkingSeg || !DOM.setThinkingHint) return;
    const preset = matchThinkingPreset(tempSettings.model || '');
    if (!preset) {
        DOM.setThinkingRow.style.display = 'none';
        return;
    }
    DOM.setThinkingRow.style.display = '';
    DOM.setThinkingHint.textContent = preset.title;
    if (!preset.options.some((o) => o.value === tempSettings.reasoningEffort)) {
        tempSettings.reasoningEffort = preset.default;
    }
    DOM.setThinkingSeg.innerHTML = preset.options.map((o) =>
        `<button type="button" class="voice-seg-btn${o.value === tempSettings.reasoningEffort ? ' active' : ''}" data-v="${o.value}">${o.label}</button>`
    ).join('');
}

/** 仿真框专用元素（仅供视觉预览，非项目数据） */
const dimSimOverlay = DOM.bgDimSim;
const tagUrl = document.getElementById('tag-url');
const tagKey = document.getElementById('tag-key');
const bubbleUrl = document.getElementById('bubbleUrl');
const bubbleKey = document.getElementById('bubbleKey');

/** 设置面板：打开 / 确认 / 取消 / 表单交互 */
import { registerUI } from '../../core/registry.js';
registerUI('settings', bindSettingsEvents);

export function bindSettingsEvents() {
    // URL/KEY 标签（tag-url/tag-key）按实际值同步「已填」高亮：
    // 未填时不带 llm-tag--set → CSS 显示虚线框（待填写提示）。与气泡保存逻辑同口径（url 非空 / key 长度>4）。
    function syncTagStates() {
        if (tagUrl) tagUrl.classList.toggle('llm-tag--set', !!String(tempSettings.apiUrl || '').trim());
        if (tagKey) tagKey.classList.toggle('llm-tag--set', String(tempSettings.apiKey || '').trim().length > 4);
    }

    // 打开
    DOM.settingsIcon.addEventListener('click', () => {
        setTempSettings(JSON.parse(JSON.stringify(state.settings)));
        ensureKeysObject(tempSettings);
        // 模型清单是内存缓存（state.availableModels，不序列化）：挂到暂存对象供 populateModelSelect 读改
        tempSettings.availableModels = state.availableModels;
        bgDimPreviewBackup = state.settings.bgDimOpacity;

        const currentProvider = getProviderByUrl(tempSettings.apiUrl);
        tempSettings.keys[currentProvider] = tempSettings.apiKey;

        DOM.setApiUrl.value = tempSettings.apiUrl;
        DOM.setApiKey.value = tempSettings.apiKey;
        DOM.setBgDim.value = tempSettings.bgDimOpacity * 100; // 0-1 转为 0-100
        DOM.setBgDimVal.textContent = Math.round(tempSettings.bgDimOpacity * 100) + '%';
        DOM.setAiName.value = tempSettings.aiName;
        // 思维链两开关（用户 2026-08-22 自语音设置移入）：暂存进 tempSettings，点「保存」才生效（与遮罩浓度同口径）
        if (DOM.setShowReasoning) DOM.setShowReasoning.checked = !!tempSettings.showReasoning;
        if (DOM.setReasoningAutoExpand) DOM.setReasoningAutoExpand.checked = !!tempSettings.reasoningAutoExpand;
        if (DOM.setShowEcgWave) DOM.setShowEcgWave.checked = !!tempSettings.showEcgWave; // 波形监护仪开关：仅控右侧波形 canvas（爱心恒显），暂存进 tempSettings，点「保存」才生效
        reasoningSnapshot = {
            show: !!state.settings.showReasoning,
            auto: !!state.settings.reasoningAutoExpand,
            ecg: !!state.settings.showEcgWave
        };
        renderThinkingUI(); // 思考强度分段按当前模型预设渲染
        // 系统提示词输入框显示「当前会话有效值」：有会话级覆盖则显示覆盖，否则显示全局默认
        pendingSysPrompt = (state.sessionSysPrompt != null) ? state.sessionSysPrompt : state.settings.sysPrompt;
        DOM.setSysPrompt.value = pendingSysPrompt;
        populateModelSelect(tempSettings.availableModels, tempSettings.model);
        checkProviderMatch();
        syncSim();
        syncTagStates(); // 打开即按当前值刷标签态（虚线框/实心框），不依赖 HTML 写死的 class
        openModal('modal');
    });

    // 确认
    DOM.modalClose.addEventListener('click', () => {
        // sysPrompt 不走 tempSettings 合并（它由「当前会话级覆盖」管理，见下方单独处理），先剔除避免污染全局默认
        delete tempSettings.sysPrompt;
        Object.assign(state.settings, tempSettings);
        state.settings.keys = { ...tempSettings.keys };
        // 写入当前会话的系统提示词覆盖值（null 已由上面清理，这里恒写为字符串覆盖；清空覆盖请改用「设为全局默认」）
        state.sessionSysPrompt = pendingSysPrompt;
        applySettings(); // 内部把根 content 同步为有效系统提示词（覆盖优先）
        updateInputLayout();
        // 思维链两开关（自语音设置移入）+ 心电图显示开关：保存才生效；与打开时快照对比，任一变更都重渲染聊天区
        const reasoningChanged = reasoningSnapshot.show !== !!state.settings.showReasoning
            || reasoningSnapshot.auto !== !!state.settings.reasoningAutoExpand
            || reasoningSnapshot.ecg !== !!state.settings.showEcgWave;
        if (reasoningChanged) renderChat();
        if (DOM.bgDimLayer) DOM.bgDimLayer.style.opacity = state.settings.bgDimOpacity; // 保存后才应用到真实遮罩层（滑块拖动仅预览仿真框，用户要求"保存后才生效"）
        saveSession(state.activeSessionId); // 会话级覆盖随会话键落盘
        saveToLocal('设置已保存');
        closeAllModals();
    });

    // 取消
    DOM.modalCancel.addEventListener('click', () => {
        state.settings.bgDimOpacity = bgDimPreviewBackup; // 回退实时预览改动
        if (DOM.bgDimLayer) DOM.bgDimLayer.style.opacity = state.settings.bgDimOpacity; // 同步回退 CSS 遮罩层可见效果（opacity 合成器友好，零重绘）
        applySettings();
        updateInputLayout();
        closeAllModals();
    });

    // 点击遮罩关闭
    DOM.modal.addEventListener('click', (e) => {
        if (e.target === DOM.modal) {
            state.settings.bgDimOpacity = bgDimPreviewBackup;
            if (DOM.bgDimLayer) DOM.bgDimLayer.style.opacity = state.settings.bgDimOpacity;
            applySettings();
            updateInputLayout();
            closeAllModals();
        }
    });

    // Escape 关闭（与词云/语音/导航/日志统一模态交互：还原遮罩预览 + 套用设置 + 重排输入 + 关全部）
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && getComputedStyle(DOM.modal).display !== 'none') {
            state.settings.bgDimOpacity = bgDimPreviewBackup;
            if (DOM.bgDimLayer) DOM.bgDimLayer.style.opacity = state.settings.bgDimOpacity;
            applySettings();
            updateInputLayout();
            closeAllModals();
        }
    });

    // API URL 输入
    DOM.setApiUrl.addEventListener('input', () => {
        tempSettings.apiUrl = DOM.setApiUrl.value;
        checkProviderMatch();
        syncTagStates(); // 实时反映虚线框/实心框
    });

    // API Key 输入
    DOM.setApiKey.addEventListener('input', () => {
        tempSettings.apiKey = DOM.setApiKey.value;
        const provider = getProviderByUrl(tempSettings.apiUrl);
        ensureKeysObject(tempSettings);
        tempSettings.keys[provider] = tempSettings.apiKey;
        syncTagStates(); // 实时反映虚线框/实心框
    });

    // AI 名字
    DOM.setAiName.addEventListener('input', () => {
        tempSettings.aiName = DOM.setAiName.value;
    });

    // 背景遮罩浓度：拖动仅更新暂存值 + 仿真框预览；点「保存」才提交真实遮罩层 bg-dim-layer（用户要求"保存后才生效"）
    DOM.setBgDim.addEventListener('input', () => {
        const val = safeParseInt(DOM.setBgDim.value, 40);
        DOM.setBgDimVal.textContent = val + '%';
        tempSettings.bgDimOpacity = val / 100; // 转为 0-1 暂存（未提交）
        if (dimSimOverlay) dimSimOverlay.style.opacity = val / 100; // 仅仿真框实时预览
    });

    // 服务商标签切换（高亮 class 与新设计 .segmented__item--active 对齐；已移除「自定义」标签）
    DOM.providerTabs.addEventListener('click', (e) => {
        if (!e.target.classList.contains('provider-tab')) return;
        const tab = e.target;
        const provider = tab.dataset.provider;
        const url = tab.dataset.url;

        document.querySelectorAll('.provider-tab').forEach(t => t.classList.remove('segmented__item--active'));
        tab.classList.add('segmented__item--active');

        const oldProvider = getProviderByUrl(tempSettings.apiUrl);
        ensureKeysObject(tempSettings);
        tempSettings.keys[oldProvider] = tempSettings.apiKey;

        if (url) {
            tempSettings.apiUrl = url;
            DOM.setApiUrl.value = url;
        }

        tempSettings.apiKey = tempSettings.keys[provider] || '';
        DOM.setApiKey.value = tempSettings.apiKey;
        DOM.providerHint.textContent = '';

        // 切服务商 → 模型与服务商一一匹配：只显示「目标服务商自己的缓存清单」，
        //   不串号（绝不把别家模型混进本家下拉）、不清空（别家缓存不动）、不滞留（切到 B 就只显 B 的）。
        //   目标有缓存 → 切到它的清单（当前模型仍在清单内则保留，否则选首个）；
        //   目标无缓存（还没拉取过）→ 显示空清单，这是它"自己"合法状态，不是被清空。
        const targetModels = (state.modelCache[provider] || []).slice();
        state.availableModels = targetModels;
        tempSettings.availableModels = targetModels;
        if (!targetModels.includes(tempSettings.model)) tempSettings.model = targetModels[0] || '';
        populateModelSelect(tempSettings.availableModels, tempSettings.model);
        if (DOM.setModelText) DOM.setModelText.textContent = tempSettings.model || '未选择';
        renderThinkingUI(); // 切服务商换模型后，思考强度分段按新模型预设刷新

        syncTagStates(); // 切标签后 URL/KEY 都变了，刷新虚线框/实心框
    });

    // ===== 思考与思维链（用户 2026-08-22：自语音设置移入 + 新增思考强度） =====
    // 显示思维链 / 自动展开：仅改暂存，点「保存」随 tempSettings 一并提交
    if (DOM.setShowReasoning) {
        DOM.setShowReasoning.addEventListener('change', () => {
            tempSettings.showReasoning = DOM.setShowReasoning.checked;
        });
    }
    if (DOM.setReasoningAutoExpand) {
        DOM.setReasoningAutoExpand.addEventListener('change', () => {
            tempSettings.reasoningAutoExpand = DOM.setReasoningAutoExpand.checked;
        });
    }
    // 波形监护仪开关：仅改暂存，点「保存」随 tempSettings 一并提交（renderChat 在保存时按快照比对重渲染）。
    // 注意：本开关只控右侧波形 canvas；左侧 love.svg 爱心与折叠头一体，不受此开关影响。
    if (DOM.setShowEcgWave) {
        DOM.setShowEcgWave.addEventListener('change', () => {
            tempSettings.showEcgWave = DOM.setShowEcgWave.checked;
        });
    }
    // 思考强度分段点击：更新暂存档位 + 高亮
    if (DOM.setThinkingSeg) {
        DOM.setThinkingSeg.addEventListener('click', (e) => {
            const btn = e.target.closest('.voice-seg-btn');
            if (!btn) return;
            tempSettings.reasoningEffort = btn.dataset.v;
            DOM.setThinkingSeg.querySelectorAll('.voice-seg-btn').forEach((b) => {
                b.classList.toggle('active', b === btn);
            });
        });
    }
    // 模型下拉选中（含手动输入）→ tree.js 派发 modelchange 事件 → 分段按新预设刷新
    if (DOM.setModelOptions) {
        DOM.setModelOptions.addEventListener('modelchange', renderThinkingUI);
    }

    // 模型列表刷新（图标按钮：用 .spinning 旋转代替文案，避免覆盖 SVG）
    DOM.btnFetchModels.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (DOM.btnFetchModels.classList.contains('spinning')) return;
        DOM.btnFetchModels.classList.add('spinning');
        try {
            let modelsUrl = tempSettings.apiUrl.replace(/\/chat\/completions/, '/models');
            if (!modelsUrl.endsWith('/models')) {
                modelsUrl = modelsUrl.replace(/\/$/, '') + '/models';
            }
            const resp = await fetch(modelsUrl, {
                method: "GET",
                headers: { "Authorization": "Bearer " + tempSettings.apiKey }
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const models = data.data || data.models || [];
            if (models.length === 0) throw new Error("未获取到模型");
            const modelIds = models.map(m => m.id || m.name);
            const curProvider = getProviderByUrl(tempSettings.apiUrl);
            state.modelCache[curProvider] = modelIds;   // 按服务商缓存已拉取模型清单
            state.availableModels = modelIds;
            tempSettings.availableModels = modelIds;
            // 自动配套：当前模型为空或不在本批清单内时，选首个
            if (!tempSettings.model || !modelIds.includes(tempSettings.model)) tempSettings.model = modelIds[0];
            populateModelSelect(modelIds, tempSettings.model);
            if (DOM.setModelText) DOM.setModelText.textContent = tempSettings.model;
            renderThinkingUI(); // 拉取后自动配套的模型可能变化，分段按新模型刷新
            saveToLocal(null, true);                     // 持久化 modelCache 随全局键落 localStorage（不进导出备份）
            showModelOptions();
        } catch (err) {
            Logger.error('[Models] 获取模型列表失败', err);
        } finally {
            setTimeout(() => DOM.btnFetchModels.classList.remove('spinning'), 600);
        }
    });

    // 模型名称点击展开/收起（无箭头，直接点击模型名）
    DOM.setModelText.addEventListener('click', (e) => {
        e.stopPropagation();
        if (DOM.setModelOptions.classList.contains('show')) hideModelOptions();
        else showModelOptions();
    });
    document.addEventListener('click', (e) => {
        if (!DOM.setModelOptions.contains(e.target) && !DOM.setModelText.contains(e.target)) {
            hideModelOptions();
        }
    });

    // 系统提示词：原地 Textarea 输入（不再进入全屏编辑器）。改的是「当前会话」的覆盖值暂存，不直接写全局默认
    DOM.setSysPrompt.addEventListener('input', () => {
        pendingSysPrompt = DOM.setSysPrompt.value;
    });
    // 「设为全局默认」：把当前文本框值提升为全局默认，并清除当前会话覆盖（使其继承新默认）；其它会话不受影响
    const sysPromptGlobal = document.getElementById('sys-prompt-global');
    if (sysPromptGlobal) sysPromptGlobal.addEventListener('click', () => {
        pendingSysPrompt = DOM.setSysPrompt.value;
        state.settings.sysPrompt = pendingSysPrompt;
        state.sessionSysPrompt = null; // 当前会话改回继承全局默认
        applySettings();
        saveToLocal('已设为全局默认');
    });
    DOM.sysPromptImport.addEventListener('click', () => DOM.fileImportPrompt.click());
    DOM.fileImportPrompt.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            DOM.setSysPrompt.value = text;
            tempSettings.sysPrompt = text;
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // API Key 显示/隐藏（图标按钮：仅切换 type，不写文案以免清空 SVG）
    DOM.apiKeyToggle.addEventListener('click', () => {
        DOM.setApiKey.type = DOM.setApiKey.type === 'password' ? 'text' : 'password';
    });

    // 语音设置里的云端 MiMo API Key 同样加「眼睛」（复用 LLM Key 的眼睛逻辑）
    if (DOM.cloudKeyToggle) {
        DOM.cloudKeyToggle.addEventListener('click', () => {
            DOM.setCloudKey.type = DOM.setCloudKey.type === 'password' ? 'text' : 'password';
        });
    }

    // ---------- 气泡 popover（URL / KEY / 字号） ----------
    function closeAllBubbles() {
        [bubbleUrl, bubbleKey].forEach(b => b && b.classList.remove('show'));
        document.removeEventListener('click', outsideClickListener);
    }
    function outsideClickListener(e) {
        if (e.target.closest('.llm-bubble') || e.target.closest('.float-bubble') ||
            e.target.closest('.llm-tag')) return;
        closeAllBubbles();
    }
    function registerOutside() {
        document.removeEventListener('click', outsideClickListener);
        document.addEventListener('click', outsideClickListener);
    }
    function positionBubble(bubbleEl, triggerEl) {
        const bubbleWidth = bubbleEl.offsetWidth || 200;
        const t = triggerEl.getBoundingClientRect();
        const parent = bubbleEl.offsetParent || document.body;
        const containerRect = parent.getBoundingClientRect();
        let left = t.left + t.width / 2 - bubbleWidth / 2;
        let arrow = t.left + t.width / 2 - left;
        const margin = 10;
        if (left < margin) { arrow -= (margin - left); left = margin; }
        else if (left + bubbleWidth > window.innerWidth - margin) {
            const offset = (left + bubbleWidth) - (window.innerWidth - margin);
            arrow -= offset; left = window.innerWidth - margin - bubbleWidth;
        }
        arrow = Math.max(16, Math.min(bubbleWidth - 16, arrow));
        bubbleEl.style.left = (left - containerRect.left) + 'px';
        bubbleEl.style.transform = 'translateX(0) translateY(0) scale(1)';
        bubbleEl.style.setProperty('--arrow-left', arrow + 'px');
    }
    function openBubble(bubble, trigger) {
        closeAllBubbles();
        bubble.classList.add('show');
        void bubble.offsetWidth;
        positionBubble(bubble, trigger);
        registerOutside();
    }

    // URL / KEY 标签 → 打开对应气泡
    if (tagUrl) tagUrl.addEventListener('click', (e) => { e.stopPropagation(); openBubble(bubbleUrl, tagUrl); DOM.setApiUrl.focus(); });
    if (tagKey) tagKey.addEventListener('click', (e) => { e.stopPropagation(); openBubble(bubbleKey, tagKey); DOM.setApiKey.focus(); });

    // 气泡内取消/保存
    document.querySelectorAll('.llm-bubble__btn[data-close]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); closeAllBubbles(); }));
    document.querySelectorAll('.llm-bubble__btn[data-save]').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        syncTagStates(); // 保存后按当前输入值刷新标签态（虚线框/实心框）
        closeAllBubbles();
    }));

    // 气泡内元素点击不冒泡关闭
    document.querySelectorAll('.llm-bubble, .float-bubble').forEach(el => el.addEventListener('click', e => e.stopPropagation()));

    // 仿真框同步（打开时调用）
    function syncSim() {
        if (dimSimOverlay) dimSimOverlay.style.opacity = tempSettings.bgDimOpacity;
        DOM.setBgDimVal.textContent = Math.round(tempSettings.bgDimOpacity * 100) + '%';
    }
}
