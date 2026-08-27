/**
 * 树状对话分支管理 + 渲染 + 监控面板 + 设置应用
 *
 * 职责（单文件内篇幅最大的模块，按职责仍聚焦「对话数据」）：
 *   1. 树节点创建 / 路径导航 / 分支切换
 *   2. （对话 DOM 渲染已迁出）→ 见 ui/render/tree-render.js（stage4）
 *   3. 监控统计的合并与面板刷新
 *   4. 设置如何应用到 UI（applySettings 等纯函数）
 *   5. （事件绑定已迁出）bindEvents 聚合逻辑现位于 ui/event-bindings（stage3）
 *
 * 导出（本模块直接定义）：setNodeError, initChatTree, applySettings,
 *       checkProviderMatch, populateModelSelect, showModelOptions, hideModelOptions,
 *       sendMessage, regenerate, editAndResend
 * 导出（re-export）：createNode / migrateErrorFlags / getCurrentPath / getLastNodeInPath /
 *       buildApiMessages / findMaxId  ← 来自 core/tree-core.js；
 *       splitSentences               ← 来自 core/text-split.js；
 *       renderContent / buildMsgDom / refreshFooter / renderMessage /
 *       renderChat / updateMsgContent / updateCacheUI / updateMonitorUI /
 *       ingestUsage / resetMonitorStats  ← 来自 ui/render/tree-render.js（stage4 迁出，整体 re-export 保持对外 API 不变）
 * 依赖：core/dom, core/logger, core/state, core/bus（发消息改走事件总线）,
 *       core/tree-core（6 个纯函数已下移，此处 re-export）,
 *       engines/bg-engine,
 *       ui/render/tree-render（渲染/监控显示函数已迁出，此处 re-export）,
 *       chat/api（不再 import；发消息走 core/bus，bind* 事件注册已迁 ui/event-bindings）, ui/event-bindings（tempSettings 活绑定）
 */
import { DOM } from '../core/dom.js';
import { splitSentences } from '../core/text-split.js';
import { Logger } from '../core/logger.js';
import { state } from '../core/store.js';
import { WELCOME, ERROR_PREFIX, DEFAULT_PROVIDER } from '../core/constants.js';
import { getEffectiveSysPrompt, touchIndex } from '../core/session-data.js';
import { BgEngine } from '../engines/bg-engine.js';
// 输入相关事件（openFSEditor / bindFsEditorEvents）已迁至 ui/event-bindings，本模块不再直接引用。
// 来自事件绑定层 event-bindings 的「设置暂存」活绑定（stage3 解耦：bind* 事件注册已迁到 ui/event-bindings）。
// 仅保留 tempSettings 这一个活绑定，供 checkProviderMatch / populateModelSelect 读取当前编辑中的设置。
import { tempSettings } from '../ui/event-bindings/index.js';

// 应用级事件总线（零依赖）：发消息流程改走事件，消除 tree → api 的硬编码函数引用
import { bus, EVENTS } from '../core/bus.js';

// 纯数据逻辑已抽离到 core/tree-core.js（stage1：解除 core→chat 反向依赖 + 可 Node 单测）。
// 此处仅 import 并 re-export，保持对外 API（api.js / main.js 的命名导入）不变。
import {
    createNode,
    migrateErrorFlags,
    getCurrentPath,
    getLastNodeInPath,
    buildApiMessages,
    findMaxId
} from '../core/tree-core.js';
export {
    createNode,
    migrateErrorFlags,
    getCurrentPath,
    getLastNodeInPath,
    buildApiMessages,
    findMaxId
};

// 视图层（对话 DOM 渲染 + 监控显示）已迁出至 ui/render/tree-render.js（stage4）。
// tree.js 收尾为「数据操作 + 设置应用」；渲染函数经此 import 供内部调用，
// 并整体 re-export 保持 main.js / api.js / event-bindings 的既有导入不变。
import { renderChat, updateMsgContent } from '../ui/render/tree-render.js';
export * from '../ui/render/tree-render.js';

// ================================================================
//  树状对话分支管理
//  每条消息是一个节点，节点的 children 是回复列表
//  selectedChildIndex 决定当前展示的分支
// ================================================================

// createNode 已移至 core/tree-core.js（本文件 re-export，对外 API 不变）

