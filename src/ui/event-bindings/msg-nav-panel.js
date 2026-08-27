/**
 * 消息导航面板（双 tab：会话 / 消息）。
 *
 * 设计原则：复用优先、零重造、无气泡、纯正向、极简。
 *   - 会话 tab：新建会话入口 + 会话列表（标题 / 消息数 / 相对时间 / 后台生成指示 / 当前会话竖线 /
 *              置顶标记 / 长按菜单[重命名·删除·置顶] / LLM 快切芯片 / SP 行内编辑）。
 *   - 消息 tab：原极简消息列表 + 高频词下划线（与词云融化），分词延迟到进此 tab 才计算，默认进会话 tab 秒开。
 *
 * 交互细节（每条都有理由）：
 *   - 进入会话 = 点击会话「名字」区域（标题带常驻极淡 › 箭头作可点击暗示，hover/按下高亮 accent）。
 *     整行不再有「进入」按钮或「当前」灰标——当前态仅用左侧 2px accent 竖线表达，零多余元素。
 *   - 长按 = 弹出操作菜单[重命名 / 删除 / 置顶]，由原生 contextmenu 事件驱动（移动端长按 / 桌面右键均可靠派发，
 *     比纯 pointer 计时器更稳）；菜单为气泡弹窗，锚定被按行下缘（溢出视口则上翻），外罩 scrim 点空白即关。
 *     根因修复：旧版在 pointercancel 上取消计时器，而移动端长按时浏览器必派发 pointercancel 接管手势 → 菜单永远开不了；
 *     现改为原生 contextmenu 主触发 + pointer 计时器兜底，且 pointercancel 不再取消，真机 Via 实测可稳定弹出。
 *   - 相对时间：取「最后一条消息（user 或 assistant）的创建时间」到现在（见 sessions.lastMessageTime），
 *     开面板算一次，不设定时器；排序同样以此为基准，稳定不乱跳。
 *   - 后台生成：复用 .typing-dots（prefers-reduced-motion 自动降级），是「后台继续生成」的反馈闭环。
 *   - LLM 芯片：只有两个模型，点按在 智谱↔DeepSeek 间两态互切（无「全局」第三态，本来就只有两个模型）；
 *     SP 小标签：点击行内展开编辑器（无气泡/盒子包裹，accent = 有会话级覆盖）。
 *   - 当前会话：左侧 2px accent 竖线（位置语义，比色块轻）；置顶：行首小别针标记 + 排序优先。
 *
 * 样式外提：所有 CSS 已移入 modal.css（#msg-nav 前缀），本模块不含内联 <style>。
 * Escape 关闭由 global.js 统一处理，本模块不注册 Escape 监听。
 *
 * 依赖：core/dom、core/store、chat/tree、chat/session-manager、core/wordcloud-analyzer、core/registry、core/modal
 */

import { DOM } from '../../core/dom.js';
import { state } from '../../core/store.js';
import { getCurrentPath } from '../../chat/tree.js';
import {
    switchTo, createNew, removeSession, renameSession, listSessions
} from '../../chat/session-manager.js';
import { analyzeWordFreq, getActiveSegmenter } from '../../core/wordcloud-analyzer.js';
import { registerUI } from '../../core/registry.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { getProviderByUrl } from '../../core/utils.js';
import { loadSession, persistSession, setSessionPinned, saveToLocal } from '../../core/storage.js';
import { showToast } from '../../core/toast.js';
import { getEffectiveSysPrompt } from '../../core/sessions.js';
import { armClickConfirm } from './click-confirm.js';
import { openWordCloud } from './wordcloud-panel.js';
import { DEFAULT_PROVIDER, WELCOME } from '../../core/constants.js';
import { createNode } from '../../core/tree-core.js';
import { initChatTree } from '../../chat/tree.js';
import { clearAutoQueue } from '../../engines/tts-engine.js';
import { updateCacheUI, resetMonitorStats } from '../render/tree-render.js';

registerUI('msg-nav', setupMsgNav);

