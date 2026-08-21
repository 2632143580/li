/**
 * 语音条渲染（句句发语音）—— AI 回复按句渲染成可点击播放的语音条。
 *
 * 渲染位置：tree-render.renderContent 对「AI 非错误 + 语音回复开启」的节点调用本模块，
 *   流式生成中做增量追加（与 waifu 分句同体验），结束后全量重建。
 *
 * 交互（用户 2026-08-14 纠正）：
 *   - 点击语音条 = 播放该句；再次点击同一语音条 = 停止（全局互斥，同时只播一句）
 *   - 无独立播放按钮（点击条本身即播放/停止）
 *   - 无删除按钮
 *   - 右键语音条 = 弹出「转文字」菜单，点击后该行展开显示原文（再点收起为「隐藏文字」）
 *
 * 依赖：core/dom、core/store（settings.ttsEnabled）、core/text-split（断句）、
 *       engines/tts-engine（speakSentence / stopCurrent / cleanForSpeech）
 */
import { DOM } from '../core/dom.js';
import { state } from '../core/store.js';
import { splitSentences, splitWaifuSegments } from '../core/text-split.js';
import { cleanForSpeech, speakSentence, enqueueAutoSentence, clearAutoQueue } from '../engines/tts-engine.js';

/** 当前播放中的语音条 DOM（互斥：新条播放前先停旧条） @type {HTMLElement|null} */
let playingTile = null;
/** 当前打开的语音条右键菜单所关联的语音条 @type {HTMLElement|null} */
let ctxTile = null;

/**
 * 重置语音条运行时追踪（切换会话时调用）：清空 playingTile / ctxTile，
 * 防止旧会话的 detached 节点残留在全局追踪里、误判「仍在播放」导致新会话音频被吞。
 * 不调用 stopCurrent（停止由 clearAutoQueue 负责）。 @returns {void}
 */
export function resetTileTracking() {
    playingTile = null;
    ctxTile = null;
}

/**
 * 扁平化渲染项（语音模式与「都显示」共用）：
 *   text 段 → { type:'tile', text:清洗后, raw:原文, idx:tile 全局序号 }
 *   action 段（括号动作）→ { type:'action', text:括号内文字 }
 * action 与纯文字模式（renderWaifuContent）同款渲染为 .waifu-action 轻提示——
 * 含语音的消息同样展示（）内容（用户 2026-08-21 反馈），但不朗读、不生成语音条。
 * idx 用 tile 专属计数器（跳过 action）：跨流式帧前缀稳定，供播放回调 / 自动朗读精确匹配。
 * @param {string} content @returns {Array<{type:string,text:string,raw?:string,idx?:number}>}
 */
function buildVoiceItems(content) {
    const items = [];
    let tileIdx = 0;
    for (const seg of splitWaifuSegments(content)) {
        if (seg.type === 'action') {
            if (seg.text && seg.text.trim()) items.push({ type: 'action', text: seg.text });
        } else {
            for (const s of splitSentences(seg.text)) {
                const clean = cleanForSpeech(s);
                if (clean.trim()) items.push({ type: 'tile', text: clean, raw: s, idx: tileIdx++ });
            }
        }
    }
    return items;
}

/** 追加一个渲染项（tile → 语音条；action → 轻提示） @param {HTMLElement} contentEl @param {object} item @param {number} pos 位置序（错峰动画用） */
function addVoiceItem(contentEl, item, pos) {
    if (item.type === 'action') {
        const a = document.createElement('div');
        a.className = 'waifu-action';
        a.textContent = item.text; // textContent 防 XSS
        contentEl.appendChild(a);
        return;
    }
    addTile(contentEl, item.text, item.idx, pos);
}

/**
 * 渲染 / 增量更新语音条到 contentEl（「只显示语音」模式）。
 * @param {HTMLElement} contentEl 装载层（.bubble-content）
 * @param {object} node 消息节点
 * @param {boolean} isStreaming 是否流式生成中（流式时增量追加，结束后全量重建）
 * @returns {void}
 */
