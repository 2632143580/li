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
    const btn = DOM.btnMsgNav;
    if (!btn) return;
    btn.style.cursor = 'pointer';

    const panel = document.createElement('div');
    panel.id = 'msg-nav';
    panel.style.cssText = [
        'position:fixed', 'left:12px', 'bottom:64px',
        'width:min(92vw,340px)', 'max-height:66vh', 'display:none',
        'flex-direction:column', 'background:var(--bg-modal)',
        'border:1px solid var(--white-a12)', 'border-radius:12px',
        'box-shadow:0 8px 28px var(--black-a40)', 'z-index:60',
        'font:12.5px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        'color:var(--white-a85)', 'overflow:hidden',
        'animation:msgNavIn .16s ease-out'
    ].join(';') + ';';

    panel.innerHTML = `
        <style>
            /* 面板表面恒为深色(--bg-modal 不随主题翻转)，故文本 token 强制白值，免疫浅色主题把 --white-a* 翻黑导致「黑字黑底」不可读 */
            #msg-nav { --white-a06:rgba(255,255,255,.06); --white-a08:rgba(255,255,255,.08); --white-a10:rgba(255,255,255,.1); --white-a12:rgba(255,255,255,.12); --white-a15:rgba(255,255,255,.15); --white-a20:rgba(255,255,255,.2); --white-a35:rgba(255,255,255,.35); --white-a40:rgba(255,255,255,.4); --white-a45:rgba(255,255,255,.45); --white-a50:rgba(255,255,255,.5); --white-a60:rgba(255,255,255,.6); --white-a70:rgba(255,255,255,.7); --white-a75:rgba(255,255,255,.75); --white-a80:rgba(255,255,255,.8); --white-a85:rgba(255,255,255,.85); --white-a90:rgba(255,255,255,.9); --white-a95:rgba(255,255,255,.95); }
            @keyframes msgNavIn { from { opacity:0; transform:translateY(6px);} to {opacity:1; transform:none;} }
            #msg-nav .mn-head { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--white-a10); }
            #msg-nav .mn-title { font-weight:600; flex:1; color:var(--white-a90); letter-spacing:.02em; }
            #msg-nav .mn-close { padding:3px 9px; border:1px solid var(--white-a15); background:var(--white-a06); color:var(--white-a80); border-radius:6px; cursor:pointer; font:inherit; }
            #msg-nav .mn-close:hover { color:var(--white-a95); }
            #msg-nav .mn-search { margin:8px 12px 4px; padding:7px 10px; border:1px solid var(--white-a15); background:var(--white-a06); color:var(--white-a90); border-radius:8px; font:inherit; outline:none; box-sizing:border-box; width:calc(100% - 24px); }
            #msg-nav .mn-search:focus { border-color:var(--color-accent); }
            #msg-nav .mn-search::placeholder { color:var(--white-a40); }
            #msg-nav .mn-sub { padding:2px 12px 6px; color:var(--white-a45); font-size:11px; }
            #msg-nav .mn-list { overflow:auto; flex:1; padding:2px 0 6px; }
            #msg-nav .mn-row { display:grid; grid-template-columns:8px 26px 1fr; gap:8px; align-items:start; padding:7px 12px; cursor:pointer; border-left:2px solid transparent; }
            #msg-nav .mn-row:hover { background:var(--white-a06); }
            #msg-nav .mn-row.active { background:color-mix(in srgb, var(--color-accent) 10%, transparent); border-left-color:var(--color-accent); }
            #msg-nav .mn-dot { width:7px; height:7px; border-radius:50%; margin-top:5px; flex:none; }
            #msg-nav .mn-num { color:var(--white-a35); font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; text-align:right; }
            #msg-nav .mn-text { color:var(--white-a80); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word; }
            #msg-nav .htw { color:var(--color-accent); background:color-mix(in srgb, var(--color-accent) 12%, transparent); text-decoration:underline; text-decoration-color:var(--color-accent); text-underline-offset:2px; text-decoration-thickness:1.5px; border-radius:2px; }
            #msg-nav .hq { color:var(--color-accent); background:color-mix(in srgb, var(--color-accent) 26%, transparent); font-weight:600; border-radius:2px; }
            #msg-nav .mn-empty { padding:20px 12px; color:var(--white-a45); text-align:center; }
        </style>
        <div class="mn-head">
            <span class="mn-title">消息导航</span>
            <button class="mn-close" id="mn-close" aria-label="关闭">✕</button>
        </div>
        <input class="mn-search" id="mn-search" type="text" placeholder="查找消息…" autocomplete="off" />
        <div class="mn-sub" id="mn-sub"></div>
        <div class="mn-list" id="mn-list"></div>
    `;
    document.body.appendChild(panel);

    const closeBtn = panel.querySelector('#mn-close');
    const search = panel.querySelector('#mn-search');
    const sub = panel.querySelector('#mn-sub');
    const list = panel.querySelector('#mn-list');

    // 注入目标消息「闪一下」动画（仅一次）
    if (!document.getElementById('msg-nav-flash')) {
        const st = document.createElement('style');
        st.id = 'msg-nav-flash';
        st.textContent = '@keyframes navFlash{0%{box-shadow:0 0 0 2px var(--color-accent)}100%{box-shadow:0 0 0 2px transparent}} .nav-flash{animation:navFlash 1.1s ease-out;}';
        document.head.appendChild(st);
    }

    /** 转义 HTML @param {string} s @returns {string} */
    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** 当前高频词（render 时刷新） @type {string[]} */
    let hotWords = [];

    /**
     * 在纯文本上做「不重叠最长匹配」高亮：高频词→htw（下划线），查找词→hq（更强）。
     * 用区间切分 + 逐段 escape，杜绝正则嵌套破坏与 XSS。 @param {string} text @param {string} q 查找词 @returns {string}
     */
    function highlight(text, q) {
        const terms = hotWords.slice();
        if (q) for (const w of q.toLowerCase().split(/\s+/)) if (w && !hotWords.includes(w)) terms.push(w);
        terms.sort((a, b) => b.length - a.length); // 长词优先，首个命中即最长
        const lower = text.toLowerCase();
        let html = '';
        let i = 0;
        while (i < text.length) {
            let m = null;
            for (const w of terms) { if (w && lower.startsWith(w, i)) { m = w; break; } }
            if (m) {
                html += hotWords.includes(m)
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
        hotWords = analyzeWordFreq(path, { topN: HOT_N, segment: getActiveSegmenter() }).map((f) => f.word); // 跟随词云分词模式（轻量 / 专业 jieba）+ 默认 includeRoles

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
            return `<div class="mn-row" data-id="${node.id}">
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
        const el = DOM.chat.querySelector(`[data-id="${id}"]`);
        if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.remove('nav-flash'); void el.offsetWidth; el.classList.add('nav-flash');
        }
        list.querySelectorAll('.mn-row').forEach((r) => r.classList.remove('active'));
        if (row) row.classList.add('active');
    }

    btn.addEventListener('click', () => {
        // 走统一模态体系：开时互斥关其它面板（修「日志+导航一起开」），并锁背景滚动
        if (getComputedStyle(panel).display !== 'none') closeAllModals();
        else { openModal('msg-nav'); search.value = ''; render(''); }
    });
    closeBtn.addEventListener('click', () => { closeAllModals(); });
    search.addEventListener('input', () => render(search.value));
}