/** 记住上次 tab 的小键（独立 localStorage，同 topbar 折叠态做法） @type {string} */
const TAB_KEY = 'liNavTab';
/** 融预览的高频词数量上限 @type {number} */
const HOT_N = 14;
/** 预览截取字符数 @type {number} */
const PREVIEW_CH = 120;
/** 长按进入操作菜单的时长（ms），对标词云长按 @type {number} */
const LONG_PRESS_MS = 600;
/** 角色色点：与词云分色一致（user 暖橙 / ai 冷蓝） @type {Object<string,string>} */
const ROLE_DOT = { user: '#ff9f43', assistant: '#4dabf7' };

/** 读上次 tab（默认 'sessions'） @returns {'sessions'|'messages'} */
function readTab() {
    try { return localStorage.getItem(TAB_KEY) === 'messages' ? 'messages' : 'sessions'; } catch (_) { return 'sessions'; }
}
/** 写上次 tab @param {'sessions'|'messages'} t */
function writeTab(t) {
    try { localStorage.setItem(TAB_KEY, t); } catch (_) { /* 忽略 */ }
}

/** 相对时间：开面板算一次，不设定时器 @param {number} ts 毫秒时间戳 @returns {string} */
function relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d === 1) return '昨天';
    if (d < 7) return d + ' 天前';
    const dt = new Date(ts);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

/**
 * 会话芯片应显示的服务商：单一事实源 = llmConfig.provider（会话显式选的服务商）。
 * 会话级覆盖的 provider 优先；无覆盖则继承默认服务商 DEFAULT_PROVIDER；
 * 旧存档 llmConfig 仍存 apiUrl 时，用 getProviderByUrl 兼容推导（防御兜底，不双源漂移）。
 * @param {object} s 列表条目 @returns {'zhipu'|'deepseek'|'custom'}
 */
function effectiveProvider(s) {
    const cfg = s.llmConfig || null;
    if (cfg && cfg.provider) return cfg.provider;
    if (cfg && cfg.apiUrl) return getProviderByUrl(cfg.apiUrl); // 兼容旧存档
    return DEFAULT_PROVIDER;
}

/**
 * 会话生效模型名：优先取会话级显式 model（llmConfig.model），
 * 否则取「该服务商在设置页调好的默认模型」(settings.providers[p].model)，零写死、不读清单首。
 * 用于芯片显示「真实模型标识」。 @param {object} s 列表条目 @returns {string}
 */
function effectiveModel(s) {
    const cfg = s.llmConfig || null;
    const p = effectiveProvider(s);
    if (cfg && cfg.model) return cfg.model;
    return state.settings.providers[p].model || '';
}