export function renderVoiceTiles(contentEl, node, isStreaming) {
    if (!node.content) { contentEl.textContent = ''; return; }
    const items = buildVoiceItems(node.content);
    if (!items.length) { contentEl.textContent = ''; return; }

    const existing = Array.from(contentEl.querySelectorAll(':scope > .vt, :scope > .waifu-action'));
    const typeOf = (el) => el.classList.contains('waifu-action') ? 'action' : 'tile';

    if (isStreaming) {
        if (existing.length > items.length) { rebuild(contentEl, items); }
        else {
            // 类型翻转（括号「未闭合→闭合」导致旧 text 段回缩为 action；理论前缀结构保证不发生，防御兜底）→ 全量重建
            const typeOk = existing.every((el, i) => items[i] && typeOf(el) === items[i].type);
            if (!typeOk) { rebuild(contentEl, items); }
            else {
                // 逐项回写（流式末句持续增长 / action 文本变化），再 append 新增项——append-only 会残留半句
                for (let i = 0; i < existing.length; i++) {
                    if (typeOf(existing[i]) === 'action') {
                        if (existing[i].textContent !== items[i].text) existing[i].textContent = items[i].text;
                    } else if (existing[i].dataset.text !== items[i].text) {
                        existing[i].dataset.text = items[i].text;
                        syncRevealedText(existing[i]);
                    }
                }
                for (let i = existing.length; i < items.length; i++) addVoiceItem(contentEl, items[i], i);
            }
        }
        maybeAutoRead(node, isStreaming, contentEl); // 语音条已入 DOM 后再入队（修①⑩：避免绑旧节点 / 新句延迟）
        return;
    }

    // 非流式：仅当结构（数量 / 类型 / 文本）变化才重建，保留用户已展开的「转文字」与播放态
    let mismatch = existing.length !== items.length;
    if (!mismatch) {
        for (let i = 0; i < existing.length; i++) {
            const el = existing[i];
            if (typeOf(el) !== items[i].type) { mismatch = true; break; }
            const txt = items[i].type === 'action' ? el.textContent : el.dataset.text;
            if (txt !== items[i].text) { mismatch = true; break; }
        }
    }
    if (mismatch) rebuild(contentEl, items);
    maybeAutoRead(node, isStreaming, contentEl); // 同上：重建后 DOM 已稳定再入队
}

/** 全量重建（结构变化 / 首次）：重建前记录正在播放的句，重建后把 is-playing 转移到新节点，
 *  不调用 stopCurrent（修①：避免流结束重建截断自动朗读音频 / 抹掉动画）。
 *  自动朗读跨重建应续播，手动停止由 clearAutoQueue 负责。 @param {HTMLElement} contentEl @param {Array<object>} items */
function rebuild(contentEl, items) {
    const playingIdx = (playingTile && contentEl.contains(playingTile)) ? playingTile.dataset.idx : null;
    if (playingTile && contentEl.contains(playingTile)) playingTile = null; // 仅清追踪，不停音频
    contentEl.innerHTML = '';
    items.forEach((it, i) => addVoiceItem(contentEl, it, i));
    if (playingIdx !== null) {
        // 按句序 idx 转移（非文本）：重复句也能精确续播到原句，不误定位到同文本第一句
        const live = Array.from(contentEl.querySelectorAll('.vt')).find(t => t.dataset.idx === playingIdx);
        if (live) { playingTile = live; live.classList.add('is-playing'); } // 续播句动画不丢
    }
}

/**
 * 渲染「都显示」：每条 AI 消息同时呈现语音条 + 文字（逐句「波形在上、文字在下」），
 * action 段同样渲染为 .waifu-action 轻提示（与纯文字 / 只显示语音模式同口径）。
 * 与 renderVoiceTiles 同构（增量/流式/全量重建）。
 * 复用 makeTileEl（allowReveal=false：文字已常显，无需右键转文字）。
 * @param {HTMLElement} contentEl @param {object} node @param {boolean} isStreaming
 */
