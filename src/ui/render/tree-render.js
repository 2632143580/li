/**
 * 对话视图层：对话 DOM 的增量渲染 + 监控统计显示
 *
 * 职责（stage4 从 chat/tree.js 迁出，使 tree.js 收尾为「数据操作」）：
 *   1. 单条消息 DOM 构建与样式钩子（buildMsgDom）
 *   2. 内容渲染（renderContent：普通文本 / 都显示 / 语音条；W2 起 waifu 套用同一路径）
 *   3. 列表增量渲染（renderMessage / renderChat）
 *   4. 监控统计显示（updateCacheUI / updateMonitorUI / ingestUsage / resetMonitorStats）
 *
 * 依赖约束（关键）：本文件只依赖 core 层与 ui/context-menu，绝不反向依赖 chat/tree.js 或
 *   chat/api.js 的业务逻辑。tree.js 通过 `import { renderChat, ... }` 调用本层，形成
 *   tree.js → ui/render/tree-render.js 的单向边，彻底消除 tree ↔ 渲染 的相互纠缠。
 *
 * 导入：
 *   - core/dom        DOM（#chat 等 id 句柄）
 *   - core/state      state（currentEndNode / waiting / waifuMode / domCache / stats / settings）
 *   - core/utils      formatTokens（token 数格式化）
 *   - core/storage    saveToLocal（分支导航按钮保存）
 *   - core/text-split splitSentences（妻子模式断句）
 *   - core/tree-core  getCurrentPath / getLastNodeInPath（纯数据，无 DOM）
 *   - ui/context-menu showContextMenu（消息右键菜单）
 *
 * 导出（均为视图函数，供 tree.js re-export 保持对外 API 不变）：
 *   getBubbleClass, renderContent, buildMsgDom, refreshFooter,
 *   renderMessage, renderChat, updateMsgContent, updateCacheUI,
 *   updateMonitorUI, ingestUsage, resetMonitorStats
 */
import { DOM } from '../../core/dom.js';
import { state } from '../../core/store.js';
import { formatTokens } from '../../core/utils.js';
import { saveToLocal } from '../../core/storage.js';
import { splitSentences } from '../../core/text-split.js';
import { cleanForSpeech } from '../../engines/tts-engine.js';
import { getCurrentPath, getLastNodeInPath } from '../../core/tree-core.js';
import { bus, EVENTS } from '../../core/bus.js';
import { showContextMenu } from '../context-menu.js';
import { renderVoiceTiles, renderBoth } from '../voice-tiles.js'; // 语音回复（句句发语音）；renderWaifuContent 为本模块本地定义

/**
 * 生成气泡外层容器的 className（buildMsgDom 与 renderMessage 共用，消除重复书写）
 *
 * 规则：
 *   - 普通模式：msg [role] chat-bubble chat-bubble--[role]
 *   - 语音条模式（AI + 语音开启 + 非错误）：msg ai（外层不带 chat-bubble，
 *       视觉载体是子 .vt 语音条——避免「大气泡套小语音气泡」的非 waifu 嵌套缺陷，用户 2026-08-14）
 *   - waifu 模式 AI（W2 起与普通模式同路径，外层 className 仅由 isVoice 决定；不再生成 .waifu-bubble 分句泡）
 *   - waifu 模式 user：同普通模式（user 不分句，统一 .msg）
 *   - 错误节点：强制带 chat-bubble--ai（.error-msg 挂在 .chat-bubble--ai 体系下）
 *
 * 关键不变量：外层带 chat-bubble 时，其内部只装「文字/分句泡」且 footer 在 bubble 之外；
 *   一旦外层不该有视觉气泡（语音条 / waifu 分句），就返回 'msg ai' 让子元素各自成气泡，
 *   绝不让外层大气泡包裹子气泡（见 2026-08-11.md 三层结构契约与本次嵌套修复）。
 *
 * @param {string} role - 'user' | 'assistant'
 * @param {boolean} waifuMode - 是否 waifu 模式
 * @param {boolean} [isError=false] - 是否错误节点
 * @param {boolean} [isVoice=false] - 是否语音条模式（AI + 语音开启 + 非错误）
 * @returns {string} className
 */
