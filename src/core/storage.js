/**
 * 持久化存储 — localStorage 读写
 *
 * 职责：把 state 的 chatTree / settings / stats / msgIdCounter 落盘与回载。
 *       存档采用「白名单」策略：只有 DEFAULT_SETTINGS 出现的键才写入，未来新增配置自动纳入。
 *       监控统计（stats）跨刷新保留，清空对话时由 resetMonitorStats 归零。
 *
 * 导出：saveToLocal, loadFromLocal, debouncedSave
 * 依赖：core/logger, core/state, core/dom, core/tree-core（migrateErrorFlags, getLastNodeInPath）
 */
import { Logger } from './logger.js';
import { showToast } from './toast.js'; // 保存/加载失败改为可见提示（不再仅 console.warn 静默）
import { state } from './store.js';
import { DEFAULT_SETTINGS, STORAGE_KEY, SESSION_KEY_PREFIX } from './constants.js';
import { ensureKeysObject, KEY_PROVIDERS } from './utils.js';
import { DOM } from './dom.js';
import { migrateErrorFlags, getLastNodeInPath, serializeTree } from './tree-core.js';
import { genSessionId, getEffectiveSysPrompt, freshStats, buildIndexEntry, lastMessageTime, migrateV3ToV4 } from './sessions.js';

/** 防抖保存定时器句柄 @type {number|null} */
let saveTimer = null;
/** 保存指示器显隐定时器句柄 @type {number|null} */
let indicatorTimer = null;

/**
 * 白名单清洗 settings（只保留 DEFAULT_SETTINGS 出现的键，防止运行时派生数据 / 历史残留键污染存档）。
 * keys 内部再按 KEY_PROVIDERS 白名单浅拷（历史存档 / 运行时写入的 custom 槽位一并剔除）。
 * @returns {object} 清洗后的 settings 副本
 */
function cleanSettingsForSave() {
    const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
    const clean = {};
    for (const key in state.settings) {
        if (allowedKeys.has(key)) clean[key] = state.settings[key];
    }
    if (clean.keys) {
        const keyObj = {};
        for (const p of KEY_PROVIDERS) keyObj[p] = clean.keys[p] || '';
        clean.keys = keyObj;
    }
    return clean;
}

/**
 * 写入全局键（v4）：settings + 激活会话 id + 会话索引 + 消息计数器 + 版本号。
 * 与单会话键解耦——全局键只放「跨会话」的元信息，正文按会话分键存。 @returns {void}
 */
function writeGlobalKey() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        settings: cleanSettingsForSave(),
        activeSessionId: state.activeSessionId,
        sessionIndex: state.sessionIndex || [],
        msgIdCounter: state.msgIdCounter,
        modelCache: state.modelCache, // 按服务商缓存的已拉取模型清单（仅本机 localStorage，不进导出备份）
        version: 4
    }));
}

/**
 * 读取单会话原始存档（liSession_<id>）。损坏/缺失返回 null（调用方需兜底）。
 * @param {string} id @returns {object|null}
 */
