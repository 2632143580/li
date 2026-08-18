/**
 * 外部"主动说话"入口（companion-say）
 *
 * 供 App 热更新容器注入调用：App 定时往聊天里插入一条【可见的】用户消息，
 * 让 LI 用【网页自己配置的模型】生成回复——App 不持有、不注入任何模型配置，
 * 推送用的就是用户在 LI 网页设置里填的 LLM。
 *
 * 与 _bgApi.triggerProactive 的区别：
 *   - triggerProactive 是静默的（只注入 API 层 system 指令，聊天里没有用户消息）
 *   - 本入口的对话是可见的（聊天里出现"用户消息 + AI 回复"），
 *     符合"插入一段消息让 li 回复我"的产品语义
 *
 * 流程：__liCompanionSay(text) → sendMessage（等价用户在输入框发送）
 *      → 轮询等待该消息下的 AI 节点出内容 → __liCompanionOnReply 注册的回调收到回复
 *
 * 防误判：说话期间 sessionStorage 置 liCompanionSaying=1，
 *    App 的注入观察脚本据此跳过"这次 user 气泡不算用户互动"，
 *    避免 li 自己说话刷新"久未互动"计时器导致 B 功能永远不触发。
 *
 * 依赖：chat/tree（sendMessage）、core/store（state）。
 */
import { sendMessage } from './chat/tree.js';
import { state } from './core/store.js';

/** App 注册的回复完成回调（成功/失败都会回调恰好一次） @type {function(string, boolean)|null} */
let replyCallback = null;

/** 回复等待超时（毫秒）：超过则按失败回调，避免回调永远不触发 */
const REPLY_TIMEOUT_MS = 120000;

/** 递归按 id 查找节点（对话树节点量级为数百到数千，全树搜索开销可忽略） */
function findNodeById(node, id) {
    if (!node || typeof node !== 'object') return null;
    if (node.id === id) return node;
    for (const child of (node.children || [])) {
        const found = findNodeById(child, id);
        if (found) return found;
    }
    return null;
}

/**
 * 初始化外部入口（main.js init 时调用）。
 * 安全约束：入参必须为非空字符串；LI 正在等回复（state.waiting）时拒绝，避免打断用户。
 */
export function initCompanionSay() {
    // App 注入的"插入消息让 li 回复"入口
    window.__liCompanionSay = function (text) {
        if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
        if (state.waiting) return { ok: false, reason: 'busy' };
        sessionStorage.setItem('liCompanionSaying', '1');
        const userNodeId = sendMessage(text);
        if (userNodeId == null) {
            sessionStorage.removeItem('liCompanionSaying');
            return { ok: false, reason: 'busy' };
        }
        waitForReply(userNodeId);
        return { ok: true };
    };

    // App 注册回复完成回调：成功 (content, false)；失败 ('', true)。恰好回调一次。
    window.__liCompanionOnReply = function (cb) {
        replyCallback = typeof cb === 'function' ? cb : null;
    };
}

/** 轮询等待指定用户节点下的 AI 回复（成功内容非空 / 失败 isError / 超时） */
function waitForReply(userNodeId) {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    const finish = (content, isError) => {
        sessionStorage.removeItem('liCompanionSaying');
        if (replyCallback) replyCallback(content, isError);
    };
    (function poll() {
        const userNode = findNodeById(state.chatTree, userNodeId);
        const aiNode = userNode && userNode.children && userNode.children.length > 0
            ? userNode.children[0]
            : null;
        if (aiNode && aiNode.isError) { finish('', true); return; }
        if (aiNode && typeof aiNode.content === 'string' && aiNode.content.length > 0) {
            finish(aiNode.content, false);
            return;
        }
        if (Date.now() > deadline) { finish('', true); return; }
        setTimeout(poll, 500);
    })();
}
