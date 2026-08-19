/**
 * 消息导航面板（2026-08-19）：极简消息列表 + 与词云「融化」——高频词在预览里下划线强调。
 *
 * 设计原则：复用优先、零重造、无气泡、纯正向。
 *   - 消息序列：getCurrentPath(state.chatTree)（已有；去掉 system 根，与词云 includeRoles 一致）
 *   - 高频词：analyzeWordFreq(path, { topN, segment: getActiveSegmenter() }) —— 跟随词云当前分词器（轻量 / 专业 jieba），
 *             零依赖、不触发 jieba-wasm CDN、无网络、无隐私损失
 *   - 定位跳转：DOM.chat.querySelector('[data-id]') + scrollIntoView（消息 wrapper 已带 data-id）
 *   - UI 模式：顶栏 icon-btn + registerUI 面板（仿 log-panel 骨架）
 *
 * 与词云的「融化」：同一分词源 + 同一频率结果；角色色点沿用词云固定色相（user 暖橙 / ai 冷蓝），
 *   高频词以 accent 色下划线浮现在消息预览中，词云看"哪些词热"、导航里"热词直接在消息浮现"。
 *
 * 样式外提：所有 CSS 已移入 modal.css（#msg-nav 前缀），本模块不含内联 <style>。
 * Escape 关闭由 global.js 统一处理，本模块不注册 Escape 监听。
 *
 * 依赖：core/dom、core/store、chat/tree、core/wordcloud-analyzer、core/registry、core/modal
 */
import { DOM } from '../../core/dom.js';
import { state } from '../../core/store.js';
import { getCurrentPath } from '../../chat/tree.js';
import { analyzeWordFreq, getActiveSegmenter } from '../../core/wordcloud-analyzer.js';
import { registerUI } from '../../core/registry.js';
import { openModal, closeAllModals } from '../../core/modal.js';

registerUI('msg-nav', setupMsgNav);

/** 融入预览的高频词数量上限 @type {number} */
const HOT_N = 14;
/** 预览截取字符数（超出截断，配合 CSS 2 行 clamp 双重保险） @type {number} */
const PREVIEW_CH = 120;
/** 角色色点：与词云分色体系一致（user 暖橙 / ai 冷蓝），形成视觉联动 @type {Object<string,string>} */
const ROLE_DOT = { user: '#ff9f43', assistant: '#4dabf7' };

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
                <span class="mn-title">消息导航</span>
                <button class="mn-close" id="mn-close" aria-label="关闭">✕</button>
            </div>
            <input class="mn-search" id="mn-search" type="text" placeholder="查找消息…" autocomplete="off" />
            <div class="mn-sub" id="mn-sub"></div>
            <div class="mn-list" id="mn-list"></div>
        </div>
    `;
    document.body.appendChild(panel);

    // 遮罩点击关闭（与设置/词云/语音一致，统一 modal 行为）
    panel.addEventListener('click', (e) => { if (e.target === panel) closeAllModals(); });
    // Escape 关闭由 global.js 统一处理，不再注册面板级 Escape 监听

    const closeBtn = panel.querySelector('#mn-close');
    const search = panel.querySelector('#mn-search');
    const sub = panel.querySelector('#mn-sub');
    const list = panel.querySelector('#mn-list');

    /** 转义 HTML @param {string} s @returns {string} */
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** 当前高频词集合（开面板时缓存，不随每次按键重算） @type {Set<string>} */
    let hotWordSet = new Set();
    /** 当前高频词数组（保留排序供 highlight 长词优先） @type {string[]} */
    let hotWords = [];

    /**
     * 在纯文本上做「不重叠最长匹配」高亮：高频词→htw（下划线），查找词→hq（更强）。
     * 用区间切分 + 逐段 escape，杜绝正则嵌套破坏与 XSS。 @param {string} text @param {string} q 查找词 @returns {string}
     */
    function highlight(text, q) {
        const terms = hotWords.slice();
        if (q) for (const w of q.toLowerCase().split(/\s+/)) if (w && !hotWordSet.has(w)) terms.push(w);
        terms.sort((a, b) => b.length - a.length); // 长词优先，首个命中即最长
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

    /** 渲染列表 @param {string} q 查找词 */
    function render(q) {
        const ql = (q || '').trim().toLowerCase();
        const path = getCurrentPath(state.chatTree) || [];
        const msgs = path.filter((n) => n.role !== 'system'); // 去掉 system 根（与词云 includeRoles 默认一致）

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

    btn.addEventListener('click', () => {
        // 走统一模态体系：开时互斥关其它面板（修「日志+导航一起开」），并锁背景滚动
        if (getComputedStyle(panel).display !== 'none') {
            closeAllModals();
        } else {
            openModal('msg-nav');
            // 开面板时缓存高频词（不随每次按键重算——分词耗时随消息量增长）
            const path = getCurrentPath(state.chatTree) || [];
            hotWords = analyzeWordFreq(path, { topN: HOT_N, segment: getActiveSegmenter() }).map((f) => f.word);
            hotWordSet = new Set(hotWords);
            search.value = '';
            render('');
        }
    });
    closeBtn.addEventListener('click', () => { closeAllModals(); });
    search.addEventListener('input', () => render(search.value));
}
