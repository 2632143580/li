/**
 * 应用入口 / 全局编排
 *
 * 职责：导入全部模块，组装全局生命周期：
 *   resize() 视口尺寸刷新、init() 启动、bindEvents() 事件注册。
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
import { syncAvailableModels } from './core/models-cache.js';
import { BgEngine } from './engines/bg-engine.js';
import { ThemeEngine } from './engines/theme-engine.js';
import { initTTS } from './engines/tts-engine.js'; // 语音引擎：加载音色列表（无副作用）
import { inputManager, updateInputLayout } from './ui/input-manager.js';
// tree.js 启动期函数
import {
    applySettings, initChatTree, renderChat,
    updateMsgContent, ingestUsage, setNodeError, updateMonitorUI
} from './chat/tree.js';
// 全局事件注册聚合（bindEvents）已迁至 ui/event-bindings（stage3）
import { bindEvents, applyQuickTheme } from './ui/event-bindings/index.js';
import { initBgTriggers } from './ui/bg-trigger.js';
// 禁止词引擎 UI：副作用导入即完成引擎加载 + 事件订阅 + DOM 创建（AI 回复命中词库时弹提示条）
import './ui/moderator-ui.js';
import { moderator } from './engines/moderator-engine.js'; // 禁止词引擎单例（加载后由 main hydrate）

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
}

// ================================================================
//  启动
// ================================================================
init();
