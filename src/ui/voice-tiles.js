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
import { splitSentences } from '../core/text-split.js';
import { cleanForSpeech, speakSentence, enqueueAutoSentence, clearAutoQueue, preloadSentence } from '../engines/tts-engine.js';

/** 当前播放中的语音条 DOM（互斥：新条播放前先停旧条） @type {HTMLElement|null} */
let playingTile = null;
/** 当前打开的语音条右键菜单所关联的语音条 @type {HTMLElement|null} */
let ctxTile = null;

/**
 * 渲染 / 增量更新语音条到 contentEl。
 * @param {HTMLElement} contentEl 装载层（.bubble-content）
 * @param {object} node 消息节点
 * @param {boolean} isStreaming 是否流式生成中（流式时增量追加，结束后全量重建）
 * @returns {void}
 */
export function renderVoiceTiles(contentEl, node, isStreaming) {
    if (!node.content) { contentEl.textContent = ''; return; }
    // 断句用原始内容（保留段落换行语义），展示 / 朗读用清洗后文本
    const tiles = splitSentences(node.content)
        .map(s => cleanForSpeech(s))
        .filter(s => s.trim());
    if (!tiles.length) { contentEl.textContent = ''; return; }

    const existing = Array.from(contentEl.querySelectorAll('.vt'));

    if (isStreaming) {
        if (existing.length < tiles.length) {
            // 修（自动朗读中段重播）：流式期某句上一帧是末句只显示半句，本帧长出新句后它不再是末句，
            // 但原逻辑只 addTile 新句、从不回写旧句 dataset.text → 旧句停在半句陈旧态。
            // 流式期 maybeAutoRead 用陈旧 dataset.text 入队一次、流结束 rebuild 用整句再入队一次，
            // 去重键 idx:text 不同拦不住[exi 同一句被朗读两次（半句+整句）。先把它对齐成当前正确整句。
            for (let i = 0; i < existing.length; i++) {
                if (existing[i].dataset.text !== tiles[i]) {
                    existing[i].dataset.text = tiles[i];
                    syncRevealedText(existing[i]);
                }
            }
            for (let i = existing.length; i < tiles.length; i++) addTile(contentEl, tiles[i], i);
        } else if (existing.length > tiles.length) {
            rebuild(contentEl, tiles);
        } else if (existing.length) {
            // 数量一致：仅更新最后一句（流式时末句持续增长）
            existing[existing.length - 1].dataset.text = tiles[tiles.length - 1];
            syncRevealedText(existing[existing.length - 1]);
        }
        maybeAutoRead(node, isStreaming, contentEl); // 语音条已入 DOM 后再入队（修①⑩：避免绑旧节点 / 新句延迟）
        return;
    }

    // 非流式：仅当结构（数量 / 文本）变化才重建，保留用户已展开的「转文字」与播放态
    let mismatch = existing.length !== tiles.length;
    if (!mismatch) {
        for (let i = 0; i < existing.length; i++) {
            if (existing[i].dataset.text !== tiles[i]) { mismatch = true; break; }
        }
    }
    if (mismatch) rebuild(contentEl, tiles);
    maybeAutoRead(node, isStreaming, contentEl); // 同上：重建后 DOM 已稳定再入队
}

/** 全量重建（结构变化 / 首次）：重建前记录正在播放的句，重建后把 is-playing 转移到新节点，
 *  不调用 stopCurrent（修①：避免流结束重建截断自动朗读音频 / 抹掉动画）。
 *  自动朗读跨重建应续播，手动停止由 clearAutoQueue 负责。 @param {HTMLElement} contentEl @param {Array<string>} tiles */
function rebuild(contentEl, tiles) {
    const playingIdx = (playingTile && contentEl.contains(playingTile)) ? playingTile.dataset.idx : null;
    if (playingTile && contentEl.contains(playingTile)) playingTile = null; // 仅清追踪，不停音频
    contentEl.innerHTML = '';
    tiles.forEach((t, i) => addTile(contentEl, t, i));
    if (playingIdx !== null) {
        // 按句序 idx 转移（非文本）：重复句也能精确续播到原句，不误定位到同文本第一句
        const live = Array.from(contentEl.querySelectorAll('.vt')).find(t => t.dataset.idx === playingIdx);
        if (live) { playingTile = live; live.classList.add('is-playing'); } // 续播句动画不丢
    }
}

/**
 * 渲染「都显示」：每条 AI 消息同时呈现语音条 + 文字（逐句「波形在上、文字在下」）。
 * 与 renderVoiceTiles 同构（增量/流式/全量重建），只是每个句子多挂一个 .vt-both-text 原文块。
 * 复用 makeTileEl（allowReveal=false：文字已常显，无需右键转文字）。
 * @param {HTMLElement} contentEl @param {object} node @param {boolean} isStreaming
 */
