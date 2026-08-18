/**
 * 可变全局状态单例（stage5 拆分后，本文件**仅**持有 state）
 *
 * 职责收敛：原单文件里的「常量/配置/工具」已迁出（见 core/constants.js、core/utils.js），
 *          本文件只保留可变 `state` 这一导出。
 *          - 不可变常量 / 默认配置 / 欢迎语 → core/constants.js
 *          - 无副作用工具函数               → core/utils.js
 *          - state 的集中读取入口           → core/store.js（渲染层与业务层都从 store 读）
 *
 * 约束：state 对象的**引用本身不重新赋值**（全模块共享同一引用），仅允许修改其内部字段。
 *       写入边界见 core/store.js 的注释。本文件不依赖任何上层模块（core 零外部依赖铁律）。
 *
 * 导出：state
 * 依赖：./constants.js（仅用于构造 state.settings 的初始值）
 */

import { DEFAULT_SETTINGS } from './constants.js';

// ================================================================
//  状态管理
//  全局状态集中定义，职责明确。所有模块共享同一个 state 引用（对象内部可变，引用本身不重新赋值）
// ================================================================
export const state = {
    /** 消息 ID 自增计数器 @type {number} */
    msgIdCounter: 0,
    /** 对话树根节点（role: 'system'），未初始化时为 null @type {object|null} */
    chatTree: null,
    /** 当前路径末端节点（流式输出的写入目标） @type {object|null} */
    currentEndNode: null,
    /** 是否正在等待 API 响应 @type {boolean} */
    waiting: false,
    /** 妻子模式（气泡分句显示）的运行时开关，由 settings.waifuMode 同步而来 @type {boolean} */
    waifuMode: false,
    /** 持久化设置，结构见 DEFAULT_SETTINGS @type {typeof DEFAULT_SETTINGS} */
    settings: {
        ...DEFAULT_SETTINGS,
        keys: { ...DEFAULT_SETTINGS.keys },
        availableModels: []
    },
    /** DOM 元素缓存：node.id(number) → HTMLElement @type {Map<number, HTMLElement>} */
    domCache: new Map(),
    /**
     * 监控统计 — 顶栏信息栏（消息数 / 缓存命中 / 上下文占用圆环）的统一数据源。
     * 全部字段均为 {number}：
     *   totalMsg          当前对话路径消息总条数
     *   cacheHit          最近一次请求的缓存命中 token 数
     *   contextPrompt     最近一次请求 usage.prompt_tokens
     *   contextCompletion 最近一次请求 usage.completion_tokens
     *   contextTotal      最近一次请求 usage.total_tokens
     */
    stats: {
        totalMsg: 0,
        cacheHit: 0,
        contextPrompt: 0,
        contextCompletion: 0,
        contextTotal: 0
    }
};
