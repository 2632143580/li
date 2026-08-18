/**
 * UI 注册表（薄工具层，core 零依赖）。
 *
 * 解决痛点：新增 UI 组件时，事件绑定不再需要在 event-bindings/index.js 里手写
 * `bindXxxEvents()` 调用列表。各子模块在自身加载时调用 registerUI(id, setup)
 * 自注册，启动期的 bindEvents() 统一遍历注册表执行。
 *
 * 与 dev 模式的关系（重要）：
 *   dev 模式是「纯 http 伺服原生 ESM」，没有 Vite transform，因此**不能用
 *   import.meta.glob 自动发现模块**（那是 Vite 构建期语法，dev 下是 undefined 会崩）。
 *   所以各子模块的「副作用导入」必须保留在 event-bindings/index.js 里，用来触发模块
 *   加载与自注册；本层只负责「注册 + 统一执行」，不做模块发现。
 *
 * 健壮性：initUI 对每个 setup 用 Logger.safe 隔离，单个组件抛错不影响其余组件绑定。
 *
 * 导出：registerUI, initUI, unregisterUI, getRegisteredUI
 * 依赖：./logger.js（仅 Logger，可在 Node 下运行，无 DOM 依赖）
 */

import { Logger } from './logger.js';

/** id → setup 函数（原各 bindXxxEvents）。 @type {Map<string, Function>} */
const registry = new Map();

/**
 * 注册一个 UI 组件的初始化 / 事件绑定函数。
 * @param {string} id 组件唯一标识（建议与模块语义一致，如 'monitor'）
 * @param {Function} setup 组件初始化函数（无参）；需在模块加载期调用，引用会被存放
 */
export function registerUI(id, setup) {
    if (typeof setup !== 'function') {
        Logger.error(`[registry] registerUI("${id}") 的 setup 不是函数，已忽略`);
        return;
    }
    if (registry.has(id)) {
        Logger.warn(`[registry] 重复注册 id="${id}"，后者覆盖前者（检查是否重复 import）`);
    }
    registry.set(id, setup);
}

/**
 * 启动期统一执行所有已注册组件的初始化。
 * 单个组件抛错被 Logger.safe 隔离，不会中断其余组件的绑定。
 */
export function initUI() {
    for (const [id, setup] of registry) {
        Logger.safe(`initUI:${id}`, setup);
    }
}

/** 注销某个组件（一般用于测试或动态卸载）。 @param {string} id */
export function unregisterUI(id) {
    registry.delete(id);
}

/** 已注册 id 列表（调试 / 自检用）。 @returns {string[]} */
export function getRegisteredUI() {
    return [...registry.keys()];
}