export function getBubbleClass(role, waifuMode, isError = false, isVoice = false) {
    // node.role 是 'user'/'assistant'，CSS 类名用 'user'/'ai'，需映射
    const cls = role === 'assistant' ? 'ai' : role;
    const base = `msg ${cls} chat-bubble chat-bubble--${cls}`;
    if (isError) return base;
    // 语音条模式（AI + 语音开启 + 非错误）：外层仅布局容器（msg ai），不带 chat-bubble 视觉类，
    // 真正的气泡由子元素 .vt 语音条承担，杜绝外层大气泡包裹子语音条（2026-08-11 嵌套修复）。
    // waifu 模式（W2）：语音开启时套普通布局（.vt 各自成气泡），纯文字时恢复分句气泡（.waifu-bubble 各自成气泡）；
    //   两者都让外层不带 chat-bubble，避免「大气泡套子气泡」嵌套缺陷。故 waifuMode 与 isVoice 同效。
    if ((waifuMode || isVoice) && role === 'assistant') return 'msg ai';
    return base;
}

/**
 * 该 AI 消息的渲染形态（受「文字消息显示模式」总控 +「发语音概率」按消息一次性掷骰）。
 * 显示模式（ttsDisplayMode）优先级最高：
 *   - 'text'  只显示文字：恒为纯文本，忽略语音回复开关与概率。
 *   - 'voice' 只显示语音：恒为语音条（原默认观感）；按「发语音概率」决定每条消息是否变语音条，其余纯文字。
 *   - 'both'  都显示（默认）：每条消息「语音条 + 文字」同时呈现（忽略发语音概率，永远都给）。
 * 硬条件：ttsEnabled 总开关关 → 退化纯文字；仅 assistant + 非错误。
 * 概率（仅 voice 模式生效）：每条消息首次渲染时掷一次 Math.random() < ttsProb，结果存 node._voiceChosen，
 * 保证流式多帧重渲染不反复翻转（同一消息稳定不变）。
 * @param {object} node @returns {'text'|'voice'|'both'}
 */
function getRenderKind(node) {
    if (node.role !== 'assistant' || node.isError) return 'text';
    if (!state.settings.ttsEnabled) return 'text';          // 语音回复总开关关 → 纯文字
    const mode = state.settings.ttsDisplayMode || 'both';
    if (mode === 'text') return 'text';                     // 只显示文字
    if (mode === 'voice') {                                  // 只显示语音：按概率决定本条是否变语音条
        const p = (typeof state.settings.ttsProb === 'number') ? state.settings.ttsProb : 1;
        if (node._voiceChosen === undefined) node._voiceChosen = Math.random() < p;
        return node._voiceChosen ? 'voice' : 'text';
    }
    return 'both';                                           // 都显示：语音条 + 文字（每条都给）
}

/**
 * 渲染消息内容到指定元素
 * 处理：错误样式、流式状态、妻子模式气泡、普通文本
 * @param {HTMLElement} contentEl @param {object} node
 */
