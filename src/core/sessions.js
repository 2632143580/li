/**
 * 会话数据层（纯数据 / 零 DOM / 零 localStorage 直写）
 *
 * 职责：多会话架构的「纯逻辑」部分——会话 id 生成、有效系统提示词解析、标题推导、
 *       索引条目构建、整树 id 重编号、v3→v4 迁移数据转换。
 *   不在此读写 localStorage：持久化 I/O 统一在 core/storage.js（本模块被它 import，
 *   不反向依赖，守住 core 零外部依赖铁律）。本模块只动内存中的 `state` 与纯计算。
 *
 * 数据模型（v4）：
 *   全局键 liChatData_v2 = { settings, activeSessionId, sessionIndex[], msgIdCounter, version:4 }
 *   会话键 liSession_<id> = { id, chatTree, stats, sysPrompt|null, draft, createdAt, updatedAt, manualTitle|null }
 *     - sysPrompt=null 表示继承全局默认；非 null 为会话级覆盖。
 *     - manualTitle=null 表示标题自动取首条 user 消息前 16 字；非 null 为用户手动重命名。
 *
 * 依赖：core/state（仅 state）、core/constants（SESSION_KEY_PREFIX 不在此用，保留扩展位）、
 *       core/tree-core（migrateErrorFlags / getLastNodeInPath 纯函数）。
 * 导出：genSessionId, getEffectiveSysPrompt, freshStats, getSessionTitle, countMessages,
 *       lastPreview, buildIndexEntry, renumberTreeIds, touchIndex, migrateV3ToV4
 */

import { state } from './store.js';

/**
 * 生成唯一会话 id（时间戳基 + 随机串，碰撞概率可忽略；与消息 id 不同域，不冲突）。 @returns {string}
 */
export function genSessionId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * 当前激活会话的「有效系统提示词」：会话级覆盖优先，否则回退全局默认。
 * 全链路（initChatTree / applySettings / buildApiMessages）统一走此函数，
 * 使「会话级覆盖 + 全局默认」语义在每一处一致。 @returns {string}
 */
export function getEffectiveSysPrompt() {
    if (state.sessionSysPrompt != null && state.sessionSysPrompt !== '') return state.sessionSysPrompt;
    return state.settings.sysPrompt;
}

/** 返回一份全新的监控统计对象（与 state.stats 同结构，避免共享引用）。 @returns {object} */
export function freshStats() {
    return { totalMsg: 0, cacheHit: 0, contextPrompt: 0, contextCompletion: 0, contextTotal: 0 };
}

/**
 * 从对话树推导会话标题：取「首条 user 消息」正文，去空白截断前 16 字；无 user 消息返回「新会话」。
 * @param {object} tree 对话树根（role:'system'）
 * @returns {string}
 */
export function getSessionTitle(tree) {
    if (!tree) return '新会话';
    const stack = [tree];
    while (stack.length) {
        const n = stack.shift();
        if (n.role === 'user' && n.content && String(n.content).trim()) {
            const t = String(n.content).replace(/\s+/g, ' ').trim();
            return t.slice(0, 16) || '新会话';
        }
        if (n.children) for (const c of n.children) stack.push(c);
    }
    return '新会话';
}

/** 统计非 system 节点数（会话消息数）。 @param {object} tree @returns {number} */
export function countMessages(tree) {
    let n = 0;
    const stack = [tree];
    while (stack.length) {
        const node = stack.pop();
        if (node.role && node.role !== 'system') n++;
        if (node.children) for (const c of node.children) stack.push(c);
    }
    return n;
}

/** 取末条非 system 节点正文（用于列表预览），空返回 ''。 @param {object} tree @returns {string} */
export function lastPreview(tree) {
    let last = '';
    const stack = [tree];
    while (stack.length) {
        const node = stack.pop();
        if (node.role && node.role !== 'system' && node.content) last = String(node.content).replace(/\s+/g, ' ').trim();
        if (node.children) for (const c of node.children) stack.push(c);
    }
    return last;
}

/**
 * 构建会话索引条目（列表只读结构，不携带正文）。
 * @param {string} id 会话 id
 * @param {object} tree 对话树（用来推导自动标题 / 计数 / 预览）
 * @param {string|null} manualTitle 手动重命名（null = 自动标题）
 * @param {{apiUrl:string, model:string}|null} [llmConfig] 会话级 LLM 覆盖快照（null = 继承全局；列表 chip 显示用）
 * @param {string|null} [sysPrompt] 会话级 SP 覆盖快照（null = 继承全局；列表 SP 预览用）
 * @returns {{id:string,title:string,autoTitle:boolean,updatedAt:number,msgCount:number,preview:string,llmConfig:object|null,sysPrompt:string|null}}
 */
export function buildIndexEntry(id, tree, manualTitle, llmConfig, sysPrompt) {
    return {
        id,
        title: manualTitle || getSessionTitle(tree),
        autoTitle: !manualTitle,
        updatedAt: Date.now(),
        msgCount: countMessages(tree),
        preview: lastPreview(tree),
        llmConfig: llmConfig || null,
        sysPrompt: sysPrompt ?? null
    };
}

/**
 * 整树重编号 id（导入外部备份时调用）：复用全局 msgIdCounter，
 * 逐节点 ++ 赋值，确保导入树与现有会话 id 域不撞（否则 domCache 串台、后台回调写错气泡）。
 * 直接修改入参树（原地），不返回。 @param {object} tree
 */
export function renumberTreeIds(tree) {
    const stack = [tree];
    while (stack.length) {
        const node = stack.pop();
        node.id = ++state.msgIdCounter;
        if (node.children) for (const c of node.children) stack.push(c);
    }
}

/**
 * 轻触会话索引的 updatedAt（发消息时调用）：只改内存、不落盘，
 * 让会话列表按 updatedAt 倒序时「刚发消息的会话」自然置顶（流式期间的即时反馈）。
 * 完整落盘由后续 saveSession 统一带出。 @param {string} id
 */
export function touchIndex(id) {
    const idx = state.sessionIndex || (state.sessionIndex = []);
    const e = idx.find(e => e.id === id);
    if (e) e.updatedAt = Date.now();
}

/**
 * v3 → v4 迁移数据转换（纯计算，不写盘）。
 * 把旧单树存档包装成「一个会话 + 全局 v4 结构」；旧 chatTree / stats / msgIdCounter 平移，
 * 会话 sysPrompt / manualTitle 置空（继承全局默认 + 自动标题）。
 * @param {{chatTree:object,stats:object,msgIdCounter:number,settings:object}} old v3 存档
 * @returns {{settings:object, msgIdCounter:number, activeSessionId:string, index:Array, firstSessionRaw:object}}
 */
export function migrateV3ToV4(old) {
    const id = genSessionId();
    const firstSessionRaw = {
        id,
        chatTree: old.chatTree,
        stats: old.stats || freshStats(),
        sysPrompt: null,
        draft: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        manualTitle: null
    };
    return {
        settings: old.settings,
        msgIdCounter: old.msgIdCounter || 0,
        activeSessionId: id,
        index: [buildIndexEntry(id, old.chatTree, null)],
        firstSessionRaw
    };
}