/** 将节点标记为错误状态 @param {object} node @param {string} message */
export function setNodeError(node, message) {
    node.isError = true;
    node._autoReadArmed = false; // 修⑧：错误节点不再自动朗读（防 _autoReadArmed 残留 → 后续重渲染整条重读）
    updateMsgContent(node, `${ERROR_PREFIX}\n${message}`);
}

// migrateErrorFlags 已移至 core/tree-core.js（本文件 re-export，对外 API 不变）

/**
 * 初始化对话树 — 创建系统节点与欢迎消息。
 * 关键约定：欢迎消息同时带一段本地模拟思维链，用来展示思维链 UI；它不参与 API 请求，
 * 因为 buildApiMessages 会按节点的 role/content 组装上下文，而 reasoning 只是渲染层运行时字段。
 */
export function initChatTree() {
    state.chatTree = createNode("system", getEffectiveSysPrompt());
    const welcome = createNode("assistant", WELCOME);
    welcome.reasoning = '好开心！'; // 仅用于首屏演示思维链，不伪造模型返回，也不写入请求上下文。
    state.chatTree.children.push(welcome);
    state.currentEndNode = welcome;
    renderChat();
}

// getCurrentPath 已移至 core/tree-core.js（本文件 re-export，对外 API 不变）

// getLastNodeInPath 已移至 core/tree-core.js（本文件 re-export，对外 API 不变）

/**
 * 兜底：确保 state.currentEndNode 始终指向有效节点。
 * 异常/坏档/初始化竞态下 currentEndNode 可能为 null（state.js 初值即 null），
 * 而 sendMessage 会对 currentEndNode.children 直接解引用——
 * null 即抛 TypeError 把整条发消息链路打死。
 * 恢复策略（不丢已有对话）：存在对话树时回落到当前路径末节点（getLastNodeInPath），
 * 连树都没有才重建欢迎树（initChatTree 会渲染并落 welcome 节点）。
 * @returns {object} 有效的末端节点
 */
export function ensureCurrentEndNode() {
    if (state.currentEndNode) return state.currentEndNode;
    if (state.chatTree) {
        state.currentEndNode = getLastNodeInPath(state.chatTree) || state.chatTree;
    } else {
        initChatTree();
    }
    return state.currentEndNode;
}

// splitSentences 已抽离到 src/core/text-split.js（纯函数，便于单元测试）。
// 旧实现把 ~ ～ … 也当句尾断句，导致分句渲染下单行文本被拆成多行气泡（已修复的历史 bug）。
// 此处仅重新导出，保持 tree.js 对外 API 不变。
export { splitSentences };

// buildApiMessages 已移至 core/tree-core.js（本文件 re-export，对外 API 不变）

/** 发送新消息 @param {string} text */
export function sendMessage(text) {
    if (!text.trim() || state.waiting) return;
    state.waiting = true;

    BgEngine.triggerMessage('user', text);

    const parentUserNode = ensureCurrentEndNode();
    const userNode = createNode("user", text);
    parentUserNode.children.push(userNode);
    parentUserNode.selectedChildIndex = parentUserNode.children.length - 1;
    state.currentEndNode = userNode;

    const aiNode = createNode("assistant", "");
    userNode.children.push(aiNode);
    state.currentEndNode = aiNode;

    touchIndex(state.activeSessionId); // 发消息即触索引 updatedAt：会话列表「刚发消息自然在顶部」（流式期间即时反馈，落盘由 saveSession 带出）
    renderChat();
    const apiMessages = buildApiMessages(aiNode);
    // 改走事件总线：本模块不再直接 import api.js 的 executeStreamRequest，循环依赖削掉一条边。
    // 载荷带齐发送所需的全部数据（消息体 + AI 节点引用 + 所属会话 id），api.js 订阅后照常执行流式请求。
    bus.emit(EVENTS.STREAM_REQUEST, { apiMessages, aiNode, sessionId: state.activeSessionId });
}

