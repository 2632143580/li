/**
 * 应用入口 / 全局编排
 *
 * 职责：导入样式与全部模块，组装全局生命周期：
 *   resize() 视口尺寸刷新、loop() UI 画布主循环、init() 启动、bindEvents() 事件注册、
 *   暴露 window._bgApi（含 triggerProactive 静默主动消息接口）。
 *
 * 导出：resize, onResize, init, loop（onResize 活绑定供事件绑定层引用）
 * 依赖：全部核心/引擎/UI/对话模块
 */
import './style.css';

import { DOM, setViewport, W, H, uiCtx } from './core/dom.js';
import { Logger } from './core/logger.js';
import { state } from './core/store.js';
import { saveToLocal, loadFromLocal } from './core/storage.js';
import { BgEngine } from './engines/bg-engine.js';
import { ThemeEngine } from './engines/theme-engine.js';
import { initTTS } from './engines/tts-engine.js'; // 语音引擎：加载音色列表（无副作用）
import { inputRenderer, drawInputArea, updateInputColors, updateInputLayout } from './ui/input-renderer.js';
import { inputManager } from './ui/input-manager.js';
    // 来自 tree.js 的全局可见函数
import {
    applySettings, initChatTree, renderChat,
    buildApiMessages, sendMessage, createNode, getCurrentPath, updateMsgContent, ingestUsage, setNodeError, updateMonitorUI,
    ensureCurrentEndNode
} from './chat/tree.js';
// 全局事件注册聚合（bindEvents）已迁至 ui/event-bindings（stage3）
import { bindEvents, applyQuickTheme } from './ui/event-bindings/index.js';
// 来自 api.js 的流式请求能力（triggerProactive 复用）
import { streamChat } from './chat/api.js';
import { bus, EVENTS } from './core/bus.js';
import { initBgTriggers } from './ui/bg-trigger.js';
import { initCompanionSay } from './companion-say.js'; // 外部"主动说话"入口（App 注入用）

// 性能诊断模式：URL 带 ?perf=1 时加载诊断 overlay（手机访问 http://<本机IP>:5173/?perf=1）
// 仅观测不改业务；生产构建不带该参数时不加载。
if (new URLSearchParams(location.search).has('perf')) {
    import('./diagnose.js').catch(e => console.error('[Perf] 诊断模块加载失败', e));
}

/** rAF 节流句柄（resize 的视觉视口/窗口监听防抖） @type {number|null} */
let resizeRafId = null;

/**
 * 屏幕尺寸调整 — 使用 rAF 节流，避免移动端键盘弹出时频繁触发。
 * 唯一允许写入 W/H 的地方（通过 setViewport），并刷新画布变换、插件尺寸、输入框布局与颜色缓存。
 */
export function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.visualViewport ? window.visualViewport.width : window.innerWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;

    setViewport(vw, vh);

    // 背景画布
    BgEngine.canvas.width = W * dpr;
    BgEngine.canvas.height = H * dpr;
    BgEngine.canvas.style.width = W + "px";
    BgEngine.canvas.style.height = H + "px";
    BgEngine.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // UI 画布
    DOM.uiCanvas.width = W * dpr;
    DOM.uiCanvas.height = H * dpr;
    DOM.uiCanvas.style.width = W + "px";
    DOM.uiCanvas.style.height = H + "px";
    uiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 通知所有活跃插件尺寸变化
    BgEngine.activePlugins.forEach(p => {
        Logger.safe('BgEngine.resize', () => p.pluginObj.init?.(BgEngine.ctx, W, H, p.state));
    });

    updateInputColors(); // 窗口变化时刷新颜色缓存
    updateInputLayout();
    inputRenderer.markDirty();
}

/** resize 的 rAF 节流包装 @returns {void} */
export function onResize() {
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(resize);
}

/** 渲染循环 — 按需驱动（非永不停的 60fps 循环）。
 *  仅当 shouldRedraw 命中（思考中 / 线长插值未收敛 / 脏标记）才绘制并续帧；
 *  否则本帧后彻底停掉 rAF，让浏览器进入真正空闲、停止每帧重合成整棵图层树。
 *  这是移动端常态 GPU 钉在 60fps 的根因修复点——前置的星空 Canvas 移除只去掉了被合成的一层，
 *  并未消除「循环本身」驱动的全屏持续合成。
 *  @param {number} now */