function readSessionRaw(id) {
    try {
        const raw = localStorage.getItem(SESSION_KEY_PREFIX + id);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

/**
 * 写入单会话存档（liSession_<id>）。 @param {object} obj 会话原始对象
 */
function writeSessionRaw(obj) {
    localStorage.setItem(SESSION_KEY_PREFIX + obj.id, JSON.stringify(obj));
}

/**
 * 删除单会话存档键。 @param {string} id
 */
function deleteSessionKey(id) {
    try { localStorage.removeItem(SESSION_KEY_PREFIX + id); } catch (_) { /* 忽略 */ }
}

/**
 * 保存状态到 localStorage（分键存储 v4）。
 * 同时写全局键（settings/索引/激活id/计数器）与「当前激活会话」的单会话键（chatTree/stats/sysPrompt/draft），
 * 二者同源写一次，避免两处序列化漂移。
 * @param {string} [message='已保存'] - 显示在指示器上的消息；传 null 表示不更新文案
 * @param {boolean} [silent=false] - 静默模式，不显示指示器动画
 */
export function saveToLocal(message = '已保存', silent = false) {
    try {
        // 1. 写当前激活会话的单会话键（携带正文与监控统计）
        persistSession(state.activeSessionId, undefined);
        // 2. 写全局键（含最新索引）
        writeGlobalKey();

        if (!silent && message) {
            DOM.saveIndicator.textContent = message;
            DOM.saveIndicator.classList.add('show');
            clearTimeout(indicatorTimer);
            indicatorTimer = setTimeout(() => {
                DOM.saveIndicator.classList.remove('show');
            }, 1200);
        }
    } catch (e) {
        // 保存失败原仅 console.warn（用户无感知，属共因 B 静默失败）。
        // 典型场景：localStorage 写满（大量聊天/语音缓存）→ QuotaExceededError。
        // 改为可见 toast，让用户知道存档可能不完整。
        if (e && e.name === 'QuotaExceededError') {
            showToast('存档空间不足，部分对话或设置可能未能保存，建议清理对话或导出备份', 'error', 5000);
        } else {
            Logger.warn('[Storage] 保存失败', e);
        }
    }
}

/**
 * 落盘单会话（全局键 + 单会话键）。默认落「当前激活会话」（读 state.chatTree/stats/sessionSysPrompt），
 * 也可传 snapshot 显式落某个后台会话（后台流式完成时按 pending 快照落，内容不被切到的当前会话污染）。
 * @param {string} id 会话 id（默认 state.activeSessionId）
 * @param {{tree:object,stats:object,sysPrompt:string|null,draft:string,manualTitle:string|null,llmConfig:object|null,pinned:boolean}|undefined} [snapshot] 后台会话快照；省略则取当前激活态
 * @returns {void}
 */
export function persistSession(id = state.activeSessionId, snapshot) {
    if (!id) return;
    const tree = snapshot ? snapshot.tree : state.chatTree;
    const stats = snapshot ? snapshot.stats : state.stats;
    const sysPrompt = snapshot ? snapshot.sysPrompt : state.sessionSysPrompt;
    const draft = snapshot ? snapshot.draft : '';
    const manualTitle = snapshot ? snapshot.manualTitle : null;
    // 会话级 LLM 配置：快照优先（后台会话用快照时的配置），无快照取当前激活态
    const llmConfig = snapshot ? (snapshot.llmConfig || null) : state.sessionLlmConfig;
    if (!tree) return;

    // 保留既有 createdAt / manualTitle / pinned（新建时由调用方写入；未显式传入时沿用旧值，
    // 避免每次保存清空重命名或丢失置顶态）；pinned 仅在 setSessionPinned 显式切换
    const prev = readSessionRaw(id);
    const createdAt = (prev && prev.createdAt) || Date.now();
    const keepTitle = (snapshot && ('manualTitle' in snapshot)) ? snapshot.manualTitle : (prev ? (prev.manualTitle ?? null) : null);
    const keepPinned = (snapshot && ('pinned' in snapshot)) ? snapshot.pinned : (prev ? (prev.pinned || false) : false);
    // 时间基准统一取「最后消息时间」：节点 time 在创建时一次写好，刷新/重保存都不变，
    // 旧数据（节点无 time）回退到 prev.updatedAt，再不行才用现在——保证排序/相对时间稳定不乱跳
    const updatedAt = lastMessageTime(tree) || (prev ? prev.updatedAt : Date.now());
    const raw = {
        id,
        // 白名单序列化（P4-10）：剔除节点上的运行时标记（_autoReadArmed/_autoEnq 等），
        // 与 load 时 clearRuntimeFlags、导出口径三方一致；time 是合法持久字段照常保留
        chatTree: serializeTree(tree),
        stats: stats || freshStats(),
        sysPrompt: sysPrompt ?? null,
        llmConfig: llmConfig,
        draft: draft,
        createdAt,
        updatedAt,
        manualTitle: keepTitle ?? null,
        pinned: keepPinned
    };
    writeSessionRaw(raw);

    // 同步内存索引 + 落全局键（索引在不同调用间保持一致）
    updateIndexFromRaw(id, raw);
    writeGlobalKey();
}

/** 由会话原始对象刷新内存索引条目（标题/计数/预览/时间/LLM配置/SP/置顶），不解析正文外的多余字段。 */
function updateIndexFromRaw(id, raw) {
    // llmConfig/sysPrompt 从本会话 raw 取（而非当前激活会话），保证后台会话索引显示自己的配置
    const entry = buildIndexEntry(id, raw.chatTree, raw.manualTitle, raw.llmConfig, raw.sysPrompt, raw.pinned || false);
    // 旧数据节点无 time 字段 → lastMessageTime 为 0，buildIndexEntry 会退回 Date.now() 造成漂移；
    // 此时沿用索引旧值，保住「最后消息时间」稳定（仅当用户真发消息、节点带 time 后才自然更新）
    const prev = (state.sessionIndex || []).find(e => e.id === id);
    if (lastMessageTime(raw.chatTree) === 0 && prev) entry.updatedAt = prev.updatedAt;
    const idx = state.sessionIndex || (state.sessionIndex = []);
    const i = idx.findIndex(e => e.id === id);
    if (i >= 0) idx[i] = entry; else idx.push(entry);
}

/**
 * 加载指定会话的正文数据（chatTree/stats/sysPrompt/llmConfig/draft）到运行时。
 * 优先用后台 pending 快照（若仍在生成，持有最新 tree），否则读单会话键。
 * @param {string} id @returns {{tree:object,stats:object,sysPrompt:string|null,llmConfig:object|null,draft:string}|null}
 */
export function loadSession(id) {
    const p = state.pending.get(id);
    if (p) return { tree: p.tree, stats: p.stats, sysPrompt: p.sysPrompt, llmConfig: p.llmConfig || null, draft: p.draft || '' };
    const raw = readSessionRaw(id);
    if (!raw) return null;
    return {
        tree: raw.chatTree,
        stats: raw.stats || freshStats(),
        sysPrompt: raw.sysPrompt ?? null,
        llmConfig: raw.llmConfig || null,
        draft: raw.draft || ''
    };
}

/**
 * 删除指定会话的存档键并移除其索引条目（不处理「激活态」——由 session-manager 负责切到其它会话）。
 * @param {string} id
 */
export function deleteSession(id) {
    deleteSessionKey(id);
    const idx = state.sessionIndex || (state.sessionIndex = []);
    const i = idx.findIndex(e => e.id === id);
    if (i >= 0) idx.splice(i, 1);
    writeGlobalKey();
}

/** 防抖保存 — 800ms 内多次调用合并为一次，降低频繁写入。 @returns {void} */
export function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveToLocal(null, true), 800);
}

