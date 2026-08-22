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
 *   - core/state      state（currentEndNode / waiting / domCache / stats / settings）
 *   - core/utils      formatTokens（token 数格式化）
 *   - core/storage    saveToLocal（分支导航按钮保存）
 *   - core/text-split splitSentences（分句）/ splitWaifuSegments（text/action 段分离）
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
import { splitSentences, splitWaifuSegments } from '../../core/text-split.js';
import { clearAutoQueue } from '../../engines/tts-engine.js'; // 分支切换即停当前自动朗读（tree-render 不依赖 cleanForSpeech，断句清洗在 voice-tiles 内完成）
import { getCurrentPath, getLastNodeInPath } from '../../core/tree-core.js';
import { bus, EVENTS } from '../../core/bus.js';
import { showContextMenu } from '../context-menu.js';
import { renderVoiceTiles, renderBoth } from '../voice-tiles.js'; // 语音回复（句句发语音）；renderWaifuContent 为本模块本地定义
import { buildLoveSvg, buildEcgMonitorSvg, initEcgHeartCanvases } from '../../plugins/ecg-heart.js';
import { buildMinimalThinkSvg } from '../../plugins/think-minimal.js';

/**
 * 生成气泡外层容器的 className（buildMsgDom 与 renderMessage 共用，消除重复书写）
 *
 * 规则（2026-08-21 waifu 开关移除后：AI 非错误消息恒走分句/语音条形态）：
 *   - 用户消息：msg user chat-bubble chat-bubble--user（单气泡，不分句）
 *   - AI 非错误：msg ai（外层不带 chat-bubble——纯文字是分句气泡 .waifu-bubble、
 *       语音是 .vt 语音条，子元素各自成气泡。绝不让外层大气泡包裹子气泡，见
 *       2026-08-11.md 三层结构契约）
 *   - 错误节点：msg ai chat-bubble chat-bubble--ai（.error-msg 挂在 .chat-bubble--ai 体系下，
 *       保持单气泡，不走分句/action 识别）
 *
 * 关键不变量：外层带 chat-bubble 时，其内部只装「文字」且 footer 在 bubble 之外；
 *   外层无气泡视觉（'msg ai'）时，子元素（分句泡/语音条/action 轻提示）各自承担视觉。
 *
 * @param {string} role - 'user' | 'assistant'
 * @param {boolean} [isError=false] - 是否错误节点
 * @returns {string} className
 */
export function getBubbleClass(role, isError = false) {
    // node.role 是 'user'/'assistant'，CSS 类名用 'user'/'ai'，需映射
    const cls = role === 'assistant' ? 'ai' : role;
    const base = `msg ${cls} chat-bubble chat-bubble--${cls}`;
    if (isError) return base;
    // AI 非错误恒为布局容器（msg ai）：分句气泡 / 语音条 / action 轻提示均由子元素渲染
    if (role === 'assistant') return 'msg ai';
    return base;
}

/**
 * 该 AI 消息的渲染形态（受「文字消息显示模式」总控 +「发语音概率」按消息一次性掷骰）。
 * 显示模式（ttsDisplayMode）优先级最高：
 *   - 'text'  只显示文字：恒为纯文本，忽略语音回复开关与概率。
 *   - 'voice' 只显示语音：恒为语音条（含括号动作作轻提示，不朗读）；不再按概率降级为文字，
 *            保证「只显示语音」名副其实（修复反馈：含（）消息被概率降级成文字气泡）。
 *   - 'both'  都显示（默认）：每条消息「语音条 + 文字」同时呈现（忽略发语音概率，永远都给）。
 * 硬条件：ttsEnabled 总开关关 → 退化纯文字；仅 assistant + 非错误。
 * @param {object} node @returns {'text'|'voice'|'both'}
 */