export function renderContent(contentEl, node) {
    const isStreaming = (node === state.currentEndNode && state.waiting);

    const kind = getRenderKind(node);

    // 渲染子类型：waifu 在纯文字场景仍保留分句气泡（W2 仅语音/都显示套普通布局）
    let rk = kind;
    if (state.waifuMode && node.role === 'assistant' && !node.isError && kind === 'text') rk = 'waifu';
    const cur = contentEl.dataset.rk;
    if (cur && cur !== rk) contentEl.innerHTML = ''; // 模式切换强制清空重建（修复「切换显示模式不立即生效」）
    contentEl.dataset.rk = rk;

    if (rk === 'waifu') { renderWaifuContent(contentEl, node, isStreaming); return; }
    if (rk === 'voice') {
        renderVoiceTiles(contentEl, node, isStreaming);
        return;
    }
    if (rk === 'both') {
        // 都显示：每条消息同时呈现语音条 + 文字（逐句「波形在上、文字在下」），点击波形播该句、文字常显可读
        renderBoth(contentEl, node, isStreaming);
        return;
    }

    // 错误样式：.error-msg 挂到 bubble 外层（带 .chat-bubble--ai），与气泡结构共享。
    // 清除 contentEl 上的旧 .error-msg（兼容 domCache 残留）。
    contentEl.classList.remove('error-msg');
    const bubble = contentEl.parentElement;
    if (node.role === 'assistant' && node.isError) {
        if (bubble) bubble.classList.add('error-msg');
    } else {
        if (bubble) bubble.classList.remove('error-msg');
    }

    // 统一清理点：开头显式清除残留打字指示器（P4）。
    // 原因：流式增量渲染用 appendChild 追加子节点、不覆盖 contentEl 已有内容，
    // 而打字指示器是通过 innerHTML 写入的独立节点，不清除就会与后续内容并存并残留到对话结束。
    const staleDots = contentEl.querySelector('.typing-dots');
    if (staleDots) staleDots.remove();

    // 流式且无内容时显示打字指示器（出错节点不显示，避免与错误文案并存）
    if (isStreaming && !node.content && !node.isError) {
        contentEl.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
        return;
    }

    // 裁剪前导换行后再渲染：部分 API 首块会带前导 \n，配合 .msg 的 white-space:pre-wrap
    // 会渲染出"空行 + 消息"的伪空白行；前导换行对聊天无意义，直接剔除(内部换行保留)。
    contentEl.textContent = node.content.replace(/^[\r\n]+/, '');
    // 错误气泡内联重试按钮（根治：失败恢复从"手动编辑重发"降为一次点击）
    if (node.isError) {
        const retry = document.createElement('button');
        retry.className = 'msg-retry';
        retry.textContent = '↻ 重试';
        retry.addEventListener('click', (e) => {
            e.stopPropagation();
            const parent = findParentInTree(state.chatTree, node);
            // 走事件总线（tree-render 不 import tree.js，避免循环依赖；tree.js 订阅后调 regenerate）
            bus.emit(EVENTS.RETRY_REQUEST, { node: node, parent: parent });
        });
        contentEl.appendChild(retry);
    }
}

// 查找 node 的父节点（树节点不存 parent 引用——避免 JSON.stringify 循环引用，
// 故点击重试时沿树遍历找父，树深度浅，点击时一次遍历可接受） @param {object} root @param {object} target
function findParentInTree(root, target) {
    if (!root || root === target) return null;
    const stack = [root];
    while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur.children) continue;
        for (const ch of cur.children) {
            if (ch === target) return cur;
            stack.push(ch);
        }
    }
    return null;
}


/**
 * 构建消息 DOM 元素（三层结构，footer 移出气泡容器）
 *
 * 结构（自顶向下）：
 *   wrapper（根 — 接 contextmenu/touch 事件 / domCache 键值）
 *   ├── bubble（视觉气泡 — 被主题 .chat-bubble--ai/--user 命中）
 *   │   └── contentDiv（.bubble-content — 内容装载层，renderContent 操作它）
 *   └── footerDiv（.msg-footer — 分支导航；【关键】移出 bubble，主题给气泡上色时不会再"包裹"导航）
 *
 * 为什么要三层？
 *   旧结构把 footer 作为 bubble 的子元素，导致主题插件给 .chat-bubble--user 上色时，
 *   整个块（含 .branch-nav 分支图标）一起被上色——表现为"用户气泡下边的分支图标也被包裹"。
 *   重构后 bubble 只含 contentDiv（视觉内容），footer 独立挂在 wrapper 下，
 *   主题选择器命中范围收敛，结构契约清晰。
 *
 * @param {object} node @param {object} parentNode @returns {HTMLElement} wrapper 节点
 */