export function renderBoth(contentEl, node, isStreaming) {
    if (!node.content) { contentEl.textContent = ''; return; }
    const items = buildVoiceItems(node.content);
    if (!items.length) { contentEl.textContent = ''; return; }

    const existing = Array.from(contentEl.querySelectorAll(':scope > .vt-both-row, :scope > .waifu-action'));
    const typeOf = (el) => el.classList.contains('waifu-action') ? 'action' : 'row';

    if (isStreaming) {
        if (existing.length > items.length) { rebuildBoth(contentEl, items); }
        else {
            const typeOk = existing.every((el, i) => items[i] && typeOf(el) === items[i].type);
            if (!typeOk) { rebuildBoth(contentEl, items); }
            else {
                for (let i = 0; i < existing.length; i++) {
                    const el = existing[i];
                    if (typeOf(el) === 'action') {
                        if (el.textContent !== items[i].text) el.textContent = items[i].text;
                        continue;
                    }
                    // 末行（row）流式持续增长：回写语音条清洗文本与原文
                    const tile = el.querySelector('.vt');
                    if (tile && tile.dataset.text !== items[i].text) {
                        tile.dataset.text = items[i].text;
                        syncRevealedText(tile); // 防「右键转文字」残留半句首字（与 renderVoiceTiles 同口径）
                    }
                    const txt = el.querySelector('.vt-both-text');
                    if (txt) txt.textContent = items[i].raw;
                }
                for (let i = existing.length; i < items.length; i++) addBothItem(contentEl, items[i], i);
            }
        }
        maybeAutoRead(node, isStreaming, contentEl); // 语音条已入 DOM 后再入队（修①⑩）
        return;
    }

    let mismatch = existing.length !== items.length;
    if (!mismatch) {
        for (let i = 0; i < existing.length; i++) {
            const el = existing[i];
            if (typeOf(el) !== items[i].type) { mismatch = true; break; }
            if (typeOf(el) === 'action') {
                if (el.textContent !== items[i].text) { mismatch = true; break; }
            } else {
                const tile = el.querySelector('.vt');
                if (!tile || tile.dataset.text !== items[i].text) { mismatch = true; break; }
            }
        }
    }
    if (mismatch) rebuildBoth(contentEl, items);
    maybeAutoRead(node, isStreaming, contentEl); // 同上：重建后 DOM 已稳定再入队
}

/**
 * 流式自动朗读入队（「自动朗读」开关开启时由 renderVoiceTiles / renderBoth 调用）。
 * 规则（避免重复读 / 误读历史消息 / 复用点击视觉）：
 *   - 仅当 ttsAutoRead + ttsEnabled 开，且非「只显示文字」模式（无语音条可播）。
 *   - 直接拿 DOM 里的语音条元素（.vt）入队，回调用 buildTileCb（与手动点击同款）→ 自动读也有高亮/进度条/秒数。
 *   - 流式生成中（isStreaming）：DOM 里仅含「已完成句」+ 末句（多为未完），排除末句读前 n-1 句。
 *   - 流结束（isStreaming=false 且本次消息曾流式）：补齐读剩余（含末句），随后解除 _autoReadArmed，
 *     使之后该消息因切模式被重渲染时不再重复自动读（历史消息防重读）。
 *   - 用 node._autoEnq（Set，按 dataset.text）去重，防止流式多次重渲染时同一句重复入队。
 * @param {object} node 消息节点（承载 _autoEnq / _autoReadArmed 状态）
 * @param {boolean} isStreaming @param {HTMLElement} contentEl 装载层（.bubble-content）
 */