/** 重新生成 AI 回复 @param {object} node @param {object} parentNode */
export function regenerate(node, parentNode) {
    if (state.waiting) return;
    state.waiting = true;

    let aiNode;
    if (node.isError) {
        // 错误重试：原地复用该节点（清空错误内容重发），不 push 新子节点——
        // 否则每次重试都在 parent 下多一个分支，分支导航被连续错误/重试淹没（用户 2026-08-21 反馈）
        node.isError = false;
        node.content = '';
        aiNode = node;
    } else {
        // 正常重新生成：新节点 = 新分支（保留旧回复可切换对比）
        aiNode = createNode("assistant", "");
        parentNode.children.push(aiNode);
    }
    parentNode.selectedChildIndex = parentNode.children.indexOf(aiNode);
    state.currentEndNode = aiNode;

    touchIndex(state.activeSessionId); // 发消息即触索引 updatedAt（同 sendMessage）
    renderChat();
    const apiMessages = buildApiMessages(aiNode);
    // 改走事件总线：本模块不再直接 import api.js 的 executeStreamRequest，循环依赖削掉一条边。
    // 载荷带齐发送所需的全部数据（消息体 + AI 节点引用 + 所属会话 id），api.js 订阅后照常执行流式请求。
    bus.emit(EVENTS.STREAM_REQUEST, { apiMessages, aiNode, sessionId: state.activeSessionId });
}

/** 编辑用户消息并重新发送 @param {object} node @param {object} parentNode @param {string} newText */
export function editAndResend(node, parentNode, newText) {
    if (!newText.trim() || state.waiting) return;
    state.waiting = true;

    BgEngine.triggerMessage('user', newText);

    const userNode = createNode("user", newText);
    parentNode.children.push(userNode);
    parentNode.selectedChildIndex = parentNode.children.length - 1;

    const aiNode = createNode("assistant", "");
    userNode.children.push(aiNode);
    state.currentEndNode = aiNode;

    touchIndex(state.activeSessionId); // 发消息即触索引 updatedAt（同 sendMessage）
    renderChat();
    const apiMessages = buildApiMessages(aiNode);
    // 改走事件总线：本模块不再直接 import api.js 的 executeStreamRequest，循环依赖削掉一条边。
    // 载荷带齐发送所需的全部数据（消息体 + AI 节点引用 + 所属会话 id），api.js 订阅后照常执行流式请求。
    bus.emit(EVENTS.STREAM_REQUEST, { apiMessages, aiNode, sessionId: state.activeSessionId });
}

// findMaxId 已移至 core/tree-core.js（本文件 re-export，对外 API 不变）

// ================================================================
//  设置管理（纯函数：把设置应用到 UI 与状态，不含事件绑定）
// ================================================================

/** 应用消息气泡不透明度（单一消费点）。
 *  把 settings.bubbleOpacity 写入 :root --bubble-opacity；全部气泡底色（默认皮肤/语音条/错误泡/主题气泡）
 *  统一以 calc(α * var(--bubble-opacity)) 消费该 token（见 waifu.css / tts.css / chat.css / quick-themes.js）。
 *  钳位 0~1 容错脏档；applySettings（启动/保存）与设置页取消回退均经此应用。 */
export function applyBubbleOpacity() {
    const v = Number(state.settings.bubbleOpacity);
    document.documentElement.style.setProperty('--bubble-opacity',
        (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1).toString());
}

/** 应用设置到 UI 和状态 */
export function applySettings() {
    // 根 content 同步为「有效系统提示词」：当前会话有覆盖则用覆盖，否则全局默认（会话级覆盖 + 全局默认双轨）
    if (state.chatTree) state.chatTree.content = getEffectiveSysPrompt();
    // 构建来源后缀：本地构建=本地，GitHub Actions 构建=github（由 vite.config.js 经 import.meta.env.VITE_BUILD_ENV 注入）
    // http.server 原生 ESM 无 import.meta.env，&& 短路后回退 '本地'，双模式兼容
    document.title = state.settings.aiName + ' · ' + (import.meta.env && import.meta.env.VITE_BUILD_ENV || '本地');
    // --msg-font-size 已由 tokens.css 提供默认 16px（chat.css 消费），字号设置移除后不再用 JS 覆写（2026-08-16）
    applyBubbleOpacity(); // 气泡底色不透明度 token（含启动恢复/保存提交/取消回退的统一入口）
    // 有效系统提示词已随上面同步到根 content，此处广播变更事件（prompt-bar 据此刷新状态徽/点亮态）
    bus.emit(EVENTS.SYS_PROMPT_CHANGE, getEffectiveSysPrompt());
}

/** 模型变更通知：设置页「思考强度」分段需随模型预设刷新（树.js 不 import settings.js，走 DOM 事件解耦避免循环依赖） */
function notifyModelChange() {
    DOM.setModelOptions.dispatchEvent(new CustomEvent('modelchange', { bubbles: false }));
}