/**
 * 立即落盘（清掉防抖定时器并同步写）。切换会话前调用：把「当前激活会话」的待保存立即写入，
 * 杜绝 800ms 防抖未触发就被覆盖导致旧会话改动永久丢失（规划自审漏洞①）。 @returns {void}
 */
export function flushSave() {
    clearTimeout(saveTimer);
    saveToLocal(null, true);
}

/**
 * 从 localStorage 加载状态（v4 分键）。
 * @returns {boolean} 是否加载成功（无存档 / 结构非法时返回 false）
 */
export function loadFromLocal() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return false;
        const data = JSON.parse(saved);

        // ---- v3 老存档迁移：包成第一个会话，原地转 v4 ----
        if (data.version === 3) {
            if (!data.chatTree || data.chatTree.role !== 'system') return false;
            const m = migrateV3ToV4(data);
            writeSessionRaw(m.firstSessionRaw);            // 写首会话键
            applyLoadedSettings(m.settings);              // 恢复全局设置
            state.msgIdCounter = m.msgIdCounter || 0;
            state.sessionIndex = m.index;                 // 内存索引
            state.activeSessionId = m.activeSessionId;     // 激活首会话
            writeGlobalKey();                             // 落 v4 全局键（覆盖老 v3 结构）
            // 继续往下加载该会话正文
            data.version = 4;
            data.activeSessionId = m.activeSessionId;
            data.sessionIndex = m.index;
        }

        if (data.version !== 4) return false;

        // 先应用设置再判会话有效性：即使「尚无会话」（首跑刚建键但未写入索引的窗口），
        // 全局设置也必须加载——否则首跑注入/上次修改的设置丢失，请求会打到默认地址。
        applyLoadedSettings(data.settings);
        // 恢复模型清单缓存：modelCache 随全局键落盘（writeGlobalKey），必须在此读回。
        // 此前漏读导致每次刷新缓存清空 → 设置页模型列表「时有时无」（当前模型兜底塞入与空列表交替的假象）。
        state.modelCache = (data.modelCache && typeof data.modelCache === 'object') ? data.modelCache : {};
        state.msgIdCounter = data.msgIdCounter || 0;
        state.sessionIndex = data.sessionIndex || [];
        state.activeSessionId = data.activeSessionId || (state.sessionIndex[0] && state.sessionIndex[0].id) || null;
        if (!state.activeSessionId) return false; // 无有效会话：由 main.js 建首会话（此时设置已生效）

        // 加载激活会话正文
        const loaded = loadSession(state.activeSessionId);
        if (!loaded) return false;
        state.chatTree = loaded.tree;
        state.stats = loaded.stats;
        state.sessionSysPrompt = loaded.sysPrompt ?? null;
        state.sessionLlmConfig = loaded.llmConfig || null; // 会话级 LLM 配置随激活会话恢复（刷新不丢）

        migrateErrorFlags(state.chatTree);                 // 旧数据推导 isError 标记
        state.currentEndNode = getLastNodeInPath(state.chatTree); // 恢复到当前路径末端

        // 清除运行时标记：_autoReadArmed / _autoEnq 是自动朗读的运行时状态，序列化后仍挂在 node 上。
        // 刷新恢复后流式已结束（isStreaming=false），但 _autoReadArmed=true 会让 maybeAutoRead 误判
        // 「流式刚完成该入队自动朗读」，导致刷新页面突然自动朗读历史消息。根治：walk 全树清除运行时标记。
        (function clearRuntimeFlags(node) {
            if (!node) return;
            if (node._autoReadArmed !== undefined) delete node._autoReadArmed;
            if (node._autoEnq !== undefined) delete node._autoEnq;
            if (Array.isArray(node.children)) {
                for (const child of node.children) clearRuntimeFlags(child);
            }
        })(state.chatTree);

        // 根节点 content 同步为有效系统提示词（会话级覆盖 / 全局默认）
        if (state.chatTree) state.chatTree.content = getEffectiveSysPrompt();

        return true;
    } catch (e) {
        // 坏存档（半截 JSON / 结构非法）解析失败：清档 + 提示，让用户从干净状态启动。
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* 下一行已 return false */ }
        showToast('本地存档已损坏，已重置为空白会话', 'warn', 5000);
        Logger.warn('[Storage] 加载失败，已清除坏存档', e);
        return false;
    }
}

