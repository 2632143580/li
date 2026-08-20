/**
 * 会话编排层（运行时切换 / 新建 / 删除 / 重命名的副作用编排）
 *
 * 职责：把「会话数据层(sessions.js) + 存储(storage.js) + 渲染(tree/tree-render) +
 *       语音(tts-engine/voice-tiles) + 输入(input-manager)」在切换/新建/删除时正确串起来。
 *   - 切会话：先落旧 → 存草稿 → 清朗读/瓷砖追踪/待渲染帧 → 清 domCache（隔离后台 DOM 回写）→
 *             载入新会话 → per-session waiting → 恢复草稿 + 重渲染。
 *   - 新建：当前会话无任何 user 消息则复用不新建（防空会话堆积）；否则建新树、入索引、落盘。
 *   - 删除：先 abort 其后台流 → 删键与索引 → 删到最后一个自动新建空会话（永远≥1）。
 *
 * 依赖：core/state、core/sessions（纯数据）、core/storage（落盘）、chat/tree（initChatTree 等）、
 *       ui/render/tree-render、ui/voice-tiles、engines/tts-engine、ui/input-manager、core/modal。
 * 导出：switchTo / createNew / removeSession / renameSession / listSessions
 */

import { state } from '../core/store.js';
import { genSessionId, getEffectiveSysPrompt, freshStats, buildIndexEntry } from '../core/sessions.js';
import { loadSession, saveSession, deleteSession, setSessionTitle, flushSave } from '../core/storage.js';
import { initChatTree, applySettings, getLastNodeInPath, renderChat, updateMonitorUI } from './tree.js';
import { cancelPendingStream } from '../ui/render/tree-render.js';
import { resetTileTracking } from '../ui/voice-tiles.js';
import { clearAutoQueue } from '../engines/tts-engine.js';
import { inputManager } from '../ui/input-manager.js';
import { inputRenderer } from '../ui/input-renderer.js';
import { DOM } from '../core/dom.js';
import { closeAllModals } from '../core/modal.js';

/** 当前输入框内容（作为激活会话草稿）。 @returns {string} */
function captureDraft() {
    return inputManager.text || '';
}

/** 恢复草稿到输入框（同步 inputManager.text 与隐藏 input，并标记重绘输入画布）。 @param {string} draft */
function restoreDraft(draft) {
    const t = draft || '';
    inputManager.text = t;
    if (DOM.hiddenInput) DOM.hiddenInput.value = t;
    inputRenderer.markDirty();
}

/** 清空输入框。 */
function clearInput() {
    inputManager.text = '';
    if (DOM.hiddenInput) DOM.hiddenInput.value = '';
    inputRenderer.markDirty();
}

/** 树是否含 user 消息（空会话复用判定）。 @param {object} tree @returns {boolean} */
function hasUserMessage(tree) {
    const stack = [tree];
    while (stack.length) {
        const n = stack.pop();
        if (n.role === 'user') return true;
        if (n.children) for (const c of n.children) stack.push(c);
    }
    return false;
}

/**
 * 切换会话（列表点非当前行触发）。
 * 完整重置序列：落旧 → 存草稿 → 清朗读/瓷砖/待渲染帧 → 清 domCache → 载入新 → per-session waiting → 恢复草稿 + 重渲染。
 * @param {string} id 目标会话 id（等于当前激活则仅关面板）
 */
export function switchTo(id) {
    if (!id || id === state.activeSessionId) { closeAllModals(); return; }

    flushSave(); // 旧的仍是激活态，立即落盘（漏洞①：防 800ms 防抖未触发被覆盖）
    if (state.activeSessionId) {
        const p = state.pending.get(state.activeSessionId);
        if (p) p.draft = captureDraft(); // 后台生成中的旧会话：草稿暂存快照
    }

    // 清理会话级运行时副作用；清 domCache 是隔离后台 DOM 回写的关键
    clearAutoQueue();
    resetTileTracking();
    cancelPendingStream();
    state.domCache.clear();

    const sess = loadSession(id); // 优先 pending 快照（仍在生成则持最新 tree）
    if (!sess) { closeAllModals(); return; }
    state.chatTree = sess.tree;
    state.stats = sess.stats;
    state.sessionSysPrompt = sess.sysPrompt ?? null;
    state.activeSessionId = id;
    state.currentEndNode = getLastNodeInPath(state.chatTree);
    state.chatTree.content = getEffectiveSysPrompt();
    state.waiting = state.pending.has(id); // per-session waiting

    restoreDraft(sess.draft);
    applySettings();
    renderChat();
    updateMonitorUI();
    closeAllModals();
}

/**
 * 新建会话（列表「＋ 新建会话」触发）。当前会话空则复用不新建。 @returns {string|null} 新 id 或 null（复用）
 */
export function createNew() {
    const oldId = state.activeSessionId;
    if (oldId && !hasUserMessage(state.chatTree)) { closeAllModals(); return null; }

    flushSave();
    if (oldId) {
        const p = state.pending.get(oldId);
        if (p) p.draft = captureDraft();
    }

    clearAutoQueue();
    resetTileTracking();
    cancelPendingStream();
    state.domCache.clear();

    state.sessionSysPrompt = null;     // 新会话继承全局默认
    initChatTree();                    // 建根 + 欢迎并渲染
    state.stats = freshStats();        // 独立统计
    const id = genSessionId();
    state.activeSessionId = id;

    state.sessionIndex.push(buildIndexEntry(id, state.chatTree, null));
    clearInput();
    applySettings();
    renderChat();
    updateMonitorUI();
    saveSession(id);
    closeAllModals();
    return id;
}

/**
 * 删除会话（列表长按 → 确认触发）。删到最后一个自动新建空会话（永远≥1）。 @param {string} id
 */
export function removeSession(id) {
    if (!id) return;
    const p = state.pending.get(id);
    if (p && p.controller) { try { p.controller.abort(); } catch (_) { /* 已结束 */ } }
    state.pending.delete(id);

    deleteSession(id);

    if (id === state.activeSessionId) {
        const next = (state.sessionIndex && state.sessionIndex[0] && state.sessionIndex[0].id) || null;
        if (next) {
            switchTo(next);
        } else {
            clearAutoQueue();
            resetTileTracking();
            cancelPendingStream();
            state.domCache.clear();
            state.sessionSysPrompt = null;
            initChatTree();
            state.stats = freshStats();
            const nid = genSessionId();
            state.activeSessionId = nid;
            state.sessionIndex = [buildIndexEntry(nid, state.chatTree, null)];
            clearInput();
            applySettings();
            renderChat();
            updateMonitorUI();
            saveSession(nid);
        }
    }
}

/**
 * 重命名会话（列表点当前行触发）。空名 = 恢复自动标题。 @param {string} id @param {string} newTitle
 */
export function renameSession(id, newTitle) {
    setSessionTitle(id, newTitle || '');
}

/**
 * 列表数据：索引副本按 updatedAt 倒序，标注后台是否在生成。 @returns {Array<{id,title,msgCount,preview,updatedAt,streaming}>}
 */
export function listSessions() {
    const list = (state.sessionIndex || []).map(e => ({
        id: e.id,
        title: e.title,
        msgCount: e.msgCount,
        preview: e.preview,
        updatedAt: e.updatedAt,
        streaming: state.pending.has(e.id)
    }));
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
}
