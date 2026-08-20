/**
 * 消息导航面板（双 tab：会话 / 消息）。
 *
 * 设计原则：复用优先、零重造、无气泡、纯正向。
 *   - 会话 tab：新建会话入口 + 会话列表（标题 / 消息数 / 相对时间 / 后台生成指示 / 当前会话竖线 / 重命名 / 长按删除）。
 *   - 消息 tab：原极简消息列表 + 高频词下划线（与词云融化），分词延迟到进此 tab 才计算，默认进会话 tab 秒开。
 *
 * 交互细节（每条都有理由，见规划文档）：
 *   - 当前会话：左侧 2px accent 竖线（位置语义，比色块轻）；消息 tab 的 .mn-row.active 是「刚跳转」临时高亮，语义不同。
 *   - 相对时间：开面板算一次，不设定时器（与「按需渲染、零持续动画」一致）。
 *   - 后台生成：复用 .typing-dots（prefers-reduced-motion 自动降级），是「后台继续生成」的反馈闭环。
 *   - 点当前会话 = 重命名；点其它 = 切换（零新增控件，语义同桌面重命名文件）。
 *   - 长按 600ms → armed（右侧显示「删除?」），3 秒内再点确认；移动端无右键，长按是唯一通道。
 *   - tab 复用 .segmented；记住上次 tab。
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

registerUI('msg-nav', setupMsgNav);

/** 记住上次 tab 的小键（独立 localStorage，同 topbar 折叠态做法） @type {string} */
const TAB_KEY = 'liNavTab';
/** 融预览的高频词数量上限 @type {number} */
const HOT_N = 14;
/** 预览截取字符数 @type {number} */
const PREVIEW_CH = 120;
/** 长按进入删除 armed 态的时长（ms），对标词云长按 @type {number} */
const LONG_PRESS_MS = 600;
/** armed 态有效窗口（ms）：超时自动解除 @type {number} */
const ARMED_TTL = 3000;
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
        </div>
    `;
    document.body.appendChild(panel);

    // 遮罩点击关闭
    panel.addEventListener('click', (e) => { if (e.target === panel) closeAllModals(); });

    const closeBtn = panel.querySelector('#mn-close');
    const tabs = panel.querySelector('.mn-tabs');
    const sessionsList = panel.querySelector('#mn-sessions');
    const messagesPane = panel.querySelector('[data-pane="messages"]');
    const sessionsPane = panel.querySelector('[data-pane="sessions"]');
    const newBtn = panel.querySelector('#mn-new');
    const search = panel.querySelector('#mn-search');
    const sub = panel.querySelector('#mn-sub');
    const list = panel.querySelector('#mn-list');

    /** 转义 HTML @param {string} s @returns {string} */
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** 当前高频词集合（进消息 tab 时缓存，不随每次按键重算） @type {Set<string>} */
    let hotWordSet = new Set();
    /** 当前高频词数组（保留排序供 highlight 长词优先） @type {string[]} */
    let hotWords = [];

    /** 长按删除 armed 态：当前 armed 的会话 id（null = 无） @type {string|null} */
    let armedId = null;
    /** armed 态超时句柄 @type {number|null} */
    let armedTimer = null;
    /** 重命名中的 input 元素（非 null 表示正在重命名） @type {HTMLElement|null} */
    let renameInput = null;

    /** 取消 armed 态 @returns {void} */
    function disarm() {
        if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
        if (armedId) { armedId = null; renderSessions(); }
    }

    /** 进入 armed 态 @param {string} id */
    function arm(id) {
        armedId = id;
        renderSessions();
        if (armedTimer) clearTimeout(armedTimer);
        armedTimer = setTimeout(disarm, ARMED_TTL); // 3 秒窗口，超时自动解除
    }

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
        const sessions = listSessions();
        if (!sessions.length) {
            sessionsList.innerHTML = '<div class="mn-empty">还没有会话</div>';
            return;
        }
        sessionsList.innerHTML = sessions.map((s) => {
            const active = s.id === state.activeSessionId;
            const armed = armedId === s.id;
            const dots = s.streaming ? '<span class="typing-dots" aria-label="生成中"><span></span><span></span><span></span></span>' : '';
            const confirm = armed
                ? '<span class="mn-del-confirm">删除?</span>'
                : `<span class="mn-count">${s.msgCount}</span>`;
            return `<div class="mn-session${active ? ' active' : ''}${armed ? ' armed' : ''}" data-id="${escapeHtml(s.id)}">
                <div class="mn-session-main">
                    <span class="mn-session-title">${escapeHtml(s.title)}</span>
                    ${dots}
                </div>
                <div class="mn-session-meta">
                    <span class="mn-time">${relTime(s.updatedAt)}</span>
                    ${confirm}
                </div>
            </div>`;
        }).join('');

        sessionsList.querySelectorAll('.mn-session').forEach((row) => {
            const id = row.dataset.id;
            // 长按 armed（指针事件统一鼠标/触控）
            let pressTimer = 0;
            let longPressed = false;
            row.addEventListener('pointerdown', (e) => {
                if (e.button !== undefined && e.button !== 0) return;
                longPressed = false;
                clearTimeout(pressTimer);
                pressTimer = setTimeout(() => { longPressed = true; arm(id); }, LONG_PRESS_MS);
            });
            const cancelPress = () => clearTimeout(pressTimer);
            row.addEventListener('pointerup', cancelPress);
            row.addEventListener('pointermove', cancelPress);
            row.addEventListener('pointercancel', cancelPress);
            row.addEventListener('pointerleave', cancelPress);
            row.addEventListener('click', () => {
                if (longPressed) { longPressed = false; return; } // 长按松手那一下不触发点击动作
                if (armedId === id) { removeSession(id); disarm(); return; } // 确认删除：先删（索引更新）再解除 armed 并重渲染列表，避免残留旧行
                if (armedId) { disarm(); return; } // 点别的行解除 armed
                if (id === state.activeSessionId) startRename(row, id); // 点当前 = 重命名
                else switchTo(id); // 点其它 = 切换
            });
        });
    }

    /**
     * 开始重命名：把标题替换为 input，聚焦并全选。
     * @param {HTMLElement} row 会话行 @param {string} id
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
            row.addEventListener('click', () => jumpTo(row.dataset.id, row));
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

    /** 切换 tab @param {'sessions'|'messages'} t */
    function setTab(t) {
        writeTab(t);
        tabs.querySelectorAll('.segmented__item').forEach((b) => {
            b.classList.toggle('segmented__item--active', b.dataset.tab === t);
        });
        sessionsPane.hidden = t !== 'sessions';
        messagesPane.hidden = t !== 'messages';
        if (t === 'sessions') {
            disarm();
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

    tabs.addEventListener('click', (e) => {
        const b = e.target.closest('.segmented__item');
        if (b) setTab(b.dataset.tab);
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