/**
 * 把存档中的 settings 白名单合并回运行时（只接受 DEFAULT_SETTINGS 存在的键，
 * 防止历史残留键进入运行时并随导出泄漏）。 @param {object} [settings]
 */
function applyLoadedSettings(settings) {
    if (settings && typeof settings === 'object') {
        const allowedKeys = new Set(Object.keys(DEFAULT_SETTINGS));
        const filtered = {};
        for (const key in settings) {
            if (allowedKeys.has(key)) filtered[key] = settings[key];
        }
        Object.assign(state.settings, filtered);
        ensureKeysObject(state.settings);
    }
}

/**
 * 首跑无存档时：建空白首会话并落盘（main.js 在 loadFromLocal 返回 false 时调用）。
 * @returns {string} 新会话 id
 */
export function createFirstSession() {
    const id = genSessionId();
    state.activeSessionId = id;
    state.sessionSysPrompt = null;
    state.sessionLlmConfig = null; // 首会话继承全局 LLM 配置
    state.sessionIndex = [buildIndexEntry(id, state.chatTree, null)];
    persistSession(id); // 写单会话键 + 全局键（含索引）
    return id;
}

/** 公开别名：api.js 等外部按「保存某会话」语义调用。 */
export const saveSession = persistSession;

/**
 * 设置会话标题（手动重命名）。空名 = 恢复自动标题（按首条 user 消息推导）。
 * 只改单会话键的 manualTitle + 重建索引条目 + 落全局键，不动正文。 @param {string} id @param {string} title
 */
export function setSessionTitle(id, title) {
    const raw = readSessionRaw(id);
    if (!raw) return;
    raw.manualTitle = (title && title.trim()) ? title.trim() : null;
    raw.updatedAt = Date.now();
    writeSessionRaw(raw);
    updateIndexFromRaw(id, raw);
    writeGlobalKey();
}

/**
 * 切换会话置顶态（长按菜单「置顶/取消置顶」触发）。只改单会话键的 pinned + 重建索引条目 + 落全局键，
 * 不动正文、不动 updatedAt（置顶不改变「最后消息时间」，仅影响排序优先级）。 @param {string} id @param {boolean} pinned
 */
export function setSessionPinned(id, pinned) {
    const raw = readSessionRaw(id);
    if (!raw) return;
    raw.pinned = !!pinned;
    writeSessionRaw(raw);
    updateIndexFromRaw(id, raw);
    writeGlobalKey();
}