function maybeAutoRead(node, isStreaming, contentEl) {
    if (!state.settings.ttsAutoRead || !state.settings.ttsEnabled) return;
    if (state.settings.ttsDisplayMode === 'text') return; // 纯文字模式无语音条，不自动读
    const tilesEls = Array.from(contentEl.querySelectorAll('.vt'));
    if (!tilesEls.length) return;
    // node._autoEnq 经 JSON 存档/恢复后会从 Set 退化为普通对象 {}（Set/Map 序列化即丢类型），
    // 此时 seen.has 会抛 TypeError 崩溃。统一兜底：非 Set 实例则重建，保证去重集合类型正确可用。
    if (!(node._autoEnq instanceof Set)) node._autoEnq = new Set();
    const seen = node._autoEnq;
    // 维护 idx -> 队列项 映射：流式期同一句序号固定，但其文本会从半句增长到整句。
    // 按 idx（而非 idx:text）去重，使同句只入队一次；文本变化时在队列项原地更新，
    // 避免旧方案（idx:text 去重）在 text 变化时拦不住、导致同一句被多次入队 → 播到倒数第二句跳回重播。
    if (!(node._autoIdxMap instanceof Map)) node._autoIdxMap = new Map();
    const idxMap = node._autoIdxMap;
    const enq = (text, idx) => {
        if (seen.has(idx)) {
            const item = idxMap.get(idx);
            if (item) item.text = text; // 半句→整句：原地更新待播文本，不重复入队
            return;
        }
        seen.add(idx);
        const item = { text, idx, cb: buildTileCb(contentEl, text, idx) };
        idxMap.set(idx, item);
        enqueueAutoSentence(item);
    };
    if (isStreaming) {
        node._autoReadArmed = true;
        for (let i = 0; i < tilesEls.length - 1; i++) enq(tilesEls[i].dataset.text, tilesEls[i].dataset.idx); // 末句未完不读
    } else if (node._autoReadArmed) {
        for (let i = 0; i < tilesEls.length; i++) enq(tilesEls[i].dataset.text, tilesEls[i].dataset.idx); // 流结束补齐末句
        node._autoReadArmed = false;            // 解除武装，防历史重渲染重复读
    }
}

/** 追加一行「语音条 + 文字」（都显示模式的 tile 项） @param {HTMLElement} contentEl @param {object} item @param {number} pos 位置序（错峰动画用） */
function addBothItem(contentEl, item, pos = 0) {
    const wrap = document.createElement('div');
    wrap.className = 'vt-both-row';
    wrap.appendChild(makeTileEl(item.text, item.idx, false, pos));
    const txt = document.createElement('div');
    txt.className = 'vt-both-text';
    txt.textContent = item.raw; // 原文（保留标点/emoji）用于阅读；朗读用清洗后的 text
    wrap.appendChild(txt);
    contentEl.appendChild(wrap);
}

/** 全量重建「都显示」（结构变化 / 首次）：同 rebuild，重建后转移 is-playing（修①） @param {HTMLElement} contentEl @param {Array<object>} items */
function rebuildBoth(contentEl, items) {
    const playingIdx = (playingTile && contentEl.contains(playingTile)) ? playingTile.dataset.idx : null;
    if (playingTile && contentEl.contains(playingTile)) playingTile = null; // 仅清追踪，不停音频
    contentEl.innerHTML = '';
    items.forEach((it, i) => {
        if (it.type === 'action') addVoiceItem(contentEl, it, i);
        else addBothItem(contentEl, it, i);
    });
    if (playingIdx !== null) {
        const live = Array.from(contentEl.querySelectorAll('.vt')).find(t => t.dataset.idx === playingIdx);
        if (live) { playingTile = live; live.classList.add('is-playing'); } // 续播句动画不丢
    }
}

/**
 * 构建一条语音条 DOM（.vt，点击播放 / 再点停止 / 右键转文字）。
 * 抽成工厂供「只显示语音」与「都显示」两套渲染复用。
 * @param {string} text 清洗后文本 @param {number} [idx=0] 句序（tile 全局序号，跨流式帧稳定；播放回调按它精确定位）
 * @param {boolean} [allowReveal=true] 是否允许右键「转文字」（都显示模式下文字已常显，故关闭）
 * @param {number} [pos] 位置序（错峰动画延迟用，缺省回落 idx）
 * @returns {HTMLElement}
 */
