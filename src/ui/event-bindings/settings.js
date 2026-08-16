/**
 * 设置面板事件绑定（Stage 3 解耦产出，原 bindSettingsEvents）。
 *
 * 红线相关：本模块通过 `setTempSettings()` 整体替换暂存对象（定义见 temp-settings.js），
 * 对 tempSettings 的逐属性赋值保持原样（对 import 活绑定改属性合法）。
 * 本模块级可变状态仅被本函数使用，原属 api.js，随 bindSettingsEvents 一并迁入。
 *
 * 方法1 集成说明：DOM 结构已由 index.html 的 #modal 换成新视觉（星空仿真框 / 分段服务商标签 /
 *   URL·KEY 气泡 / 模型点击展开），id 仍对齐本模块依赖的 set-*；数据层（tempSettings / applySettings）
 *   完全沿用项目实现。专注预览（immersive-experience）已移除。
 *   本轮简化：移除字号调节（含仿真预览与浮动气泡）、移除「自定义」服务商标签、提示词改为原地 Textarea、
 *   模型名点击直接展开、URL/KEY 点击自动聚焦输入框、重置按钮移出「高级 API 选项」折叠并改为 RESET 文字按钮、
 *   接入 armClickConfirm 做二次点击确认（替代原生 confirm）。
 */
import { DOM } from '../../core/dom.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { Logger } from '../../core/logger.js';
import { state } from '../../core/store.js';
import { saveToLocal } from '../../core/storage.js';
import { getProviderByUrl, safeParseInt, ensureKeysObject } from '../../core/utils.js';
import { DEFAULT_SETTINGS } from '../../core/constants.js';
import { tempSettings, setTempSettings } from './temp-settings.js';
import { updateInputLayout } from '../input-renderer.js';
import {
    applySettings, checkProviderMatch, populateModelSelect,
    showModelOptions, hideModelOptions
} from '../../chat/tree.js';
import { armClickConfirm } from './click-confirm.js';

/** 沉浸预览前的已提交遮罩值 —— 取消时用于回退实时预览的改动 @type {number} */
let bgDimPreviewBackup = 0.4;

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
    // 打开
    DOM.settingsIcon.addEventListener('click', () => {
        setTempSettings(JSON.parse(JSON.stringify(state.settings)));
        ensureKeysObject(tempSettings);
        if (!tempSettings.availableModels) tempSettings.availableModels = [];
        bgDimPreviewBackup = state.settings.bgDimOpacity;

        const currentProvider = getProviderByUrl(tempSettings.apiUrl);
        tempSettings.keys[currentProvider] = tempSettings.apiKey;

        DOM.setApiUrl.value = tempSettings.apiUrl;
        DOM.setApiKey.value = tempSettings.apiKey;
        DOM.setBgDim.value = tempSettings.bgDimOpacity * 100; // 0-1 转为 0-100
        DOM.setBgDimVal.textContent = Math.round(tempSettings.bgDimOpacity * 100) + '%';
        DOM.setAiName.value = tempSettings.aiName;
        DOM.setSysPrompt.value = tempSettings.sysPrompt;
        populateModelSelect(tempSettings.availableModels, tempSettings.model);
        checkProviderMatch();
        syncSim();
        openModal('modal');
    });

    // 确认
    DOM.modalClose.addEventListener('click', () => {
        Object.assign(state.settings, tempSettings);
        state.settings.keys = { ...tempSettings.keys };
        applySettings();
        updateInputLayout();
        if (DOM.bgDimLayer) DOM.bgDimLayer.style.opacity = state.settings.bgDimOpacity; // 保存后才应用到真实遮罩层（滑块拖动仅预览仿真框，用户要求"保存后才生效"）
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

    // API URL 输入
    DOM.setApiUrl.addEventListener('input', () => {
        tempSettings.apiUrl = DOM.setApiUrl.value;
        checkProviderMatch();
    });

    // API Key 输入
    DOM.setApiKey.addEventListener('input', () => {
        tempSettings.apiKey = DOM.setApiKey.value;
        const provider = getProviderByUrl(tempSettings.apiUrl);
        ensureKeysObject(tempSettings);
        tempSettings.keys[provider] = tempSettings.apiKey;
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
    });

    // 重置 API（二次确认：首次点击进入「待确认」态，再次点击才执行；armClickConfirm 替代原生 confirm 弹窗）
    function resetApi() {
        tempSettings.apiUrl = DEFAULT_SETTINGS.apiUrl;
        tempSettings.apiKey = DEFAULT_SETTINGS.apiKey;
        tempSettings.model = DEFAULT_SETTINGS.model;

        const provider = getProviderByUrl(tempSettings.apiUrl);
        ensureKeysObject(tempSettings);
        tempSettings.keys[provider] = tempSettings.apiKey;

        DOM.setApiUrl.value = DEFAULT_SETTINGS.apiUrl;
        DOM.setApiKey.value = DEFAULT_SETTINGS.apiKey;
        tempSettings.availableModels = [DEFAULT_SETTINGS.model];
        populateModelSelect(tempSettings.availableModels, DEFAULT_SETTINGS.model);
        checkProviderMatch();
    }
    armClickConfirm(DOM.btnResetApi, resetApi, { armedText: '确认重置?' });

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
            populateModelSelect(modelIds, tempSettings.model);
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

    // 系统提示词：原地 Textarea 输入（不再进入全屏编辑器）
    DOM.setSysPrompt.addEventListener('input', () => {
        tempSettings.sysPrompt = DOM.setSysPrompt.value;
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
        const type = btn.dataset.save;
        if (type === 'url') { if (tagUrl) tagUrl.classList.toggle('llm-tag--set', !!DOM.setApiUrl.value.trim()); }
        else if (type === 'key') { if (tagKey) tagKey.classList.toggle('llm-tag--set', DOM.setApiKey.value.trim().length > 4); }
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