export function renderBoth(contentEl, node, isStreaming) {
    if (!node.content) { contentEl.textContent = ''; return; }
    const rows = splitSentences(node.content)
        .map(s => ({ raw: s, clean: cleanForSpeech(s) }))
        .filter(r => r.clean.trim());
    if (!rows.length) { contentEl.textContent = ''; return; }

    const existing = Array.from(contentEl.querySelectorAll('.vt-both-row'));

    if (isStreaming) {
        if (existing.length < rows.length) {
            for (let i = existing.length; i < rows.length; i++) addBothRow(contentEl, rows[i], i);
        } else if (existing.length > rows.length) {
            rebuildBoth(contentEl, rows);
        } else {
            const last = existing[existing.length - 1];
            const tile = last.querySelector('.vt');
            if (tile) tile.dataset.text = rows[rows.length - 1].clean;
            const txt = last.querySelector('.vt-both-text');
            if (txt) txt.textContent = rows[rows.length - 1].raw;
        }
        maybeAutoRead(node, isStreaming, contentEl); // 语音条已入 DOM 后再入队（修①⑩）
        return;
    }

    let mismatch = existing.length !== rows.length;
    if (!mismatch) {
        for (let i = 0; i < existing.length; i++) {
            const tile = existing[i].querySelector('.vt');
            if (tile && tile.dataset.text !== rows[i].clean) { mismatch = true; break; }
        }
    }
    if (mismatch) rebuildBoth(contentEl, rows);
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
        for (let i = 0; i < tilesEls.length - 1; i++) enq(tilesEls[i].dataset.text, i); // 末句未完不读
    } else if (node._autoReadArmed) {
        for (let i = 0; i < tilesEls.length; i++) enq(tilesEls[i].dataset.text, i); // 流结束补齐末句
        node._autoReadArmed = false;            // 解除武装，防历史重渲染重复读
    }
}

/** 新增一行「语音条 + 文字」 @param {HTMLElement} contentEl @param {{raw:string,clean:string}} row @param {number} idx */
function addBothRow(contentEl, row, idx = 0) {
    const wrap = document.createElement('div');
    wrap.className = 'vt-both-row';
    wrap.appendChild(makeTileEl(row.clean, idx, false));
    const txt = document.createElement('div');
    txt.className = 'vt-both-text';
    txt.textContent = row.raw; // 原文（保留标点/emoji）用于阅读；朗读用清洗后的 clean
    wrap.appendChild(txt);
    contentEl.appendChild(wrap);
}

/** 全量重建「都显示」（结构变化 / 首次）：同 rebuild，重建后转移 is-playing（修①） @param {HTMLElement} contentEl @param {Array<{raw:string,clean:string}>} rows */
function rebuildBoth(contentEl, rows) {
    const playingIdx = (playingTile && contentEl.contains(playingTile)) ? playingTile.dataset.idx : null;
    if (playingTile && contentEl.contains(playingTile)) playingTile = null; // 仅清追踪，不停音频
    contentEl.innerHTML = '';
    rows.forEach((r, i) => addBothRow(contentEl, r, i));
    if (playingIdx !== null) {
        const live = Array.from(contentEl.querySelectorAll('.vt')).find(t => t.dataset.idx === playingIdx);
        if (live) { playingTile = live; live.classList.add('is-playing'); } // 续播句动画不丢
    }
}

/**
 * 构建一条语音条 DOM（.vt，点击播放 / 再点停止 / 右键转文字）。
 * 抽成工厂供「只显示语音」与「都显示」两套渲染复用。
 * @param {string} text 清洗后文本 @param {number} [idx=0] 句序（错峰动画延迟） @param {boolean} [allowReveal=true] 是否允许右键「转文字」（都显示模式下文字已常显，故关闭）
 * @returns {HTMLElement}
 */
function makeTileEl(text, idx = 0, allowReveal = true) {
    const tile = document.createElement('div');
    tile.className = 'vt';
    tile.dataset.text = text;
    tile.dataset.idx = String(idx); // 句序唯一标识：供 buildTileCb/rebuild 精确匹配，同消息内重复句（如"好的。好的。"）也能区分
    tile.style.animationDelay = (idx * 55) + 'ms'; // 流式逐条错峰淡入
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
    tile.addEventListener('mouseenter', () => preloadSentence(text)); // 悬停预加载（仅云端源+已配 Key 才真发请求，其余静默 return）
    if (allowReveal) {
        tile.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation(); // 阻止消息级右键菜单（复制 / 重发）冒泡到 wrapper
            showTileMenu(e.clientX, e.clientY, tile);
        });
    }
    return tile;
}

/** 新建一条语音条并挂事件（「只显示语音」用，允许右键转文字） @param {HTMLElement} contentEl @param {string} text 清洗后文本 @param {number} [idx=0] */
function addTile(contentEl, text, idx = 0) {
    contentEl.appendChild(makeTileEl(text, idx, true));
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
