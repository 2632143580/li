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
import { getProviderByUrl } from '../../core/utils.js';
import { loadSession, persistSession, saveSession } from '../../core/storage.js';
import { showToast } from '../../core/toast.js';
import { getEffectiveSysPrompt } from '../../core/sessions.js';

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

/**
 * 快速切换可用的服务商常量：端点与默认模型。
 * url 与 index.html 的 provider-tab data-url 保持一致（避免两端漂移）；
 * model 为各自官方默认模型（切换后若不换 model，服务商会因模型名不匹配拒绝请求）。
 * @type {Object<string,{name:string,url:string,model:string}>}
 */
const LLM_PROVIDERS = {
    zhipu: { name: '智谱', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-air' },
    deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' }
};

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

    /** 当前展开 SP 编辑器的会话 id（null = 全部收起）。展开态唯一事实源，重渲染据此恢复 @type {string|null} */
    let spEditId = null;

    /**
     * 展开/收起某行的 SP 编辑器（点 SP 预览触发）。
     * 经 renderSessions 统一重渲染保证「同时至多一行展开」，杜绝多行同开的漂移态。 @param {string} id
     */
    function toggleSpEditor(id) {
        spEditId = (spEditId === id) ? null : id; // 再点同一行 = 收起
        renderSessions();
    }

    /** 收起 SP 编辑器（取消 / Esc / 保存完成后调用） */
    function collapseSpEditor() {
        spEditId = null;
        renderSessions();
    }

    /**
     * 为已展开的行内编辑器填初值并绑定事件（renderSessions 重建 DOM 后调用）。
     * 预填：会话级覆盖优先，无覆盖以全局默认作编辑起点（留空保存 = 恢复继承全局）。 @param {HTMLElement} ed 编辑器根节点
     */
    function fillSpEditor(ed) {
        const id = ed.dataset.id;
        const sess = loadSession(id);
        if (!sess) { spEditId = null; return; }
        const ta = ed.querySelector('.mn-sp-input');
        const hasOverride = sess.sysPrompt != null && sess.sysPrompt !== '';
        ta.value = hasOverride ? sess.sysPrompt : state.settings.sysPrompt;
        // 状态标签即时反映：accent 点+亮字 = 会话级覆盖，灰点 = 继承全局
        const stateEl = ed.querySelector('.mn-sp-state');
        stateEl.classList.toggle('on', hasOverride);
        ed.querySelector('.mn-sp-state-text').textContent = hasOverride ? '会话级' : '全局';
        // 键盘：Esc 只收编辑器（拦冒泡防 global.js 连面板一起关）；Ctrl/Cmd+Enter 保存（多行 textarea 裸 Enter 应换行）
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); collapseSpEditor(); }
            else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveSp(id, ta.value); }
        });
        ed.querySelector('.mn-sp-cancel').addEventListener('click', (e) => { e.stopPropagation(); collapseSpEditor(); });
        ed.querySelector('.mn-sp-save').addEventListener('click', (e) => { e.stopPropagation(); saveSp(id, ta.value); });
    }

    /**
     * 保存会话 SP：空 = 恢复继承全局；当前会话走运行时 + state 落盘，后台会话写存档并同步 pending 快照。
     * @param {string} id 会话 id @param {string} rawVal textarea 原始值
     */
    function saveSp(id, rawVal) {
        const next = rawVal.trim() ? rawVal.trim() : null;
        if (id === state.activeSessionId) {
            // 当前会话：直接改运行时（含对话树根 content 同步），用 state 当前态落盘——避免防抖窗口内旧存档覆盖新树
            state.sessionSysPrompt = next;
            if (state.chatTree) state.chatTree.content = getEffectiveSysPrompt();
            saveSession(id);
        } else {
            // 后台会话：先同步 pending 快照（否则流式完成落盘会用旧 sysPrompt 覆盖新设置），再写存档
            const p = state.pending.get(id);
            if (p) {
                p.sysPrompt = next;
                saveSession(id, { tree: p.tree, stats: p.stats, sysPrompt: next, draft: p.draft || '', llmConfig: p.llmConfig || null });
            } else {
                const sess = loadSession(id);
                if (sess) { sess.sysPrompt = next; persistSession(id, sess); }
            }
        }
        spEditId = null;
        renderSessions();
        showToast(next ? '已保存会话提示词' : '已恢复全局默认', 'success');
    }

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
            spEditId = null; // 空列表无行可展开，清理展开态
            sessionsList.innerHTML = '<div class="mn-empty">还没有会话</div>';
            return;
        }
        sessionsList.innerHTML = sessions.map((s) => {
            const active = s.id === state.activeSessionId;
            const armed = armedId === s.id;
            const dots = s.streaming ? '<span class="typing-dots" aria-label="生成中"><span></span><span></span><span></span></span>' : '';
            // LLM 芯片：按会话配置解析服务商（无配置 = 继承全局 → 「全局」灰）。
            // data-provider 与渲染同源，切换时直接读，杜绝「索引旧值 vs 显示值」双源漂移
            const cfg = s.llmConfig || null;
            let providerKey = 'global';
            let providerName = '全局';
            let providerClass = '';
            if (cfg && cfg.apiUrl) {
                const p = getProviderByUrl(cfg.apiUrl);
                if (p === 'zhipu') { providerKey = 'zhipu'; providerName = '智谱'; providerClass = ' provider-zhipu'; }
                else if (p === 'deepseek') { providerKey = 'deepseek'; providerName = 'DeepSeek'; providerClass = ' provider-deepseek'; }
                else { providerKey = 'custom'; providerName = '自定义'; providerClass = ' provider-custom'; }
            }
            // SP 预览：会话级覆盖去空白截 14 字；无覆盖 = 全局。tag 配色区分（accent = 有覆盖 / 灰 = 继承）
            const hasSp = s.sysPrompt != null && s.sysPrompt !== '';
            const spText = hasSp ? s.sysPrompt.replace(/\s+/g, ' ').trim().slice(0, 14) + '…' : '全局';
            // meta 行右侧：armed 时显示删除确认，平时是 SP 预览按钮（点击行内展开编辑器）
            const metaRight = armed
                ? '<span class="mn-del-confirm">删除?</span>'
                : `<button type="button" class="mn-sp${hasSp ? ' has-sp' : ''}" data-id="${escapeHtml(s.id)}"><i class="mn-sp-tag">SP</i><span class="mn-sp-text">${escapeHtml(spText)}</span></button>`;
            return `<div class="mn-session${active ? ' active' : ''}${armed ? ' armed' : ''}" data-id="${escapeHtml(s.id)}">
                <div class="mn-row-top">
                    <span class="mn-session-title">${escapeHtml(s.title)}</span>
                    ${dots}
                    <button type="button" class="mn-llm-chip${providerClass}" data-id="${escapeHtml(s.id)}" data-provider="${providerKey}">${providerName}</button>
                </div>
                <div class="mn-row-meta">
                    <span class="mn-time">${relTime(s.updatedAt)}</span>
                    <span class="mn-sep">·</span>
                    <span class="mn-count">${s.msgCount}</span>
                    ${metaRight}
                </div>
                <div class="mn-sp-editor${spEditId === s.id ? ' open' : ''}" data-id="${escapeHtml(s.id)}">
                    <div class="mn-sp-editor-inner">
                        <div class="mn-sp-box">
                            <div class="mn-sp-head">
                                <span class="mn-sp-state"><i class="mn-sp-state-dot"></i><span class="mn-sp-state-text">全局</span></span>
                                <span class="mn-sp-hint">留空保存 = 恢复全局</span>
                            </div>
                            <textarea class="mn-sp-input" rows="4" spellcheck="false"></textarea>
                            <div class="mn-sp-actions">
                                <button type="button" class="mn-sp-cancel">取消</button>
                                <button type="button" class="mn-sp-save">保存</button>
                            </div>
                        </div>
                    </div>
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

        // LLM 芯片交互：click 触发快切；pointerdown 阻止冒泡——行长按删除(600ms)绑定在 row 上，
        // chip 上长按不得误触发删除 armed 态（chip 与 row 是嵌套关系，事件会冒泡到 row）
        sessionsList.querySelectorAll('.mn-llm-chip').forEach((chip) => {
            chip.addEventListener('pointerdown', (e) => e.stopPropagation());
            chip.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止触发 row 的 click（当前行重命名 / 其它行切换）
                handleQuickLlmSwitch(chip.dataset.id, chip.dataset.provider);
            });
        });

        // SP 预览按钮：click 行内展开编辑器；pointerdown 同样拦截，防长按误触删除 armed
        sessionsList.querySelectorAll('.mn-sp').forEach((btn) => {
            btn.addEventListener('pointerdown', (e) => e.stopPropagation());
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // 阻止触发 row 的 click（切换/重命名）
                toggleSpEditor(btn.dataset.id);
            });
        });

        // 已展开的行：重渲染后恢复初值与事件（展开态唯一事实源 spEditId；行已不在列表则清态）
        if (spEditId) {
            const ed = sessionsList.querySelector('.mn-sp-editor.open');
            if (ed) fillSpEditor(ed); else spEditId = null;
        }
    }

    /**
     * 快速切换会话 LLM（chip 点击）：全局 → 已配置服务商轮换 → 回全局 的循环。
     * key 复用全局 settings.keys 槽（不存会话，避免密钥明文随会话复制）；
     * 只写会话级配置（当前会话写 state + 落盘，后台会话写存档），永不触碰全局 settings。
     * 此前 bug：当前会话只写 state + touchIndex（touchIndex 仅改 updatedAt 不同步索引内容）→
     * chip 显示不变、轮换读索引旧值死循环在同一个目标。现经 saveSession 落盘并同步索引。
     * @param {string} id 会话 id @param {string} providerKey chip 当前的服务商标识（'global'|'zhipu'|'deepseek'|'custom'，与渲染同源）
     */
    function handleQuickLlmSwitch(id, providerKey) {
        // 已配置 key 的服务商（key 非空才算可用）；仅一个也能在 全局↔该服务商 间切换，全无才禁止
        const configured = Object.keys(LLM_PROVIDERS).filter(p => state.settings.keys[p]);
        if (!configured.length) {
            showToast('需在设置中配置 API Key 才能切换', 'warn');
            return;
        }
        // 循环序：null(继承全局) → 已配置服务商…；未识别的 custom 落回全局（点一下回到继承，不自定义轮换）
        const cycle = [null, ...configured];
        const cur = providerKey === 'global' ? null : providerKey;
        const next = cycle[(cycle.indexOf(cur) + 1 + cycle.length) % cycle.length];
        const nextCfg = next ? { apiUrl: LLM_PROVIDERS[next].url, model: LLM_PROVIDERS[next].model } : null;

        if (id === state.activeSessionId) {
            // 当前会话：写运行时（请求层立即生效）+ saveSession 落盘（内部 updateIndexFromRaw 同步索引 → chip 立即更新、刷新不丢）
            state.sessionLlmConfig = nextCfg;
            saveSession(id);
        } else {
            // 后台会话：同步 pending 快照（流式完成落盘用新配置）或静默写存档；persistSession 内部同步索引
            const p = state.pending.get(id);
            if (p) {
                p.llmConfig = nextCfg;
                saveSession(id, { tree: p.tree, stats: p.stats, sysPrompt: p.sysPrompt, draft: p.draft || '', llmConfig: nextCfg });
            } else {
                const sess = loadSession(id);
                if (sess) { sess.llmConfig = nextCfg; persistSession(id, sess); }
            }
        }
        renderSessions();
        showToast(nextCfg ? '已切换至 ' + LLM_PROVIDERS[next].name : '已恢复全局模型', 'success');
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
