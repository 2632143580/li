/**
 * 应用入口 / 全局编排
 *
 * 职责：导入全部模块，组装全局生命周期：
 *   resize() 视口尺寸刷新、init() 启动、bindEvents() 事件注册、
 *   暴露 window._bgApi（含 triggerProactive 静默主动消息接口）。
 *
 * 导出：resize, onResize, init（onResize 活绑定供事件绑定层引用）
 * 依赖：全部核心/引擎/UI/对话模块
 * 注意：CSS 由 index.html <link> 加载（Vite 构建内联 / http.server 原生 @import 链），此处不再 import './style.css'
 */
import { DOM, setViewport, W, H } from './core/dom.js';
import { Logger } from './core/logger.js';
import { state } from './core/store.js';
import { DEFAULT_PROVIDER } from './core/constants.js';
import { loadFromLocal, createFirstSession, saveSession } from './core/storage.js';
import { syncAvailableModels } from './core/models.js';
import { BgEngine } from './engines/bg-engine.js';
import { ThemeEngine } from './engines/theme-engine.js';
import { initTTS } from './engines/tts-engine.js'; // 语音引擎：加载音色列表（无副作用）
import { inputManager, updateInputLayout } from './ui/input-manager.js';
// tree.js 的全局可见函数
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
// 禁止词引擎 UI：副作用导入即完成引擎加载 + 事件订阅 + DOM 创建（AI 回复命中词库时弹提示条）
import './ui/moderator-ui.js';
import { moderator } from './engines/moderator-engine.js'; // 禁止词引擎单例（加载后由 main hydrate）
import { initCompanionSay } from './companion-say.js'; // 外部"主动说话"入口（App 注入用）

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

    // 实时维护 --app-vh（= 当前可见视口高度），供底部 sheet 高度使用，避免移动端地址栏/键盘导致静态 90vh 不稳
    document.documentElement.style.setProperty('--app-vh', vh + 'px');

    const showBg = state.settings.bgCanvas !== false;
    DOM.bg.style.display = showBg ? '' : 'none';

    if (showBg) {
        // 背景画布
        BgEngine.canvas.width = W * dpr;
        BgEngine.canvas.height = H * dpr;
        BgEngine.canvas.style.width = W + "px";
        BgEngine.canvas.style.height = H + "px";
        BgEngine.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // 通知所有活跃插件尺寸变化
    BgEngine.activePlugins.forEach(p => {
        Logger.safe('BgEngine.resize', () => p.pluginObj.init?.(BgEngine.ctx, W, H, p.state));
    });

    updateInputLayout();
}

/** resize 的 rAF 节流包装 @returns {void} */
export function onResize() {
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    resizeRafId = requestAnimationFrame(resize);
}

/** 初始化：装配引擎、加载数据、绑定事件、暴露外部接口 */
export function init() {
    inputManager.init();
    BgEngine.init(DOM.bg);
    ThemeEngine.init(); // 初始化主题引擎
    initTTS();          // 初始化语音引擎（加载音色列表，不支持时仅日志）
    resize();
    applySettings();

    // 背景引擎就绪。默认背景底色由 :root --color-bg 兜底（CSS 已设置），不挂任何 Canvas 动画插件——
    // 星空插件已移除：满屏动画画布是移动端常态 GPU 的持续帧驱动源之一（实测约贡献 70%→60% 的 10%）。
    // 真正的大头是「持续帧生产」本身：永不停的 rAF 循环 + box-shadow 无限动画（rAF 已改为按需驱动；
    // 顶栏语音呼吸光晕 ttsGlowPulse、待确认脉冲环 arm-pulse/resetPulse 均已移除）。现默认背景为纯 CSS 底色，零持续动画。
    // 启动即生效的基础配色由 tokens.css :root 承担（无默认主题插件，2026-08-24 移除 exportOnly 模板）。

    // 加载本地数据或初始化新对话
    if (!loadFromLocal()) {
        initChatTree();          // 建首棵对话树（根 content = 全局默认系统提示词）
        createFirstSession();    // 登记为首会话并落盘（分键 v4）
    } else {
        applySettings();
        updateInputLayout();
        renderChat();
    }
    // 模型清单：loadFromLocal 已读回 modelCache（全局键），此处恢复默认服务商的可用列表。
    // （此前写在 load 之前——那时 modelCache 还是空的，恢复了个寂寞，属无效恢复块，已移除。）
    syncAvailableModels(DEFAULT_PROVIDER);
    moderator.load(); // 从存档 settings.moderator 恢复词库与模板（构造时 settings 尚未加载）

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

            // 1. 构建上下文（包含历史对话）
            const parent = ensureCurrentEndNode();
            const apiMessages = buildApiMessages(parent);
            const sid = state.activeSessionId; // 会话归属：主动消息落到当前激活会话

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

            // 4. 发送请求（携带会话 id，落到正确会话键）
            updateMonitorUI();
            streamChat(apiMessages,
                (full) => updateMsgContent(aiNode, full),
                (full, usage) => {
                    updateMsgContent(aiNode, full);
                    ingestUsage(usage); // 合并 usage 到监控统计并刷新 UI
                    BgEngine.triggerMessage('assistant', full);
                    bus.emit(EVENTS.ASSISTANT_DONE, full); // 广播 AI 完成文本，供背景触发器按触发词切换
                    saveSession(sid);
                },
                (err) => {
                    setNodeError(aiNode, err.message);
                    saveSession(sid);
                },
                sid
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
