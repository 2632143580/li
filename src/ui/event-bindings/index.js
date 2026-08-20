/**
 * 事件绑定聚合层（Stage 3 解耦产出 · 瘦聚合层）。
 *
 * 本目录下的事件绑定已按职责拆分为同级的子模块：
 *   data-exchange / monitor / waifu / settings / quick-theme /
 *   plugin-panel / global。
 * 本文件只做两件事：
 *   1) 作为 tempSettings 活绑定的间接转发出口 —— chat/tree.js 经此读取实时值（红线，勿在此重建副本）；
 *   2) 以「副作用导入」触发各子模块加载与自注册，bindEvents() 统一遍历 UI 注册表执行（替代原硬编码 bind* 列表）。
 *
 * 对外契约：main.js 仅依赖 `bindEvents` 与 `applyQuickTheme` 两个导出。
 *
 * 循环依赖说明（安全）：本模块 re-export tempSettings（定义见 temp-settings.js），
 *   chat/tree 经本模块读取该活绑定；本模块 import main.onResize、main import 本模块 bindEvents。
 *   两端均为「模块求值期只声明、运行时才调用/读取」的活绑定，不触发 TDZ。
 */

// —— 红线：tempSettings 活绑定间接转发（定义见 temp-settings.js，请勿在此重建副本）——
export { tempSettings } from './temp-settings.js';

// —— main.js 依赖的公开 API 转发 ——
export { applyQuickTheme } from './quick-theme.js';

// —— 启动期统一执行注册表（由各子模块自注册）——
import { initUI } from '../../core/registry.js';

// —— 各子模块：副作用导入即触发加载与自注册（registerUI），bindEvents 改为遍历注册表 ——
import '../context-menu.js';
import '../input-manager.js';
import './data-exchange.js';
import './monitor.js';
import './waifu.js';
import './tts.js';
import './settings.js';
import './plugin-panel.js';
import './global.js';
import './quick-theme.js';
import './wordcloud-panel.js';
import './topbar.js';
import './log-panel.js';
import './msg-nav-panel.js';

// ================================================================
//  事件绑定聚合
//  bindEvents() 遍历 UI 注册表（各子模块通过 registerUI 自注册），统一执行其 setup。
//  新增 UI 组件：在子模块内调用 registerUI 自注册，并在本文件加一行副作用导入触发加载。
//  注意：dev 模式是纯 http 伺服原生 ESM（无 Vite transform），无法用 import.meta.glob
//        自动发现模块，故副作用导入必须显式保留。
// ================================================================

/** 绑定所有事件：遍历 UI 注册表，逐一执行各组件自注册的 setup（单个失败不影响其余）。 */
export function bindEvents() {
    initUI();
}