function getRenderKind(node) {
    if (node.role !== 'assistant' || node.isError) return 'text';
    if (!state.settings.ttsEnabled) return 'text';          // 语音回复总开关关 → 纯文字
    const mode = state.settings.ttsDisplayMode || 'both';
    if (mode === 'text') return 'text';                     // 只显示文字
    if (mode === 'voice') return 'voice';                   // 只显示语音：恒语音条（括号动作轻提示）
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

    // 渲染子类型：AI 纯文字恒走分句气泡（2026-08-21 waifu 开关移除，分句成为唯一渲染方式；
    // 语音/都显示仍走 voice-tiles 路径，错误消息保持单气泡）
    let rk = kind;
    if (node.role === 'assistant' && !node.isError && kind === 'text') rk = 'waifu';
    const cur = contentEl.dataset.rk;
    if (cur && cur !== rk) contentEl.innerHTML = ''; // 模式切换强制清空重建（修复「切换显示模式不立即生效」）
    contentEl.dataset.rk = rk;

    // 思维链折叠块（自定义按钮，非原生 details）：assistant 非错误节点才渲染，插在气泡上方（避免被正文 innerHTML='' 清空）
    if (node.role === 'assistant' && !node.isError) {
        renderReasoningBlock(node, contentEl.closest('.msg') || contentEl.parentElement);
    }

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
    // 而打字指示器是通过 innerHTML 写入的独立节点，不清除就���与后续内容并存并残留到对话结束。
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
    // AI 非错误恒 'msg ai'（子元素各自成气泡）；用户/错误消息带 chat-bubble 视觉类。
    bubble.className = getBubbleClass(node.role, node.isError);

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
            clearAutoQueue(); // 修⑥：切换分支即停当前自动朗读（旧分支消息从视图消失，避免后台继续读）
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
            clearAutoQueue(); // 修⑥：切换分支即停当前自动朗读（旧分支消息从视图消失，避免后台继续读）
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

    // 每次渲染重新生成 className（用 getBubbleClass，与 buildMsgDom 共用）。
    // 消除旧补丁：domCache 复用的旧节点可能残留��一模式的 className，强制覆盖确保一致。
    const bubble = div.firstChild;
    bubble.className = getBubbleClass(node.role, node.isError);

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

/**
 * 实时落思维链（reasoning）并增量渲染：复用 updateMsgContent 的 rAF 合并机制，
 * 写 node.reasoning 后由 renderContent 内的 renderReasoningBlock 增量更新折叠块文本（不重建、不闪）。
 * reasoning 为运行时字段、不序列化（刷新即失，符合「无需导出」）。 @param {object} node @param {string} reasoning
 */
export function updateMsgReasoning(node, reasoning) {
    node.reasoning = reasoning; // 先落数据：即使 rAF 合并多次 chunk，渲染读的也是最新
    const div = state.domCache.get(node.id);
    if (!div) return;
    const contentEl = div.querySelector('.bubble-content');
    if (!contentEl) return;
    _pendingStream = { contentEl, node };
    if (_streamFrame) return;
    _streamFrame = requestAnimationFrame(() => {
        _streamFrame = null;
        const p = _pendingStream;
        _pendingStream = null;
        if (!p) return;
        renderContent(p.contentEl, p.node);
        DOM.chat.scrollTop = DOM.chat.scrollHeight;
    });
}



/**
 * 渲染/更新思维链块（无气泡 / 无卡片 / 无边框，纯排版）。挂在气泡 wrapper 内、正文块之前，
 * 避免被各显示模式（waifu/voice/both）的 contentEl.innerHTML='' 重建清空。
 * 头部 = 爱心 + 横向心电图条纹（监护仪式），无文字；折叠态由用户 toggle 记忆（node._reasoningCollapsed），
 * 新消息默认跟随「自动展开」设置；流式生成中强制展开（思考流动可见）。
 * @param {object} node @param {HTMLElement} wrapper 消息 wrapper（.msg）
 */
function renderReasoningBlock(node, wrapper) {
    const bubble = wrapper.querySelector(':scope > .bubble') || wrapper.firstChild;
    const existing = wrapper.querySelector(':scope > .reasoning');
    // 关开关 / 无思维链 → 不渲染（数据仍在内存，开关再开即显）
    if (!(state.settings.showReasoning && node.reasoning)) {
        if (existing) existing.remove();
        return;
    }
    const isThinking = (node === state.currentEndNode && state.waiting);
    let block = existing;
    if (!block) {
        block = document.createElement('div');
        block.className = 'reasoning';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'reasoning-toggle';
        toggle.setAttribute('aria-expanded', 'true');
        const body = document.createElement('div');
        body.className = 'reasoning-body';
        block.append(toggle, body);
        // 折叠：切 .collapsed 类，并记忆到 node._reasoningCollapsed（运行时 UI 态，不序列化）
        toggle.addEventListener('click', () => {
            const collapsed = block.classList.toggle('collapsed');
            node._reasoningCollapsed = collapsed;
            block.querySelector('.reasoning-toggle').setAttribute('aria-expanded', String(!collapsed));
        });
        wrapper.insertBefore(block, bubble);
    }
    // 头部图标 = 两部分，关系写死（用户强调）：
    //   ① love.svg（爱心 + 其内部爱心折线）：与爱心是一体的，恒显，不受任何开关控制；
    //   ② 心电图 canvas 波形（用户说的「心电图」）：受 showEcgWave 控制（关 → 只留爱心）。
    // 健壮性（修「空白占位」bug）：绝不依赖「wantWave!==hasWave 才重建」这类脆弱判断——
    //   它在「首建且开关本就关」时 wantWave===hasWave 为 true，会跳过 innerHTML 赋值，
    //   导致 toggle 永为空按钮。改为就地核对每个子元素：缺则补、多则删，任何状态都自愈。
    const toggle = block.querySelector('.reasoning-toggle');
    const style = state.settings.thinkIconStyle === 'minimal' ? 'minimal' : 'ecg';
    toggle.querySelector('.rk-think-minimal')?.remove();
    toggle.querySelector('.rk-love-ico')?.remove();
    toggle.querySelector('.rk-ecg-mon')?.remove();
    toggle.querySelector('.rk-chev')?.remove();
    if (style === 'minimal') {
        toggle.insertAdjacentHTML('afterbegin', buildMinimalThinkSvg(node._emotion));
    } else {
        toggle.insertAdjacentHTML('afterbegin', buildLoveSvg());
        if (state.settings.showEcgWave) {
            toggle.insertAdjacentHTML('beforeend', buildEcgMonitorSvg(node._emotion));
            initEcgHeartCanvases(toggle);
        }
    }
    toggle.insertAdjacentHTML('beforeend', '<span class="rk-chev"></span>');
    block.querySelector('.reasoning-body').textContent = node.reasoning;
    // 折叠态：流式生成中强制展开；否则用用户手动选择，��消息默认跟随「自动展开」开关
    const collapsed = isThinking ? false
        : (typeof node._reasoningCollapsed === 'boolean' ? node._reasoningCollapsed : !state.settings.reasoningAutoExpand);
    block.classList.toggle('collapsed', collapsed);
    block.classList.toggle('thinking', isThinking);
    block.querySelector('.reasoning-toggle').setAttribute('aria-expanded', String(!collapsed));
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
 * @param {object} [targetStats=state.stats] - 写入目标（后台会话写入自己的 stats，不污染当前会话顶栏）
 * @param {boolean} [refreshUI=true] - 是否刷新顶栏监控 UI（仅活跃会话完成时刷新；后台生成不刷，避免顶栏串台）
 */
export function ingestUsage(usage, targetStats = state.stats, refreshUI = true) {
    if (!usage) return;
    const s = targetStats;
    s.contextPrompt = usage.prompt_tokens || 0;
    s.contextCompletion = usage.completion_tokens || 0;
    s.contextTotal = usage.total_tokens || 0;
    // 兼容两种缓存命中字段格式：
    // DeepSeek 用 usage.prompt_cache_hit_tokens；智谱 GLM 用 usage.prompt_tokens_details.cached_tokens
    s.cacheHit = (usage.prompt_cache_hit_tokens != null)
        ? usage.prompt_cache_hit_tokens
        : (usage.prompt_tokens_details?.cached_tokens || 0);
    if (refreshUI) {
        updateCacheUI(s.cacheHit);
        updateMonitorUI();
    }
}

/**
 * 取消待渲染的流式 rAF（切换会话时调用）：避免后台会话残留的一帧写入已 detach 的新 DOM。
 * 仅清除帧句柄与待渲染目标，不触碰任何会话数据。 @returns {void}
 */
export function cancelPendingStream() {
    if (_streamFrame) { cancelAnimationFrame(_streamFrame); _streamFrame = null; }
    _pendingStream = null;
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
 * AI「纯文字」渲染 — 分句气泡 + action 轻提示交替（2026-08-21 起 AI 纯文字消息的唯一渲染方式，
 *   原 waifu 开关已移除；语音/都显示由 voice-tiles.js 的 .vt 承担，不在此路径）。
 *
 * 段结构：splitWaifuSegments 先把文本切成 text/action 交替段，text 段再经 splitSentences
 *   细分成句（每句一个 .waifu-bubble），action 段渲染为 .waifu-action 轻提示（括号内文字、
 *   不进语音、不带气泡底色）。渲染项扁平化后保持原顺序。
 *
 * 流式增量（关键，勿退回 append-only）：
 *   action 括号「未闭合 → 闭合」切换时，已渲染的旧 text 段文本会回缩（"你好(笑" → "你好" + action"笑"），
 *   只 append 新段不回写旧段会残留半句。故数量不减少时先逐段回写（类型+文本），再 append 新增段；
 *   类型翻转（理论前缀结构保证不发生，防御兜底）或数量减少时全量重建。
 *   与 renderVoiceTiles 流式回写修复（voice-tiles.js）同口径。
 * @param {HTMLElement} contentEl @param {object} node @param {boolean} isStreaming
 */
export function renderWaifuContent(contentEl, node, isStreaming) {
    if (!node.content) { contentEl.textContent = ''; return; }
    // 扁平化渲染项：text 段细分句子 → 气泡；action 段 → 轻提示；空文本段跳过（空气泡防御）
    const items = [];
    for (const seg of splitWaifuSegments(node.content)) {
        if (seg.type === 'action') {
            items.push(seg);
        } else {
            for (const s of splitSentences(seg.text)) {
                if (s) items.push({ type: 'text', text: s });
            }
        }
    }
    const existing = Array.from(contentEl.querySelectorAll(':scope > .waifu-bubble, :scope > .waifu-action'));
    const mk = (item, idx) => {
        const b = document.createElement('div');
        b.className = item.type === 'action' ? 'waifu-action' : 'waifu-bubble chat-bubble chat-bubble--ai';
        if (idx != null) b.style.animationDelay = (idx * 120) + 'ms';
        b.textContent = item.text;
        return b;
    };
    const rebuild = () => { contentEl.innerHTML = ''; items.forEach((it, i) => contentEl.appendChild(mk(it, i))); };
    if (isStreaming) {
        if (existing.length > items.length) { rebuild(); return; }
        // 类型不一致（前缀翻转，防御兜底）→ 全量重建；一致则先回写已变化段（含旧段回缩），再 append 新段
        const typeOk = existing.every((el, i) =>
            (items[i].type === 'action') === el.classList.contains('waifu-action'));
        if (!typeOk) { rebuild(); return; }
        for (let i = 0; i < existing.length; i++) {
            if (existing[i].textContent !== items[i].text) existing[i].textContent = items[i].text;
        }
        for (let i = existing.length; i < items.length; i++) contentEl.appendChild(mk(items[i], i));
        return;
    }
    let mismatch = existing.length !== items.length;
    if (!mismatch) {
        for (let i = 0; i < existing.length; i++) {
            const wantAction = items[i].type === 'action';
            const isAction = existing[i].classList.contains('waifu-action');
            if (wantAction !== isAction || existing[i].textContent !== items[i].text) { mismatch = true; break; }
        }
    }
    if (mismatch) rebuild();
}
