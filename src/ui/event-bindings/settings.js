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
import { fetchModelsForProvider, syncAvailableModels } from '../../core/models.js';
import { showToast } from '../../core/toast.js';
import { safeParseInt, ensureKeysObject } from '../../core/utils.js';
import { DEFAULT_SETTINGS, DEFAULT_PROVIDER } from '../../core/constants.js';
import { tempSettings, setTempSettings } from './temp-settings.js';
import { updateInputLayout } from '../input-manager.js';
import {
    applySettings, checkProviderMatch, populateModelSelect,
    showModelOptions, hideModelOptions
} from '../../chat/tree.js';
import { renderChat } from '../render/tree-render.js';
import { matchThinkingPreset } from '../../core/thinking.js';
import { armClickConfirm } from './click-confirm.js';

/** 设置页当前正在编辑的服务商（分段控件切换即改；URL/Key/模型输入与保存都面向它） @type {string} */
let curProvider = DEFAULT_PROVIDER;

/** 沉浸预览前的已提交遮罩值 —— 取消时用于回退实时预览的改动 @type {number} */
let bgDimPreviewBackup = 0.4;

/** 沉浸预览前的已提交气泡不透明度 —— 取消时用于回退（与 bgDimPreviewBackup 同口径） @type {number} */
let bubbleOpacityPreviewBackup = 1;

/** 打开设置面板时思维链两开关的已提交快照 —— 保存时对比，变更才 renderChat（避免无谓重渲染） @type {{show:boolean, auto:boolean}} */
let reasoningSnapshot = { show: true, auto: true };

/**
 * 渲染「思考强度」分段（用户 2026-08-22 要求）：按 tempSettings.providers[curProvider].model 匹配预设（core/thinking.js）。
 * 无预设模型隐藏整行；有效值不在选项内时回落预设默认（换模型后旧档位自动归位）。
 * @returns {void}
 */