/** 检查当前编辑的服务商匹配哪个服务商标签（基于 tempSettings.__curProvider 高亮；已移除「自定义」标签） */
export function checkProviderMatch() {
    const cur = tempSettings.__curProvider || DEFAULT_PROVIDER;
    document.querySelectorAll('.provider-tab').forEach(t => {
        t.classList.toggle('segmented__item--active', t.dataset.provider === cur);
    });
    DOM.providerHint.textContent = '';
}

/** 渲染自定义模型下拉选项 @param {Array<string>} models @param {string} selectedValue */
export function populateModelSelect(models, selectedValue) {
    DOM.setModelOptions.innerHTML = '';

    // 合并模型列表（去重）
    const set = new Set([...models, ...(tempSettings.availableModels || [])]);
    if (selectedValue && !set.has(selectedValue)) set.add(selectedValue);
    tempSettings.availableModels = Array.from(set);

    // 渲染模型选项
    tempSettings.availableModels.forEach(m => {
        const opt = document.createElement('div');
        opt.className = 'custom-option';
        opt.textContent = m;
        if (m === selectedValue) opt.classList.add('selected');
        opt.onclick = (e) => {
            e.stopPropagation();
            const cp = tempSettings.__curProvider || DEFAULT_PROVIDER;
            tempSettings.providers[cp].model = m;
            DOM.setModelText.textContent = m;
            notifyModelChange(); // 思考强度分段（设置页）随模型预设刷新
            hideModelOptions();
        };
        DOM.setModelOptions.appendChild(opt);
    });

    // 分割线
    const divider = document.createElement('div');
    divider.className = 'custom-option divider';
    DOM.setModelOptions.appendChild(divider);

    // 手动输入选项
    const customOpt = document.createElement('div');
    customOpt.className = 'custom-option';
    customOpt.textContent = '手动输入...';
    customOpt.onclick = (e) => {
        e.stopPropagation();
        const inputModel = prompt('请输入模型名称:');
        if (inputModel) {
            const cp = tempSettings.__curProvider || DEFAULT_PROVIDER;
            tempSettings.providers[cp].model = inputModel;
            DOM.setModelText.textContent = inputModel;
            tempSettings.availableModels.push(inputModel);
            populateModelSelect(tempSettings.availableModels, inputModel);
            notifyModelChange(); // 思考强度分段（设置页）随模型预设刷新
        }
        hideModelOptions();
    };
    DOM.setModelOptions.appendChild(customOpt);

    DOM.setModelText.textContent = selectedValue || '请选择模型';
}

/** 展开模型下拉框 — 使用 fixed 定位避免被父级 overflow:hidden 裁剪 */
export function showModelOptions() {
    DOM.setModelText.classList.add('open');
    const rect = DOM.setModelText.getBoundingClientRect();
    DOM.setModelOptions.style.position = 'fixed';
    DOM.setModelOptions.style.top = (rect.bottom + 4) + 'px';
    DOM.setModelOptions.style.left = rect.left + 'px';
    DOM.setModelOptions.style.width = rect.width + 'px';
    DOM.setModelOptions.style.zIndex = 200;
    document.body.appendChild(DOM.setModelOptions);
    DOM.setModelOptions.classList.add('show');
}

/** 收起模型下拉框 */
export function hideModelOptions() {
    DOM.setModelText.classList.remove('open');
    DOM.setModelOptions.classList.remove('show');
}

// 事件绑定聚合 bindEvents 已迁至 ui/event-bindings/index.js（stage3）。
// main.js 现在直接从该层 import bindEvents；本模块不再负责聚合事件注册。

// 订阅：错误气泡内联重试（tree-render 发布 RETRY_REQUEST，本模块处理 regenerate；解耦 树↔渲染 的循环依赖）
bus.on(EVENTS.RETRY_REQUEST, (detail) => {
    // 兜底：regenerate 内部会置 state.waiting=true 并发起流式；若它同步抛错，
    // dispatchEvent 吞掉异常后 waiting 永不复位 → 输入框锁死。此处捕获并复位。
    try {
        if (detail && detail.node && detail.parent) regenerate(detail.node, detail.parent);
    } catch (err) {
        Logger.error('[Tree] 处理 RETRY_REQUEST 失败', err);
        state.waiting = false;
    }
});