function setupMsgNav() {
    // 双初始化防护：HMR 或重复调用时跳过
    if (document.getElementById('msg-nav')) return;

    const btn = DOM.btnMsgNav;
    if (!btn) return;
    btn.style.cursor = 'pointer';

    const panel = document.createElement('div');
    panel.id = 'msg-nav';
    panel.className = 'modal-overlay sheet';

    panel.innerHTML = `
        <div class="sheet-body">
            <div class="mn-head">
                <div class="mn-tabs segmented" role="group" aria-label="面板切换">
                    <button type="button" class="segmented__item" data-tab="sessions">会话</button>
                    <button type="button" class="segmented__item" data-tab="messages">消息</button>
                    <button type="button" class="segmented__item" data-tab="words">词频</button>
                </div>
                <button class="mn-close" id="mn-close" aria-label="关闭">✕</button>
            </div>
            <div class="mn-pane" data-pane="sessions">
                <button class="mn-new" id="mn-new">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
                    <span>新建会话</span>
                </button>
                <div class="mn-list" id="mn-sessions"></div>
            </div>
            <div class="mn-pane" data-pane="messages" hidden>
                <input class="mn-search" id="mn-search" type="text" placeholder="查找消息…" autocomplete="off" />
                <div class="mn-sub" id="mn-sub"></div>
                <div class="mn-list" id="mn-list"></div>
            </div>
            <div class="mn-pane" data-pane="words" hidden></div>
        </div>
    `;
    document.body.appendChild(panel);

    /** 当前打开的「提示词预览气泡」实例（null = 无）。点击会话行 SP pill 弹出，点外/切会话收起 @type {HTMLElement|null} */
    let spBubbleEl = null;
    /** 长按操作菜单是否打开 @type {boolean} */
    let ctxMenuOpen = false;

    // 长按操作菜单：外罩 scrim + 气泡菜单（锚定被按行）。挂在 panel 下，脱离 .mn-list 的 overflow 裁剪
    const ctxScrim = document.createElement('div');
    ctxScrim.className = 'mn-ctx-scrim';
    const ctxMenu = document.createElement('div');
    ctxMenu.className = 'mn-ctx';
    ctxScrim.addEventListener('click', closeCtxMenu);
    panel.appendChild(ctxScrim);
    panel.appendChild(ctxMenu);

    /** 关闭长按操作菜单（不影响列表渲染状态） */
    function closeCtxMenu() {
        ctxMenuOpen = false;
        ctxScrim.style.display = 'none';
        ctxMenu.style.display = 'none';
        ctxMenu.innerHTML = '';
    }

    /**
     * 打开长按操作菜单，锚定到被按行。
     * 菜单项：重命名（行内 input）/ 置顶或取消置顶（依当前态）/ 删除。
     * 定位：行下缘起，溢出视口则上翻；水平夹在视口内。 @param {string} id @param {HTMLElement} row
     */
    function openCtxMenu(id, row) {
        if (ctxMenuOpen) return; // 幂等：contextmenu 与原生 pointer 计时器可能各触发一次，避免重复构建菜单/重复震动
        const item = listSessions().find(s => s.id === id);
        if (!item) return;
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) { /* 不支持忽略 */ } } // 长按触发的轻震反馈（移动端闭环）
        ctxMenuOpen = true;
        const pinned = item.pinned;
        ctxMenu.innerHTML = `
            <button type="button" data-act="rename">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                <span>重命名</span>
            </button>
            <button type="button" data-act="pin">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 7 3 3v2H7v-2l3-3-1-7Z"/><path d="M12 16v5"/></svg>
                <span>${pinned ? '取消置顶' : '置顶'}</span>
            </button>
            <button type="button" data-act="delete" class="mn-ctx-danger">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>
                <span>删除</span>
            </button>
            <span class="mn-ctx-sep" aria-hidden="true"></span>
            <button type="button" data-act="clear">
                <!-- 虚线框 = 会话壳子保留、内部消息擦除（区别于删除整个会话的实心垃圾桶） -->
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>
                <span>清空对话</span>
            </button>`;
        ctxScrim.style.display = 'block';
        ctxMenu.style.display = 'block';
        // 先显示再量尺寸定位（display:none 时 offset 为 0）
        const r = row.getBoundingClientRect();
        const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
        let top = r.bottom + 6;
        if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
        const left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
        ctxMenu.style.top = top + 'px';
        ctxMenu.style.left = left + 'px';
        // 删除：二次点击确认（复用 click-confirm，避免误删会话）。首点按钮翻「确认删除?」且菜单保持；再点才执行
        const delBtn = ctxMenu.querySelector('[data-act="delete"]');
        if (delBtn) {
            armClickConfirm(delBtn, () => {
                closeCtxMenu();
                removeSession(id);
                renderSessions(); // 非当前会话删除后索引已更新，需手动重渲染列表
            }, { armedText: '确认删除?', resetMs: 3000 });
        }
        // 清空对话（2026-08-27 迁入）：原顶栏 #btn-clear-chat 由此接管，作用于被长按的会话。
        // 二次确认口径与原按钮一致（armed 文案原样沿用）
        const clearBtn = ctxMenu.querySelector('[data-act="clear"]');
        if (clearBtn) {
            armClickConfirm(clearBtn, () => {
                closeCtxMenu();
                clearSessionMessages(id);
            }, { armedText: '再次点击确认清空' });
        }
        // 其余菜单项（重命名 / 置顶）走统一 handler；删除/清空已由上方接管故跳过
        ctxMenu.querySelectorAll('button').forEach((b) => {
            if (b.dataset.act === 'delete' || b.dataset.act === 'clear') return;
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const act = b.dataset.act;
                closeCtxMenu();
                if (act === 'rename') startRename(row, id);
                else if (act === 'pin') togglePin(id);
            });
        });
    }

    /**
     * 清空指定会话的全部对话（长按菜单「清空对话」；2026-08-27 由顶栏 #btn-clear-chat 迁入）。
     * - 激活会话：走原按钮同一套收尾（停播清队列 / 重建欢迎树 / 缓存与监控归零 / 落盘提示）；
     * - 非激活会话：读快照换空欢迎树写回 —— 会话仍在列表，仅消息清空；
     *   manualTitle 从索引条目回填（persistSession 的快照默认 manualTitle=null，
     *   直接展开会抹掉重命名标题）。 @param {string} id
     */
    function clearSessionMessages(id) {
        if (id === state.activeSessionId) {
            clearAutoQueue(); // 清空对话即停当前播放 + 清空自动朗读队列（避免旧消息后台继续响）
            initChatTree();
            updateCacheUI(0);
            resetMonitorStats(); // 新一轮对话：累计 token / 缓存等归零
            saveToLocal('已清空');
            return;
        }
        const sess = loadSession(id);
        if (!sess) return;
        const root = createNode('system', getEffectiveSysPrompt());
        const welcome = createNode('assistant', WELCOME);
        welcome.reasoning = '好开心！'; // 与 initChatTree 同构：首屏演示思维链，不入请求上下文
        root.children.push(welcome);
        const item = listSessions().find(s => s.id === id);
        persistSession(id, { ...sess, tree: root, manualTitle: (item && item.manualTitle) || null });
        renderSessions();
        showToast('已清空', 'success');
    }

    /** 置顶切换：写存档 + 重建索引 + 重渲染；排序即时反映 @param {string} id */
    function togglePin(id) {
        const item = listSessions().find(s => s.id === id);
        const next = !(item && item.pinned);
        setSessionPinned(id, next);
        renderSessions();
        showToast(next ? '已置顶' : '已取消置顶', 'success');
    }

    /**
     * 关闭「提示词预览气泡」（点 SP pill 之外 / 切会话 / 重渲染前调用）。 @returns {void}
     */
    function closeSpBubble() {
        if (spBubbleEl) { spBubbleEl.remove(); spBubbleEl = null; }
    }

    /**
     * 点会话行 SP pill：弹出气泡预览该会话提示词前几行（只读——编辑已移交顶部提示词 bar）。
     * 无会话级覆盖时显示「全局默认」并预览全局 sysPrompt。气泡锚定 pill 下方、点外即收。
     * @param {string} id 会话 id @param {HTMLElement} anchor SP pill 元素
     */
    function showSpBubble(id, anchor) {
        closeSpBubble();
        const sess = loadSession(id);
        const hasSp = sess && sess.sysPrompt != null && sess.sysPrompt !== '';
        const full = hasSp ? sess.sysPrompt : state.settings.sysPrompt;
        const lines = (full || '').replace(/\r\n/g, '\n').split('\n').slice(0, 6).join('\n');
        const preview = lines.length > 220 ? lines.slice(0, 220) + '…' : lines;
        const bubble = document.createElement('div');
        bubble.className = 'mn-sp-pop';
        bubble.innerHTML =
            '<div class="mn-sp-pop-title">' + (hasSp ? '会话提示词' : '全局默认提示词') + '</div>' +
            '<pre class="mn-sp-pop-body">' + (escapeHtml(preview) || '（空）') + '</pre>';
        const rect = anchor.getBoundingClientRect();
        const maxW = 280;
        bubble.style.position = 'fixed';
        bubble.style.left = Math.min(rect.left, window.innerWidth - maxW - 12) + 'px';
        bubble.style.top = (rect.bottom + 8) + 'px';
        bubble.style.maxWidth = maxW + 'px';
        bubble.style.zIndex = '1000';
        document.body.appendChild(bubble);
        spBubbleEl = bubble;
        // 当前 click 已作用在 pill 上，延后一拍再挂关闭监听，避免立刻把自己关掉
        setTimeout(() => {
            const onDoc = (e) => {
                if (spBubbleEl && !spBubbleEl.contains(e.target)) {
                    closeSpBubble();
                    document.removeEventListener('click', onDoc);
                }
            };
            document.addEventListener('click', onDoc);
        }, 0);
    }

    // 遮罩点击关闭
    panel.addEventListener('click', (e) => { if (e.target === panel) closeAllModals(); });

    const closeBtn = panel.querySelector('#mn-close');
    const tabs = panel.querySelector('.mn-tabs');
    const sessionsList = panel.querySelector('#mn-sessions');
    const messagesPane = panel.querySelector('[data-pane="messages"]');
    const sessionsPane = panel.querySelector('[data-pane="sessions"]');
    const wordsPane = panel.querySelector('[data-pane="words"]');
    const wcInner = document.getElementById('wordcloud-panel-inner');  // 词云内容根节点：运行时移入 wordsPane
    const newBtn = panel.querySelector('#mn-new');
    const search = panel.querySelector('#mn-search');
    const sub = panel.querySelector('#mn-sub');
    const list = panel.querySelector('#mn-list');

    // 长按原生菜单拦截：移动端长按会弹系统选择/复制，必须掐掉，否则与操作菜单冲突
    panel.addEventListener('contextmenu', (e) => e.preventDefault());

    /** 转义 HTML @param {string} s @returns {string} */
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** 当前高频词集合（进消息 tab 时缓存，不随每次按键重算） @type {Set<string>} */
    let hotWordSet = new Set();
    /** 当前高频词数组（保留排序供 highlight 长词优先） @type {string[]} */
    let hotWords = [];

    /** 重命名中的 input 元素（非 null 表示正在重命名） @type {HTMLElement|null} */
    let renameInput = null;

    /**
     * 在纯文本上做「不重叠最长匹配」高亮：高频词→htw（下划线），查找词→hq（更强）。
     * 用区间切分 + 逐段 escape，杜绝正则嵌套破坏与 XSS。 @param {string} text @param {string} q 查找词 @returns {string}
     */
    function highlight(text, q) {
        const terms = hotWords.slice();
        if (q) for (const w of q.toLowerCase().split(/\s+/)) if (w && !hotWordSet.has(w)) terms.push(w);
        terms.sort((a, b) => b.length - a.length);
        const lower = text.toLowerCase();
        let html = '';
        let i = 0;
        while (i < text.length) {
            let m = null;
            for (const w of terms) { if (w && lower.startsWith(w, i)) { m = w; break; } }
            if (m) {
                html += hotWordSet.has(m)
                    ? `<mark class="htw">${escapeHtml(text.slice(i, i + m.length))}</mark>`
                    : `<mark class="hq">${escapeHtml(text.slice(i, i + m.length))}</mark>`;
                i += m.length;
            } else {
                html += escapeHtml(text[i]);
                i++;
            }
        }
        return html;
    }

    /** 渲染会话列表 @returns {void} */
    function renderSessions() {
        closeCtxMenu(); // 重建列表前确保菜单已收（重渲染不会动菜单 DOM，但状态须干净）
        closeSpBubble(); // 重渲染（切会话/列表变动）时同步收起提示词预览气泡（待办 Phase4）
        const sessions = listSessions();
        if (!sessions.length) {
            sessionsList.innerHTML = '<div class="mn-empty">还没有会话</div>';
            return;
        }
        sessionsList.innerHTML = sessions.map((s) => {
            const active = s.id === state.activeSessionId;
            const dots = s.streaming ? '<span class="typing-dots" aria-label="生成中"><span></span><span></span><span></span></span>' : '';
            // 置顶标记：行首小别针（仅置顶时显示），与排序「置顶优先」呼应
            const pin = s.pinned ? '<span class="mn-pin" aria-label="已置顶"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 7 3 3v2H7v-2l3-3-1-7Z"/><path d="M12 16v5"/></svg></span>' : '';
            // LLM 芯片：只有两个模型，显示当前生效模型（会话级覆盖优先，否则继承全局默认），无「全局」第三态。
            // data-provider 与渲染同源（'zhipu'|'deepseek'），切换时直接读，杜绝「索引旧值 vs 显示值」双源漂移
            const providerKey = effectiveProvider(s);
            const modelName = effectiveModel(s);
            const providerClass = ' provider-' + providerKey;
            // SP 预览：会话级覆盖去空白截 16 字；无覆盖 = 「默认」（继承全局）。accent = 有会话级覆盖
            const hasSp = s.sysPrompt != null && s.sysPrompt !== '';
            const spText = hasSp ? s.sysPrompt.replace(/\s+/g, ' ').trim().slice(0, 16) + '…' : '默认';
            // 行2 右侧的 SP 入口：清晰可点的小 pill（展开行内编辑器），accent 表「有独立提示词」
            const metaRight = `<button type="button" class="mn-sp${hasSp ? ' has-sp' : ''}" data-id="${escapeHtml(s.id)}"><i class="mn-sp-tag">SP</i><span class="mn-sp-text">${escapeHtml(spText)}</span></button>`;
            return `<div class="mn-session${active ? ' active' : ''}" data-id="${escapeHtml(s.id)}">
                <div class="mn-row-top">
                    ${pin}
                    <span class="mn-session-title">${escapeHtml(s.title)}</span>
                    ${dots}
                    <span class="mn-llm-chip${providerClass}" data-id="${escapeHtml(s.id)}">${escapeHtml(modelName)}</span>
                </div>
                <div class="mn-row-meta">
                    <span class="mn-time">${relTime(s.updatedAt)}</span>
                    <span class="mn-sep">·</span>
                    <span class="mn-count">${s.msgCount} 条</span>
                    ${metaRight}
                </div>
            </div>`;
        }).join('');

        // 行级交互：长按手势（整行）+ 点击名字切换（标题）。
        // 长按根因修复（真机 Via 实测「很难弹出」）：移动端长按时浏览器会接管手势并派发 pointercancel，
        //   旧版在 pointercancel 上 clearTimeout 把计时器杀掉 → 菜单永远开不了。现改为——
        //   ① 主触发用原生 contextmenu 事件（移动端长按 / 桌面右键都会派发，最可靠），preventDefault 掐掉系统菜单；
        //   ② pointer 计时器仅作兜底（contextmenu 未触发时 600ms 打开）；
        //   ③ pointercancel 按位移分流：已滑 >10px = 滚动场景 → 取消计时器；未动 = 长按被浏览器接管 → 保留；
        //   ④ 慢滑误触修复（用户 2026-08-21 反馈）：长按的语义是「按住不动」——任何 pointermove 都重置 600ms 计时，
        //      慢速滑动时计时器被持续重置，滑多久都不会弹菜单；停止移动 600ms 才触发。位移 >10px 则直接取消（真滚动）。
        //   ⑤ 两种触发通道都把 longFired 置位，随后派发的 click 被吞掉，避免「长按后误触发进入」。
        sessionsList.querySelectorAll('.mn-session').forEach((row) => {
            const id = row.dataset.id;
            const titleEl = row.querySelector('.mn-session-title');
            let pressTimer = 0, longFired = false, startX = 0, startY = 0, lastX = 0, lastY = 0;
            row.addEventListener('pointerdown', (e) => {
                if (e.button && e.button !== 0) return; // 右键交给原生 contextmenu
                if (ctxMenuOpen) return;
                // SP 预览气泡 / 输入框内按下：不触发整行长按菜单
                if (e.target.closest('input, textarea, [contenteditable], .mn-sp-pop')) return;
                startX = lastX = e.clientX; startY = lastY = e.clientY;
                longFired = false; // 每次按下重置：即便上次长按后 click 未派发也不会卡在 true
                clearTimeout(pressTimer);
                pressTimer = setTimeout(() => { longFired = true; openCtxMenu(id, row); }, LONG_PRESS_MS);
            });
            const onMove = (e) => {
                lastX = e.clientX; lastY = e.clientY; // 记录最新触点，pointercancel 分流用
                if (!pressTimer) return;
                if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) {
                    clearTimeout(pressTimer); pressTimer = 0; // 真滚动/拖拽 → 不是长按，取消
                } else {
                    // 微小移动：重置计时（长按=按住不动；慢滑时持续重置，杜绝 600ms 慢滑误触菜单）
                    clearTimeout(pressTimer);
                    pressTimer = setTimeout(() => { longFired = true; openCtxMenu(id, row); }, LONG_PRESS_MS);
                }
            };
            // 浏览器接管手势（滚动或长按都会派发 pointercancel）：按累计位移分流——滑动中=取消，静止长按=保留
            row.addEventListener('pointercancel', () => {
                if (pressTimer && (Math.abs(lastX - startX) > 10 || Math.abs(lastY - startY) > 10)) {
                    clearTimeout(pressTimer); pressTimer = 0;
                }
            });
            const endPress = () => { clearTimeout(pressTimer); pressTimer = 0; }; // 松手早于 600ms = 轻点，不触发菜单
            row.addEventListener('pointermove', onMove);
            row.addEventListener('pointerup', endPress);
            // 原生长按/右键：直接开菜单（移动端最可靠的触发通道）。preventDefault 掐掉系统选择/复制菜单
            row.addEventListener('contextmenu', (e) => {
                // 编辑区 / 输入框内：放行系统菜单（不拦、不弹自定义菜单）
                if (e.target.closest('input, textarea, [contenteditable], .mn-sp-pop')) return;
                e.preventDefault();
                if (ctxMenuOpen) return;
                longFired = true;
                openCtxMenu(id, row);
            });
            // 标题轻点 = 切换会话；longFired 已置位（长按/右键）则吞掉随后派发的 click，避免误进入
            titleEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (longFired) { longFired = false; return; }
                switchTo(id);
            });
        });

        // LLM 芯片：待办 Phase4 改为只读显示（模型切换已移交设置页），不再绑定交互；
        // 保留 .mn-llm-chip 视觉（含 provider-* 配色），仅作信息呈现。

        // SP pill：click 弹出「提示词预览气泡」（只读前几行；编辑已移交顶部提示词 bar）。
        // pointerdown / contextmenu 拦截，防长按误触整行菜单
        sessionsList.querySelectorAll('.mn-sp').forEach((btn) => {
            btn.addEventListener('pointerdown', (e) => e.stopPropagation());
            btn.addEventListener('contextmenu', (e) => e.stopPropagation());
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                showSpBubble(btn.dataset.id, btn);
            });
        });
    }



    /**
     * 开始重命名：把标题替换为 input，聚焦并全选。
     * 仅由长按菜单触发，杜绝「点当前行即重命名」的误触路径。 @param {HTMLElement} row 会话行 @param {string} id
     */
    function startRename(row, id) {
        if (renameInput) return;
        const titleEl = row.querySelector('.mn-session-title');
        if (!titleEl) return;
        const input = document.createElement('input');
        input.className = 'mn-rename';
        input.value = titleEl.textContent;
        renameInput = input;
        titleEl.replaceWith(input);
        input.focus();
        input.select();
        // Escape 必须拦下：否则被 global.js 抢走关掉整个面板（重命名未完成）
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                cancelRename(input);
            } else if (e.key === 'Enter') {
                e.stopPropagation();
                commitRename(id, input.value);
            }
        });
        // blur 触发提交：但 Enter/Escape 已先 commit/cancel 并重渲染（input 被移除），
        // 随后浏览器补发的 blur 不得再提交一次。isConnected 检查必须延后到渲染完成之后
        // （同步期内 DOM 尚未真正移除旧节点，检查会误判为「仍连接」→ 递归重渲染报错）。
        input.addEventListener('blur', () => {
            setTimeout(() => {
                if (!input.isConnected) return; // 已被重渲染移除 → 已处理过，跳过
                commitRename(id, input.value);
            }, 0);
        });
    }

    /** 取消重命名：丢弃输入，恢复标题 @param {HTMLElement} input */
    function cancelRename(input) {
        if (renameInput !== input) return;
        renameInput = null;
        renderSessions(); // 重渲染恢复原标题（未提交）
    }

    /** 提交重命名 @param {string} id @param {string} value */
    function commitRename(id, value) {
        if (renameInput) { renameInput = null; }
        renameSession(id, value);
        renderSessions();
    }

    /** 渲染消息列表（仅在消息 tab 激活时计算分词） @param {string} q 查找词 */
    function renderMessages(q) {
        const ql = (q || '').trim().toLowerCase();
        const path = getCurrentPath(state.chatTree) || [];
        const msgs = path.filter((n) => n.role !== 'system');

        sub.textContent = `共 ${msgs.length} 条 · 高频词已融入预览（下划线）`;
        const filtered = ql ? msgs.filter((n) => (n.content || '').toLowerCase().includes(ql)) : msgs;
        if (!filtered.length) {
            list.innerHTML = '<div class="mn-empty">无匹配消息</div>';
            return;
        }
        list.innerHTML = filtered.map((node, i) => {
            const role = node.role === 'user' ? 'user' : 'assistant';
            const dot = ROLE_DOT[role] || '#868e96';
            let prev = (node.content || '').replace(/\s+/g, ' ').trim();
            if (prev.length > PREVIEW_CH) prev = prev.slice(0, PREVIEW_CH) + '…';
            const hl = highlight(prev, ql);
            return `<div class="mn-row" data-id="${escapeHtml(node.id)}">
                <span class="mn-dot" style="background:${dot}"></span>
                <span class="mn-num">${String(i + 1).padStart(2, '0')}</span>
                <span class="mn-text">${hl}</span>
            </div>`;
        }).join('');
        list.querySelectorAll('.mn-row').forEach((row) => {
            // 待办 Phase3：点击消息跳转后关闭 sheet（消息导航点消息能收起面板）
            row.addEventListener('click', () => { jumpTo(row.dataset.id, row); closeAllModals(); });
        });
    }

    /** 跳转到目标消息并闪烁 @param {string} id @param {HTMLElement} row */
    function jumpTo(id, row) {
        const escapedId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id;
        const el = DOM.chat.querySelector(`[data-id="${escapedId}"]`);
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.remove('nav-flash'); void el.offsetWidth; el.classList.add('nav-flash');
        }
        list.querySelectorAll('.mn-row').forEach((r) => r.classList.remove('active'));
        if (row) row.classList.add('active');
    }

    /** 切换 tab @param {'sessions'|'messages'|'words'} t */
    function setTab(t) {
        writeTab(t);
        tabs.querySelectorAll('.segmented__item').forEach((b) => {
            b.classList.toggle('segmented__item--active', b.dataset.tab === t);
        });
        sessionsPane.hidden = t !== 'sessions';
        messagesPane.hidden = t !== 'messages';
        wordsPane.hidden = t !== 'words';
        if (t === 'words') {
            mountWordCloud();  // 词云内嵌当前 sheet，不再另开面板
            return;
        }
        if (t === 'sessions') {
            closeCtxMenu();
            renderSessions();
        } else {
            // 进消息 tab 才计算分词（默认进会话 tab 秒开）
            const path = getCurrentPath(state.chatTree) || [];
            hotWords = analyzeWordFreq(path, { topN: HOT_N, segment: getActiveSegmenter() }).map((f) => f.word);
            hotWordSet = new Set(hotWords);
            search.value = '';
            renderMessages('');
        }
    }

    /** 把词云内容节点移入「词频」pane（当前 sheet 内），再触发渲染。节点移动而非克隆，监听器随节点保留。 */
    function mountWordCloud() {
        closeCtxMenu();
        if (wcInner && wcInner.parentElement !== wordsPane) wordsPane.appendChild(wcInner);
        openWordCloud();  // 仅渲染，不再 openModal
    }

    tabs.addEventListener('click', (e) => {
        const b = e.target.closest('.segmented__item');
        if (!b) return;
        setTab(b.dataset.tab);
    });

    newBtn.addEventListener('click', () => createNew());

    closeBtn.addEventListener('click', () => { closeAllModals(); });
    search.addEventListener('input', () => renderMessages(search.value));

    btn.addEventListener('click', () => {
        // 走统一模态体系：开时互斥关其它面板，并锁背景滚动
        if (getComputedStyle(panel).display !== 'none') {
            closeAllModals();
        } else {
            openModal('msg-nav');
            setTab(readTab());
        }
    });
}
