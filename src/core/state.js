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
    /** 消息 ID 自增计数器（全局单一序列，跨会话唯一；导入备份也走同一计数器重编号） @type {number} */
    msgIdCounter: 0,
    /** 对话树根节点（role: 'system'），未初始化时为 null @type {object|null} */
    chatTree: null,
    /** 当前路径末端节点（流式输出的写入目标） @type {object|null} */
    currentEndNode: null,
    /** 是否正在等待 API 响应 @type {boolean} */
    waiting: false,
    /**
     * 当前激活会话 id（分键存储的枢纽；切换/新建即改此值）。
     * 为空字符串 '' 表示尚无会话（启动首跑时由 createFirstSession 填充）。 @type {string}
     */
    activeSessionId: '',
    /**
     * 当前会话的系统提示词覆盖值（null = 继承全局默认 state.settings.sysPrompt）。
     * 会话级覆盖 + 全局默认 双轨：改当前会话只动这里，永不污染全局默认；「设为全局默认」才写到 state.settings.sysPrompt。
     * @type {string|null}
     */
    sessionSysPrompt: null,
    /**
     * 会话轻量索引（列表只读索引，不解析正文）：[{ id, title, autoTitle, updatedAt, msgCount, preview }]。
     * 落盘于全局键 liChatData_v2（v4），列表渲染只读它，避免逐会话解析大树。 @type {Array<object>}
     */
    sessionIndex: [],
    /**
     * 后台流式会话登记表：sessionId -> { aiNode, controller, tree, stats, sysPrompt, draft }。
     * - 切换会话时旧会话若仍在生成，其完整快照留在此处（不入 DOM，靠 domCache 缺失 early-return 隔离），
     *   完成回调据此把内容落到正确的会话键，而非被切到的当前会话。
     * - waiting 改为 per-session：state.waiting 仅反映「激活会话」是否在生成，切换时按 pending.has(新id) 重置。
     * @type {Map<string, object>}
     */
    pending: new Map(),
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