function makeTileEl(text, idx = 0, allowReveal = true, pos) {
    const tile = document.createElement('div');
    tile.className = 'vt';
    tile.dataset.text = text;
    tile.dataset.idx = String(idx); // 句序唯一标识：供 buildTileCb/rebuild 精确匹配，同消息内重复句（如"好的。好的。"）也能区分
    tile.style.animationDelay = ((pos ?? idx) * 55) + 'ms'; // 流式逐条错峰淡入
    // 气泡宽度随句子长度（长句宽、短句窄，一眼可辨句子长短）——原 22 根波形条靠条数撑宽，
    // 现 3 点固定，改由句长直接驱动宽度；封顶 320px（CSS max-width:82% 兜底）
    tile.style.width = Math.min(320, 72 + Math.round(text.length * 4)) + 'px';
    // 播放态反馈：三颗错峰跳动小点（纯排版，零图形依赖）。
    // 原 22 根假波形条（waveBars）+ 底部进度线已移除：波形是"假"的、进度估时不准，播放反馈化繁为简（见 tts.css .vt-wave / @keyframes vtDot）
    const wave = document.createElement('span');
    wave.className = 'vt-wave';
    for (let i = 0; i < 3; i++) {
        const d = document.createElement('i');
        d.style.setProperty('--d', (i * 0.15) + 's'); // 三颗错峰：0 / 0.15 / 0.3s
        wave.appendChild(d);
    }
    const durEl = document.createElement('span');
    durEl.className = 'vt-dur';
    durEl.textContent = ''; // 系统语音无 duration 接口，播前无法得知真实秒数；用户定调：做不准就不显示，仅自然播完由 toggleTile 回写实测评测秒数
    const textEl = document.createElement('span');
    textEl.className = 'vt-text';
    textEl.textContent = text; // textContent 防 XSS，绝不用 innerHTML 注入 AI 文本
    tile.append(wave, durEl, textEl);
    tile.addEventListener('click', () => toggleTile(tile));
    if (allowReveal) {
        tile.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation(); // 阻止消息级右键菜单（复制 / 重发）冒泡到 wrapper
            showTileMenu(e.clientX, e.clientY, tile);
        });
    }
    return tile;
}

/** 新建一条语音条并挂事件（「只显示语音」用，允许右键转文字） @param {HTMLElement} contentEl @param {string} text 清洗后文本 @param {number} [idx=0] 句序 @param {number} [pos] 位置序（错峰动画用） */
function addTile(contentEl, text, idx = 0, pos) {
    contentEl.appendChild(makeTileEl(text, idx, true, pos));
}

/**
 * 构建语音条播放回调（手动点击 / 自动朗读共用，保证「自动读」与「点击读」视觉完全一致：
 * 进播放态高亮 + 波形跳动 + 自然播完回写实测评测秒数）。
 * 关键修复（2026-08-17）：不再闭包捕获 tile 引用——流式增量渲染会替换 DOM 节点，
 * 捕获的旧节点会脱离文档，导致 onStart 的 is-playing 被静默跳过（"自动朗读没动画"根因②）。
 * 改为持有 contentEl + text，播放时按 dataset.text 重新查找当前 live 节点。
 * @param {HTMLElement} contentEl 装载层（.bubble-content） @param {string} text 清洗后文本 @param {number} [idx] 句序（唯一标识，用于重复句精确匹配）
 * @returns {{onStart:function,onProgress:function,onEnd:function}}
 */