function renderThinkingUI() {
    if (!DOM.setThinkingRow || !DOM.setThinkingSeg || !DOM.setThinkingHint) return;
    const preset = matchThinkingPreset(tempSettings.providers[curProvider].model || '');
    if (!preset) {
        DOM.setThinkingRow.style.display = 'none';
        return;
    }
    DOM.setThinkingRow.style.display = '';
    DOM.setThinkingHint.textContent = preset.title;
    const re = tempSettings.providers[curProvider].reasoningEffort;
    if (!preset.options.some((o) => o.value === re)) {
        tempSettings.providers[curProvider].reasoningEffort = preset.default;
    }
    DOM.setThinkingSeg.innerHTML = preset.options.map((o) =>
        `<button type="button" class="voice-seg-btn${o.value === tempSettings.providers[curProvider].reasoningEffort ? ' active' : ''}" data-v="${o.value}">${o.label}</button>`
    ).join('');
}

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
        if (tagUrl) tagUrl.classList.toggle('llm-tag--set', !!String(tempSettings.providers[curProvider].url || '').trim());
        if (tagKey) tagKey.classList.toggle('llm-tag--set', String(tempSettings.keys[curProvider] || '').trim().length > 4);
    }

    // 打开
    DOM.settingsIcon.addEventListener('click', () => {
        setTempSettings(JSON.parse(JSON.stringify(state.settings)));
        ensureKeysObject(tempSettings);
        // 模型清单是内存缓存（state.availableModels，不序列化）：挂到暂存对象供 populateModelSelect 读改
        tempSettings.availableModels = state.availableModels;
        bgDimPreviewBackup = state.settings.bgDimOpacity;
        bubbleOpacityPreviewBackup = state.settings.bubbleOpacity;

        curProvider = DEFAULT_PROVIDER;
        tempSettings.__curProvider = curProvider;

        DOM.setApiUrl.value = tempSettings.providers[curProvider].url || '';
        DOM.setApiKey.value = tempSettings.keys[curProvider] || '';
        DOM.setBgDim.value = tempSettings.bgDimOpacity * 100; // 0-1 转为 0-100
        DOM.setBgDimVal.textContent = Math.round(tempSettings.bgDimOpacity * 100) + '%';
        DOM.setBubbleOpacity.value = Math.round((tempSettings.bubbleOpacity ?? 1) * 100); // 0-1 转为 0-100（?? 1 容错老档缺键）
        DOM.setBubbleOpacityVal.textContent = Math.round((tempSettings.bubbleOpacity ?? 1) * 100) + '%';
        // 思维链两开关（用户 2026-08-22 自语音设置移入）：暂存进 tempSettings，点「保存」才生效（与遮罩浓度同口径）
        if (DOM.setShowReasoning) DOM.setShowReasoning.checked = !!tempSettings.showReasoning;
        if (DOM.setReasoningAutoExpand) DOM.setReasoningAutoExpand.checked = !!tempSettings.reasoningAutoExpand;

        reasoningSnapshot = {
            show: !!state.settings.showReasoning,
            auto: !!state.settings.reasoningAutoExpand,
        };
        renderThinkingUI(); // 思考强度分段按当前模型预设渲染
        populateModelSelect(tempSettings.availableModels, tempSettings.providers[curProvider].model);
        checkProviderMatch();
        syncSim();
        syncTagStates(); // 打开即按当前值刷标签态（虚线框/实心框），不依赖 HTML 写死的 class
        openModal('modal');
    });

    // 确认
    DOM.modalClose.addEventListener('click', () => {
        delete tempSettings.__curProvider;
        Object.assign(state.settings, tempSettings);
        state.settings.keys = { ...tempSettings.keys };
        state.settings.providers = JSON.parse(JSON.stringify(tempSettings.providers));
        applySettings(); // 内部把根 content 同步为有效系统提示词（覆盖优先）
        updateInputLayout();
        // 思维链两开关（自语音设置移入）+ 心电图显示开关：保存才生效；与打开时快照对比，任一变更都重渲染聊天区
        const reasoningChanged = reasoningSnapshot.show !== !!state.settings.showReasoning
            || reasoningSnapshot.auto !== !!state.settings.reasoningAutoExpand;
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
        state.settings.bubbleOpacity = bubbleOpacityPreviewBackup; // 气泡不透明度同口径回退（token 由下方 applySettings → applyBubbleOpacity 重写）
        applySettings();
        updateInputLayout();
        closeAllModals();
    });

    // 点击遮罩关闭
    DOM.modal.addEventListener('click', (e) => {
        if (e.target === DOM.modal) {
            state.settings.bgDimOpacity = bgDimPreviewBackup;
            if (DOM.bgDimLayer) DOM.bgDimLayer.style.opacity = state.settings.bgDimOpacity;
            state.settings.bubbleOpacity = bubbleOpacityPreviewBackup;
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
            state.settings.bubbleOpacity = bubbleOpacityPreviewBackup;
            applySettings();
            updateInputLayout();
            closeAllModals();
        }
    });

    // API URL 输入
    DOM.setApiUrl.addEventListener('input', () => {
        tempSettings.providers[curProvider].url = DOM.setApiUrl.value;
        checkProviderMatch();
        syncTagStates(); // 实时反映虚线框/实心框
    });

    // API Key 输入
    DOM.setApiKey.addEventListener('input', () => {
        tempSettings.keys[curProvider] = DOM.setApiKey.value;
        syncTagStates(); // 实时反映虚线框/实心框
    });

    // 背景遮罩浓度：拖动仅更新暂存值；点「保存」才提交真实遮罩层 bg-dim-layer（用户要求"保存后才生效"）
    DOM.setBgDim.addEventListener('input', () => {
        const val = safeParseInt(DOM.setBgDim.value, 40);
        DOM.setBgDimVal.textContent = val + '%';
        tempSettings.bgDimOpacity = val / 100; // 转为 0-1 暂存（未提交）
    });

    // 消息气泡不透明度：拖动仅更新暂存值 + 百分比文字（无仿真框，真实气泡背景在设置面板遮罩之下不可预览）；
    // 点「保存」经 applySettings → applyBubbleOpacity 写 :root --bubble-opacity 才生效（与遮罩浓度同口径）
    DOM.setBubbleOpacity.addEventListener('input', () => {
        const val = safeParseInt(DOM.setBubbleOpacity.value, 100);
        DOM.setBubbleOpacityVal.textContent = val + '%';
        tempSettings.bubbleOpacity = val / 100; // 转为 0-1 暂存（未提交）
    });

    // 服务商标签切换（高亮 class 与新设计 .segmented__item--active 对齐；已移除「自定义」标签）
    // 分段控件只切「当前正在编辑的服务商」，URL/Key/模型都面向该服务商的分桶，互不覆盖
    DOM.providerTabs.addEventListener('click', (e) => {
        if (!e.target.classList.contains('provider-tab')) return;
        const tab = e.target;
        const provider = tab.dataset.provider;

        document.querySelectorAll('.provider-tab').forEach(t => t.classList.remove('segmented__item--active'));
        tab.classList.add('segmented__item--active');

        // 切到目标服务商：更新当前编辑服务商，输入框绑定该服务商的配置
        curProvider = provider;
        tempSettings.__curProvider = provider;

        DOM.setApiUrl.value = tempSettings.providers[curProvider].url || '';
        DOM.setApiKey.value = tempSettings.keys[curProvider] || '';
        DOM.providerHint.textContent = '';

        // 该服务商自己的缓存清单（不串号、不清空、不滞留）：经 syncAvailableModels 统一写入口同步，
        // 消灭散落的「直接赋值 state.availableModels」双源漂移
        syncAvailableModels(provider);
        tempSettings.availableModels = state.availableModels;
        populateModelSelect(tempSettings.availableModels, tempSettings.providers[curProvider].model);
        // 显示口径只看「是否配置了 model」：清单为空（该服务商未拉取过）时 model 配置依然有效，
        // 不得用 includes(清单) 误判成「未选择」（曾致：切服务商后已配置模型显示丢失、切回仍丢，
        // 退出设置页再进来又恢复——同一份配置两套显示口径）。
        if (DOM.setModelText) DOM.setModelText.textContent = tempSettings.providers[curProvider].model || '未选择';
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

    // 思考强度分段点击：更新暂存档位 + 高亮
    if (DOM.setThinkingSeg) {
        DOM.setThinkingSeg.addEventListener('click', (e) => {
            const btn = e.target.closest('.voice-seg-btn');
            if (!btn) return;
            tempSettings.providers[curProvider].reasoningEffort = btn.dataset.v;
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
            // 复用 core/models.js 单一实现（URL 变换 / 10s 超时 / modelCache 持久化全部内聚，消除本处重复 fetch）；
            // 设置页暂存的 url/key 经 overrides 传入——与 api.js 请求层同口径（暂存值 > 已保存配置 > 死常量兜底）
            const modelIds = await fetchModelsForProvider(curProvider, {
                apiKey: tempSettings.keys[curProvider],
                apiUrl: tempSettings.providers[curProvider].url
            });
            syncAvailableModels(curProvider); // 拉取内已写 modelCache，此处同步派生列表（唯一写入口）
            tempSettings.availableModels = state.availableModels;
            // 拉取仅刷新清单：当前模型为空或不在本批清单内时清空（让用户显选），绝不自动配套清单首
            if (!tempSettings.providers[curProvider].model || !modelIds.includes(tempSettings.providers[curProvider].model)) tempSettings.providers[curProvider].model = '';
            populateModelSelect(modelIds, tempSettings.providers[curProvider].model);
            if (DOM.setModelText) DOM.setModelText.textContent = tempSettings.providers[curProvider].model || '未选择';
            renderThinkingUI(); // 拉取后自动配套的模型可能变化，分段按新模型刷新
            showModelOptions();
        } catch (err) {
            // 失败不再静默（此前仅 console.error，用户点了按钮毫无反馈）：toast 可见，含超时/HTTP 具体原因
            Logger.error('[Models] 获取模型列表失败', err);
            showToast('模型清单拉取失败：' + (err?.message || err), 'warn');
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

    // 打开时同步遮罩浓度数值显示
    function syncSim() {
        DOM.setBgDimVal.textContent = Math.round(tempSettings.bgDimOpacity * 100) + '%';
    }
}