export function loop(now) {
    if (inputRenderer.shouldRedraw(now)) {
        drawInputArea(now);
    }
    // 续帧判定：下一帧仍需绘制（持续态：waiting / _animating）才继续 rAF；否则停（renderRunning=false）。
    if (inputRenderer.shouldRedraw(now)) {
        requestAnimationFrame(loop);
    } else {
        renderRunning = false;
    }
}

/** 按需渲染调度：循环未运行时拉起一帧。所有重绘触发点（打字 / resize / 等待态 / 主动消息 / 换肤）
 *  均经 inputRenderer.markDirty() → requestFrame 钩子调用本函数，无需各自直连循环。 */
let renderRunning = false;
function requestRender() {
    if (renderRunning) return;
    renderRunning = true;
    requestAnimationFrame(loop);
}
// markDirty 钩子：状态变化时自动拉起按需渲染循环（见 input-renderer.js markDirty）。
inputRenderer.requestFrame = requestRender;

/** 初始化：装配引擎、加载数据、绑定事件、暴露外部接口 */
export function init() {
    inputManager.init();
    BgEngine.init(DOM.bg);
    ThemeEngine.init(); // 初始化主题引擎
    initTTS();          // 初始化语音引擎（加载音色列表，不支持时仅日志）
    resize();
    applySettings();

    if (state.settings.availableModels.length === 0) {
        state.settings.availableModels.push(state.settings.model);
    }

    // 背景引擎就绪。默认背景底色由 :root --color-bg 兜底（CSS 已设置），不挂任何 Canvas 动画插件——
    // 星空插件已移除：满屏动画画布是移动端常态 GPU 的持续帧驱动源之一（实测约贡献 70%→60% 的 10%）。
    // 真正的大头是「持续帧生产」本身：永不停的 rAF 循环 + box-shadow 无限动画（rAF 已改为按需驱动；
    // 顶栏语音图标呼吸光晕 ttsGlowPulse、待确认脉冲环 arm-pulse/resetPulse 均已移除）。现默认背景为纯 CSS 底色，零持续动画。
    // 默认主题(default_theme)仅作为导出模板保留在 availableThemes，不挂载、不占生效槽。

    // 加载本地数据或初始化新对话
    if (!loadFromLocal()) {
        initChatTree();
        saveToLocal(null, true);
    } else {
        applySettings();
        updateInputLayout();
        renderChat();
    }

    // 绑定所有事件
    bindEvents();
    initBgTriggers(); // 初始化 AI 触发背景切换引擎（订阅 ASSISTANT_DONE）

    // 恢复上次选择的快速配色（若已选）：挂载 token 主题
    if (state.settings.quickTheme) applyQuickTheme(state.settings.quickTheme);

    updateMonitorUI(); // 初始化信息栏状态灯（载入已保存的监控数据）

    Logger.info('[Init] 初始化完成');
    window._bgApi = {
        sendMessage: sendMessage,
        createNode: createNode,
        getCurrentPath: getCurrentPath,

        // 静默主动消息接口：不记录用户节点，直接让 AI 回复
        triggerProactive: function (instruction) {
            if (state.waiting) return;
            state.waiting = true;
            inputRenderer.markDirty();

            // 1. 构建上下文（包含历史对话）
            const parent = ensureCurrentEndNode();
            const apiMessages = buildApiMessages(parent);

            // 2. 在 API 请求层面注入指令，但不写入 DOM 树（system 角色权重更高，且不会和 user 混淆）
            apiMessages.push({
                role: 'system',
                content: instruction
            });

            // 3. 直接创建 AI 节点（跳过 User 节点创建）
            const aiNode = createNode("assistant", "");

            // 挂载到树末端
            parent.children.push(aiNode);
            parent.selectedChildIndex = parent.children.length - 1;
            state.currentEndNode = aiNode;

            renderChat(); // 立即渲染空节点

            // 4. 发送请求
            updateMonitorUI();
            streamChat(apiMessages,
                (full) => updateMsgContent(aiNode, full),
                (full, usage) => {
                    updateMsgContent(aiNode, full);
                    ingestUsage(usage); // 合并 usage 到监控统计并刷新 UI
                    BgEngine.triggerMessage('assistant', full);
                    bus.emit(EVENTS.ASSISTANT_DONE, full); // 广播 AI 完成文本，供背景触发器按触发词切换
                    saveToLocal(null, true);
                },
                (err) => {
                    setNodeError(aiNode, err.message);
                    saveToLocal(null, true);
                }
            );
        }
    };

    // 外部"主动说话"入口（App 注入：插入消息 → li 用网页配置回复 → 回调回传）
    initCompanionSay();
}

// ================================================================
//  启动
// ================================================================
init();
requestRender();