function buildTileCb(contentEl, text, idx) {
    let t0 = 0;
    // 精确匹配：优先按句序 idx（唯一）定位，避免同消息内完全重复句（如"好的。好的。"）误匹配到第一句；
    // idx 缺失（旧节点无 dataset.idx）时回退按文本匹配。
    const resolve = () => {
        const all = Array.from(contentEl.querySelectorAll('.vt'));
        if (idx !== undefined) {
            const byIdx = all.find(t => t.dataset.idx === String(idx));
            if (byIdx) return byIdx;
        }
        return all.find(t => t.dataset.text === text) || null;
    };
    return {
        onStart: () => {
            const tile = resolve();
            t0 = performance.now();
            playingTile = tile; // 让手动点击「正在自动读的条」可再点停止
            if (tile && tile.isConnected) tile.classList.add('is-playing');
        },
        // 进度条已移除（估时不准确，化繁为简），进度回调保留签名但不写 DOM
        onProgress: () => {},
        onEnd: (natural) => {
            const tile = resolve();
            if (playingTile === tile) playingTile = null; // 先清追踪：避免悬空引用卡死（先于 isConnected 判断）
            if (!tile || !tile.isConnected) return; // 节点已重建/移除：不操作死节点
            tile.classList.remove('is-playing');
            // 仅自然播完（非打断）且真实时长合理（>=1s，排除静默误回）才回写秒数；展开文字时不覆盖布局
            if (natural && !tile.classList.contains('revealed')) {
                const sec = Math.max(1, Math.round((performance.now() - t0) / 1000));
                if (sec >= 1) { const durEl = tile.querySelector('.vt-dur'); if (durEl) durEl.textContent = sec + '"'; }
            }
        }
    };
}

/** 点击切换播放：同一句再点 = 停止；不同句 = 停旧播新 @param {HTMLElement} tile */
function toggleTile(tile) {
    // 停止判定双保险：playingTile 追踪 + 播放态类（is-playing 是"正在播"的直接证据，
    // 避免 playingTile 因自动朗读/重建等竞态失配时点击落进"播新句"分支造成「点了却从头重播」）
    if (playingTile === tile || tile.classList.contains('is-playing')) {
        // 用户主动点停止 = 抢回控制权：停当前 + 清自动朗读队列（否则队列会续播下一句，看起来像"停了又播"）
        clearAutoQueue();
        return;
    }
    clearAutoQueue(); // 用户手动点 = 抢回控制权，停止自动朗读（用户直达铁律）
    // 修（2026-08-17）：buildTileCb 签名是 (contentEl, text)，旧调用误传 tile 当 contentEl、text 为 undefined，
    // 导致 resolve() 查不到节点 → onStart 不加 is-playing（点击无动画）+ playingTile 永不记录（再点落进重播分支，看似「重头再播」）。
    // 用 tile.closest('.bubble-content') 取回装载层（「只显示语音」时 tile 父即 contentEl，「都显示」时父是 .vt-both-row）。
    speakSentence(tile.dataset.text, buildTileCb(tile.closest('.bubble-content'), tile.dataset.text, tile.dataset.idx));
}

/** 展开/收起文字时同步显示文本（textContent 已写入，无需额外操作；保留钩子便于将来扩展） @param {HTMLElement} tile */
function syncRevealedText(tile) {
    const textEl = tile.querySelector('.vt-text');
    if (textEl) textEl.textContent = tile.dataset.text;
}

/** 显示语音条右键菜单（转文字 / 隐藏文字） @param {number} x @param {number} y @param {HTMLElement} tile */
function showTileMenu(x, y, tile) {
    const menu = DOM.vtCtx;
    if (!menu) return;
    ctxTile = tile;
    menu.innerHTML = '';
    const item = document.createElement('button');
    item.textContent = tile.classList.contains('revealed') ? '隐藏文字' : '转文字';
    item.onclick = () => {
        tile.classList.toggle('revealed');
        hideTileMenu();
    };
    menu.appendChild(item);
    menu.style.display = 'block';
    const r = menu.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > window.innerWidth) left = window.innerWidth - r.width - 10;
    if (top + r.height > window.innerHeight) top = window.innerHeight - r.height - 10;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
}

/** 隐藏语音条右键菜单 */
function hideTileMenu() {
    if (DOM.vtCtx) DOM.vtCtx.style.display = 'none';
    ctxTile = null;
}

// 全局点击 / 触摸外部关闭语音条菜单（模块求值期挂一次；点击条本身也会冒泡到这里，菜单已先隐藏，无副作用）
// typeof 守卫：Node 环境（SSR / 单测）import 此模块不 ReferenceError
if (typeof document !== 'undefined') {
    document.addEventListener('click', hideTileMenu);
    document.addEventListener('touchstart', (e) => {
        if (DOM.vtCtx && !DOM.vtCtx.contains(e.target)) hideTileMenu();
    });
}