export function buildMsgDom(node, parentNode) {
    const wrapper = document.createElement('div');
    wrapper.dataset.id = node.id;

    // bubble：被主题插件命中的视觉气泡容器
    const bubble = document.createElement('div');
    // className 统一由 getBubbleClass 生成（buildMsgDom 与 renderMessage 共用，消除重复书写）。
    // isVoice：AI + 语音开启 + 非错误 → 外层不带 chat-bubble，语音条 .vt 自身成气泡（防嵌套）。
    // isVoice：AI + 语音开启 + 非错误 + 按 ttsProb 掷骰（getRenderKind 按消息一次性定，流式不翻转）
    const isVoice = getRenderKind(node) !== 'text';
    bubble.className = getBubbleClass(node.role, state.waifuMode, node.isError, isVoice);

    // contentDiv：内容装载层（透明），语音条 / 文字由 renderContent 写入；外层已隔离插件样式，无需额外中和。
    // 类名 .bubble-content 让 renderMessage 用 querySelector 定位，不依赖 firstChild 位置。
    const contentDiv = document.createElement('div');
    contentDiv.className = 'bubble-content';
    bubble.appendChild(contentDiv);

    wrapper.appendChild(bubble);

    // footer：移出 bubble，作为 wrapper 的兄弟节点 — 主题上色不再波及分支图标。
    const footerDiv = document.createElement('div');
    footerDiv.className = 'msg-footer';
    wrapper.appendChild(footerDiv);

    // 上下文菜单触发挂到 wrapper（点气泡/footer 都触发）
    const openMenu = (x, y) => showContextMenu(x, y, node, parentNode);
    wrapper.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
    });
    let touchTimer = null;
    wrapper.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        touchTimer = setTimeout(() => openMenu(touch.clientX, touch.clientY), 500);
    });
    wrapper.addEventListener('touchend', () => clearTimeout(touchTimer));
    wrapper.addEventListener('touchmove', () => clearTimeout(touchTimer));

    return wrapper;
}

/** 刷新消息底部（分支导航按钮） @param {HTMLElement} div @param {object} node @param {object} parentNode */
export function refreshFooter(div, node, parentNode) {
    const footerDiv = div.lastChild;
    footerDiv.innerHTML = '';

    const needsNav = parentNode && parentNode.children.length > 1;
    if (!needsNav) return;

    const nav = document.createElement('div');
    nav.className = 'branch-nav';
    const total = parentNode.children.length;
    const current = parentNode.selectedChildIndex + 1;

    // 左箭头
    const btnLeft = document.createElement('button');
    btnLeft.className = 'branch-btn';
    btnLeft.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>';
    btnLeft.disabled = parentNode.selectedChildIndex === 0;
    btnLeft.onclick = (e) => {
        e.stopPropagation();
        if (parentNode.selectedChildIndex > 0) {
            parentNode.selectedChildIndex--;
            state.currentEndNode = getLastNodeInPath(state.chatTree);
            renderChat();
            saveToLocal(null, true);
        }
    };

    const label = document.createElement('span');
    label.textContent = `${current} / ${total}`;

    // 右箭头
    const btnRight = document.createElement('button');
    btnRight.className = 'branch-btn';
    btnRight.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    btnRight.disabled = parentNode.selectedChildIndex === total - 1;
    btnRight.onclick = (e) => {
        e.stopPropagation();
        if (parentNode.selectedChildIndex < total - 1) {
            parentNode.selectedChildIndex++;
            state.currentEndNode = getLastNodeInPath(state.chatTree);
            renderChat();
            saveToLocal(null, true);
        }
    };

    nav.appendChild(btnLeft);
    nav.appendChild(label);
    nav.appendChild(btnRight);
    footerDiv.appendChild(nav);
}

/** 渲染单条消息（使用缓存或新建） @param {object} node @param {object} parentNode @returns {HTMLElement} */
export function renderMessage(node, parentNode) {
    let div = state.domCache.get(node.id);
    if (!div) {
        div = buildMsgDom(node, parentNode);
        state.domCache.set(node.id, div);
    }

    // 每次渲染按当前模式重新生成 className（用 getBubbleClass，与 buildMsgDom 共用）。
    // 消除旧补丁：domCache 复用的旧节点可能残留另一模式的 className，强制覆盖确保一致。
    const bubble = div.firstChild;
    // isVoice：运行时切换语音开关也要同步外层 className（文字气泡 ↔ 语音条容器）。
    // isVoice：AI + 语音开启 + 非错误 + 按 ttsProb 掷骰（getRenderKind 按消息一次性定，流式不翻转）
    const isVoice = getRenderKind(node) !== 'text';
    bubble.className = getBubbleClass(node.role, state.waifuMode, node.isError, isVoice);

    // 用 querySelector 定位 contentDiv，不依赖 firstChild 位置（更稳健）。
    renderContent(div.querySelector('.bubble-content'), node);
    refreshFooter(div, node, parentNode);
    return div;
}

