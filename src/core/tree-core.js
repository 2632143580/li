/**
 * 对话树的纯数据逻辑（无 DOM、无网络、无副作用 API 调用）
 *
 * 职责：把 chat/tree.js 里「只读写 state、不碰 DOM」的纯函数集中到 core 层。
 *   ① 让 core/storage.js 不再反向依赖 chat 层（此前 storage 从 chat/tree.js 取
 *      migrateErrorFlags / getLastNodeInPath，属于下层依赖上层，本末倒置）；
 *   ② 这些函数可被 Node 单测直接 import（见 tests/tree-core.test.js）。
 *
 * 为什么放在 core/ 而非 models/：
 *   项目铁律「core 不导入任何上层 / core 零外部依赖」。storage.js 本身就在 core 层且需要
 *   这两个函数，若放到 models/ 会引入 core→models 反向依赖，反而制造新违规。放 core/ 内，
 *   tree-core 只依赖同层 state.js，完全自洽。
 *
 * 依赖：core/state（仅 state 与 ERROR_PREFIX，均为 core 层，不引入任何上层依赖）
 * 导出：createNode, migrateErrorFlags, getCurrentPath, getLastNodeInPath, buildApiMessages, findMaxId
 *
 * 注意：本文件刻意不依赖 chat/api、ui/*、engines/*，保持纯数据，便于单测与分层。
 */

import { state } from './store.js';
import { ERROR_PREFIX } from './constants.js';
import { getEffectiveSysPrompt } from './sessions.js';

/**
 * 创建新消息节点
 * @param {string} role - 角色：'system' | 'user' | 'assistant'
 * @param {string} content - 消息正文
 * @returns {object} 新节点对象，字段如下：
 *   - id {number}              自增唯一 id，由 state.msgIdCounter 累加得到
 *   - role {string}            节点角色
 *   - content {string}         节点正文
 *   - time {number}            创建时刻（毫秒时间戳）；用于会话列表「最后消息时间」与排序，
 *                              不受刷新/重保存影响，是稳定时间基准（取代原先每次保存都写 Date.now() 的漂移 source）
 *   - children {Array<object>} 子节点（回复分支）列表，初始为空
 *   - selectedChildIndex {number} 当前展示的子节点下标，初始为 0
 *   - isError {boolean}        是否为错误节点，初始为 false
 */
export function createNode(role, content) {
    return {
        id: ++state.msgIdCounter,
        role,
        content,
        reasoning: '', // 思维链（运行时字段，不序列化：纯会话内临时展示，刷新即失，符合「无需导出」）
        time: Date.now(),
        children: [],
        selectedChildIndex: 0,
        isError: false
    };
}

/**
 * 迁移旧数据：为没有 isError 字段的节点推导错误标记（递归处理整棵子树）
 * @param {object} node - 对话树节点；非对象时直接返回，避免旧存档结构异常导致崩溃
 */
export function migrateErrorFlags(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.isError !== 'boolean') {
        node.isError = node.role === 'assistant' &&
            typeof node.content === 'string' &&
            node.content.startsWith(ERROR_PREFIX);
    }
    for (const child of (node.children || [])) migrateErrorFlags(child);
}

/**
 * 获取从根节点到当前末端的路径
 * @returns {Array<object>} 节点数组，从系统节点开始到当前末端结束
 *   沿 children[selectedChildIndex] 向下遍历，直到叶子节点（无 children 或为空）。
 */
export function getCurrentPath() {
    const path = [];
    let node = state.chatTree;
    while (node) {
        path.push(node);
        if (node.children && node.children.length > 0) {
            node = node.children[node.selectedChildIndex];
        } else {
            node = null;
        }
    }
    return path;
}

/**
 * 获取树中末端叶子节点（沿 selectedChildIndex 一直走到无子节点）
 * @param {object} tree - 起始节点
 * @returns {object} 最深的叶子节点
 */
export function getLastNodeInPath(tree) {
    let node = tree;
    while (node.children && node.children.length > 0) {
        node = node.children[node.selectedChildIndex];
    }
    return node;
}

/**
 * 构建 API 请求消息体
 * 从根遍历到 endNode，过滤错误消息节点，合并连续同角色消息
 * @param {object} endNode - 路径末端节点（遍历到此为止，不含它自身）
 * @returns {Array<{role:string, content:string}>} 发送给服务商的 messages 数组
 */
export function buildApiMessages(endNode) {
    // 同步系统提示词到根节点（会话级覆盖优先，否则全局默认；设置变更后此处即生效）
    if (state.chatTree) state.chatTree.content = getEffectiveSysPrompt();

    const path = [];
    let curr = state.chatTree;
    while (curr && curr !== endNode) {
        path.push(curr);
        curr = curr.children?.[curr.selectedChildIndex];
    }

    // 过滤错误节点：错误回复不应进入请求上下文
    const valid = path.filter(n => !n.isError);

    // 合并连续同角色消息：减少 token 消耗，符合多数 chat/completions 接口预期
    const messages = [];
    for (const n of valid) {
        const last = messages[messages.length - 1];
        if (last && last.role === n.role) {
            last.content += '\n' + n.content;
        } else {
            messages.push({ role: n.role, content: n.content });
        }
    }
    return messages;
}

/**
 * 查找树中最大 ID（用于导入存档后把 state.msgIdCounter 设到正确起点，避免 id 冲突）
 * @param {object} node - 子树根节点
 * @returns {number} 整棵子树中出现过的最大 id；节点为空时返回 0
 */
export function findMaxId(node) {
    if (!node) return 0;
    let max = node.id || 0;
    for (const child of (node.children || [])) {
        max = Math.max(max, findMaxId(child));
    }
    return max;
}

/**
 * 序列化白名单：节点允许落盘（存档 / 导出 JSON）的字段，与 createNode 产物一一对应。
 * 运行时标记（_autoReadArmed / _autoEnq 等下划线私有字段）不在此列——统一在此拦截，
 * serialize / deserialize 口径一致（用户 2026-08-21 反馈 P4-10：此前 save/export 直写原始树，
 * 运行时标记跟着落档，只有 load 时才清理，两边口径不一致）。
 * @type {Set<string>}
 */
const NODE_SERIALIZE_KEYS = ['id', 'role', 'content', 'time', 'children', 'selectedChildIndex', 'isError'];

/**
 * 产出「干净可序列化」的树副本：逐节点按 NODE_SERIALIZE_KEYS 白名单重建。
 * 供 storage.persistSession（落盘）与 data-exchange（导出 JSON）共用——
 * 单一出口保证任何新挂到 node 上的运行时字段都进不了存档。
 * 注意：返回新对象，不修改原树（内存节点的运行时标记在会话内继续有效）。
 * @param {object} node - 子树根节点（通常是 state.chatTree 或导入的树）
 * @returns {object|null} 白名单清洗后的新树；入参为空时返回 null
 */
export function serializeTree(node) {
    if (!node || typeof node !== 'object') return null;
    const out = {};
    for (const k of NODE_SERIALIZE_KEYS) {
        if (k === 'children') {
            out.children = (node.children || []).map(serializeTree).filter(Boolean);
        } else if (node[k] !== undefined) {
            out[k] = node[k];
        }
    }
    return out;
}