/**
 * 渲染对话列表 — 基于当前路径增量更新 DOM
 * 1. 遍历当前路径，获取/创建 DOM
 * 2. 按顺序插入到 #chat
 * 3. 移除不在路径中的旧 DOM
 * 4. 清理过期的 domCache
 */
export function renderChat() {
    const path = getCurrentPath();
    const pathIds = new Set(path.map(n => n.id));
    const newChildren = [];

    for (let i = 1; i < path.length; i++) {
        const div = renderMessage(path[i], path[i - 1]);
        newChildren.push(div);
    }

    // 增量插入 — 仅在位置不匹配时移动
    for (let i = 0; i < newChildren.length; i++) {
        if (DOM.chat.children[i] !== newChildren[i]) {
            DOM.chat.insertBefore(newChildren[i], DOM.chat.children[i] || null);
        }
    }
    // 移除多余元素
    while (DOM.chat.children.length > newChildren.length) {
        DOM.chat.removeChild(DOM.chat.lastChild);
    }

    // 清理不在当前路径的缓存
    for (const [id, el] of state.domCache) {
        if (!pathIds.has(id)) state.domCache.delete(id);
    }

    DOM.chat.scrollTop = DOM.chat.scrollHeight;
    state.stats.totalMsg = path.length - 1; // 当前对话路径消息总条数
    updateMonitorUI();
}

// 流式 DOM 节流（根治）：rAF 合并——同帧多次 onChunk 只渲染最后一次内容，
// 避免每 chunk 直写 textContent + 强制 scrollTop 触发多次重排（高频流式每秒数十次）。
// node.content 每帧都在累积最新值，渲染时读到的必是最新，内容不丢、不卡顿。
let _streamFrame = null;
let _pendingStream = null;

/** 更新消息内容并刷新渲染（rAF 节流） @param {object} node @param {string} content */
export function updateMsgContent(node, content) {
    node.content = content; // 先落数据：即使 rAF 合并了多次 chunk，渲染读的也是最新
    const div = state.domCache.get(node.id);
    if (!div) return;
    const contentEl = div.querySelector('.bubble-content');
    if (!contentEl) return;
    // 只记录最新待渲染目标；若已有帧在等，本次 chunk 被合并（不重复排队）
    _pendingStream = { contentEl: contentEl, node: node };
    if (_streamFrame) return;
    _streamFrame = requestAnimationFrame(() => {
        _streamFrame = null;
        const p = _pendingStream;
        _pendingStream = null;
        if (!p) return;
        // 三层结构定位：div 是 wrapper，内容装载层是 .bubble-content（bubble 的子元素）。
        // 严禁用 div.firstChild（= bubble）：流式时会把气泡/文本直接挂到 bubble 直属，
        // 与后续 renderChat 重建的 contentDiv 内容并存 → 出现"同一消息两套气泡/两种样式"（本会话已修 bug）。
        renderContent(p.contentEl, p.node);
        DOM.chat.scrollTop = DOM.chat.scrollHeight;
    });
}

/** 更新缓存命中 UI @param {number} tokens */
export function updateCacheUI(tokens) {
    DOM.cacheHitVal.textContent = formatTokens(tokens);
    if (tokens > 0) DOM.cacheStatus.classList.add('hit');
    else DOM.cacheStatus.classList.remove('hit');
}

/**
 * 把一次 API 响应的 usage 合并进监控统计
 * @param {object} usage - 各服务商响应 usage 字段（兼容多格式）：
 *   prompt_tokens / completion_tokens / total_tokens 用于「上下文已用」；
 *   缓存命中兼容两种字段：DeepSeek 的 prompt_cache_hit_tokens，智谱 GLM 的 prompt_tokens_details.cached_tokens。缺失时按 0 处理。
 */
export function ingestUsage(usage) {
    if (!usage) return;
    const s = state.stats;
    s.contextPrompt = usage.prompt_tokens || 0;
    s.contextCompletion = usage.completion_tokens || 0;
    s.contextTotal = usage.total_tokens || 0;
    // 兼容两种缓存命中字段格式：
    // DeepSeek 用 usage.prompt_cache_hit_tokens；智谱 GLM 用 usage.prompt_tokens_details.cached_tokens
    s.cacheHit = (usage.prompt_cache_hit_tokens != null)
        ? usage.prompt_cache_hit_tokens
        : (usage.prompt_tokens_details?.cached_tokens || 0);
    updateCacheUI(s.cacheHit);
    updateMonitorUI();
}

/** 刷新信息栏状态灯 + 顶栏上下文圆环（原监控模态框已删，模态框相关 DOM 不再更新） */
export function updateMonitorUI() {
    const s = state.stats;
    const maxWindow = state.settings.maxWindow;
    if (DOM.topMsgCount) DOM.topMsgCount.textContent = s.totalMsg;
    if (DOM.cacheHitVal) DOM.cacheHitVal.textContent = formatTokens(s.cacheHit);
    if (DOM.cacheStatus) DOM.cacheStatus.classList.toggle('hit', s.cacheHit > 0);
    updateCtxRing(s.contextTotal, maxWindow);
}

/** 上下文占用圆环：按 已用/上限 更新百分比与分档色（<70% ok / 70-90 warn / ≥90 danger）。 */
function updateCtxRing(used, max) {
    const fill = DOM.ctxRingFill;
    if (!fill) return;
    const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
    const CIRC = 2 * Math.PI * 15.5;              // r=15.5，与 CSS stroke-dasharray 一致
    fill.style.strokeDashoffset = String(CIRC * (1 - pct / 100));
    fill.classList.remove('lvl-ok', 'lvl-warn', 'lvl-danger');
    fill.classList.add(pct >= 90 ? 'lvl-danger' : pct >= 70 ? 'lvl-warn' : 'lvl-ok');
    if (DOM.ctxRingPct) DOM.ctxRingPct.textContent = Math.round(pct) + '%';
}

/** 重置对话级监控统计（清空对话时调用，代表新一轮「对话开始」） */
export function resetMonitorStats() {
    Object.assign(state.stats, {
        cacheHit: 0,
        contextPrompt: 0, contextCompletion: 0, contextTotal: 0, totalMsg: 0
    });
    updateMonitorUI();
}

/**
 * waifu 模式「纯文字」渲染 — 分句气泡（W2 语义：仅语音关闭 / 只显示文字时保留 waifu 分句观感；
 *   语音开启（都显示 / 只显示语音）时由 W2 普通布局 .vt 承担，不在此分句）。纯文字场景无语音，故无内嵌播放。
 * @param {HTMLElement} contentEl @param {object} node @param {boolean} isStreaming
 */
export function renderWaifuContent(contentEl, node, isStreaming) {
    if (!node.content) { contentEl.textContent = ''; return; }
    const sentences = splitSentences(node.content);
    const existing = Array.from(contentEl.querySelectorAll('.waifu-bubble'));
    const mk = (s, idx) => {
        const b = document.createElement('div');
        b.className = 'waifu-bubble chat-bubble chat-bubble--ai';
        if (idx != null) b.style.animationDelay = (idx * 120) + 'ms';
        b.textContent = s;
        return b;
    };
    if (isStreaming) {
        if (existing.length < sentences.length) {
            for (let i = existing.length; i < sentences.length; i++) contentEl.appendChild(mk(sentences[i], i));
        } else if (existing.length > sentences.length) {
            contentEl.innerHTML = '';
            sentences.forEach((s, i) => contentEl.appendChild(mk(s, i)));
        } else if (sentences.length > 0) {
            existing[existing.length - 1].textContent = sentences[sentences.length - 1];
        }
        return;
    }
    let mismatch = existing.length !== sentences.length;
    if (!mismatch) for (let i = 0; i < existing.length; i++) if (existing[i].textContent !== sentences[i]) { mismatch = true; break; }
    if (mismatch) { contentEl.innerHTML = ''; sentences.forEach((s, i) => contentEl.appendChild(mk(s, i))); }
}
