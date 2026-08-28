/**
 * 禁止词面板 — 变形扩展版（从 0 重做的 UI/UX）
 *
 * 交互：点输入栏底栏的 ⊘ 图标，面板「从输入栏向上变形生长」——
 *   钉在输入栏上的小头部（标题 + 启用开关）原地不动；
 *   整个编辑器（词库 / 命中前缀 / 保存）从头部上方向上长出（--t: 0 → 编辑器高，0.7s 丝滑）。
 *   关闭时反向收起，并整体淡出，避免"啪"地消失。
 *
 * 变形机制（按用户给的 .card + 四变量规范）：
 *   #mod-pop 的高度 = calc(--mod-base-h + --t)；--t 由 0 过渡到 --mod-ext-t 驱动生长。
 *   .core 头部 top: var(--t)，随 --t 下移但底部恒钉输入栏（panel bottom 固定）。
 *   .ext-top 编辑器 height: var(--t)，从 0 长出；opacity 同步淡入避免硬切。
 *
 * 关键 UX：
 *   · 头部开关真接引擎 `enabled`：关闭后引擎 checkText 跳过扫描，命中提示不再触发。
 *   · 词数在头部与编辑器顶部双显，编辑时实时刷新（解析不落库，仅预览）。
 *   · 保存按钮在编辑器顶部，拇指容易够到；命中前缀为紧凑 2 行 + 提示。
 *   · 触发按钮在面板打开时变 accent 色，状态可读。
 *   · 不自动 focus 编辑器（避免移动端软键盘弹起）。
 *
 * 2026-08-28:触发按钮位置 .ib-icon (.input-bar 内) → .cp-moderator (.composer .cp-foot .cp-actions 内,展开态才可见)。
 *             容器由 .input-bar 改为 .composer,锚定 bottom 用 --composer-h 变量(原 --bar-h 同名,见 composer.css)。
 * 依赖：engines/moderator-engine、core/bus、core/dom、ui/input-manager
 * 导出：无（副作用导入）
 */
import { moderator } from '../engines/moderator-engine.js';
import { bus, EVENTS } from '../core/bus.js';
import { DOM } from '../core/dom.js';
import { inputManager } from './input-manager.js';

// ============ 样式（就近内联；同 style.css 内联到 dist 的做法） ============
const style = document.createElement('style');
style.textContent = `
    /* ============ 变形参数（:root 集中，便于一处调全局生效） ============ */
    :root {
        --mod-base-h: 44px;                                                 /* 头部高（钉在输入栏上那一小块） */
        --mod-ext-t:  min(300px, calc(100vh - 160px));                        /* 编辑器展开高；矮屏自动收短防溢出 */
        --mod-ease:   cubic-bezier(0.22, 1, 0.36, 1);
        --mod-fade:   0.22s;                                                  /* 整体淡入/淡出 */
    }

    /* ============ 面板（.card：宽度与输入栏共用 --bar-width，零漂移） ============ */
    #mod-pop {
        --t: 0px; --r: 0px; --b: 0px; --l: 0px;                              /* 四向扩展量初值 0（折叠态：仅头部） */
        position: fixed;
        bottom: calc(14px + var(--bar-h));                                    /* 锚定输入栏顶部，无缝拼接（2026-08-28:输入条 .input-bar → .composer，--bar-h 沿用同名） */
        left: 50%; transform: translateX(-50%);
        width: var(--bar-width);                                              /* 与输入栏像素级同宽（2026-08-28:.composer 沿用 --bar-width） */
        height: calc(var(--mod-base-h) + var(--t) + var(--b));
        background: var(--bg-input); color: var(--white-a90);
        border: 1px solid var(--white-a10);
        border-bottom: 0;                                                     /* 接入 composer 的 top border，分隔线由那边单独承担，避免双线 */
        /* 关键：top 用 18px（--radius-lg）而非 999px。
           999px 在 560×高 面板上会被宽度截到 280px → 顶部变穹顶，裁切内容（实测）。
           18px 是干净的圆角矩形，与 modal/插件管理器等本仓库面板惯例一致。 */
        border-radius: var(--radius-lg) var(--radius-lg) 0 0;
        padding: 0;
        z-index: 20; box-shadow: var(--modal-elevation);
        overflow: hidden;                                                     /* 折叠态裁掉编辑器溢出，过渡期干净收口 */
        display: none; flex-direction: column;
        opacity: 0;                                                           /* 初始透明，避免 display:flex 切换时头部硬弹 */
        /* 核心丝滑点：尺寸 + 透明度 同步过渡；高度主导（0.7s），淡入淡出辅助（0.22s） */
        transition:
            height 0.7s var(--mod-ease),
            opacity var(--mod-fade) ease;
    }
    #mod-pop.show { display: flex; }
    #mod-pop.fade { opacity: 1; }                                             /* 与 .show 配合：display 后再 fade in */
    #mod-pop.active-top { --t: var(--mod-ext-t); }                            /* 激活向上扩展 → 编辑器从头部上方长出 */
    /* 备用方向（机制完整；本面板未触发，恒 0 不改变外观） */
    #mod-pop.active-right  { --r: 0px; }
    #mod-pop.active-bottom { --b: 0px; }
    #mod-pop.active-left   { --l: 0px; }

    /* ============ 编辑器（扩展区 .ext-top）===========
       height 直接引用 --t，从 0 向上展开；内容 opacity 同步淡入。
       内部 4 行：头部(词库/计数/保存) / 词库 textarea(flex:1 占大头) / 前缀标签 / 前缀 textarea(紧凑) */
    .ext-top {
        position: absolute; top: 0; left: 0; right: 0;
        height: var(--t);
        box-sizing: border-box;
        display: flex; flex-direction: column; gap: 10px;
        padding: 12px 16px;
        overflow: hidden; opacity: 0;
        transition: opacity 0.45s var(--mod-ease);
    }
    #mod-pop.active-top .ext-top { opacity: 1; }

    /* 编辑器顶部行：词库标题 + 实时计数 + 保存（拇指易达、保存常在视野内） */
    .ext-top .ext-head {
        flex: none; display: flex; align-items: center; gap: 10px;
        min-height: 28px;
    }
    .ext-top .ext-title { font-size: 13px; font-weight: 600; color: var(--white-a90); }
    .ext-top .ext-count { font-size: 11px; color: var(--white-a50); }
    .ext-top .ext-count .num { color: var(--white-a70); font-weight: 600; }
    .ext-top .ext-save { margin-left: auto; flex: none; background: var(--color-accent); color: var(--color-bg); border: 0; padding: 6px 14px; border-radius: var(--radius-md); cursor: pointer; font-size: 12px; font-weight: 600; transition: filter var(--transition-fast); }
    .ext-top .ext-save:hover { filter: brightness(1.08); }
    .ext-top .ext-save:active { transform: scale(0.97); }

    /* 词库 textarea：flex:1 占满剩余空间，是面板的主体 */
    .ext-top .ext-words { flex: 1 1 auto; min-height: 0; width: 100%; background: var(--white-a05); color: inherit; border: 1px solid var(--white-a10); border-radius: 4px; padding: 8px 10px; box-sizing: border-box; font-size: 13px; resize: none; font-family: inherit; line-height: 1.5; }
    .ext-top .ext-words::placeholder { color: var(--white-a40); }

    /* 前缀标签 + 提示 */
    .ext-top .ext-foot { flex: none; display: flex; align-items: baseline; gap: 8px; }
    .ext-top .ext-label { font-size: 12px; color: var(--white-a50); }
    .ext-top .ext-hint  { font-size: 11px; color: var(--white-a40); }

    /* 前缀 textarea：紧凑 2 行 */
    .ext-top .ext-prefix { flex: none; width: 100%; height: 44px; background: var(--white-a05); color: inherit; border: 1px solid var(--white-a10); border-radius: 4px; padding: 6px 10px; box-sizing: border-box; font-size: 12px; resize: none; font-family: inherit; line-height: 1.5; }

    /* ============ 头部（核心区 .core）：top 随 --t 下移，但底部恒钉输入栏 ============ */
    .core {
        position: absolute; top: var(--t); left: 0; right: 0;
        height: var(--mod-base-h);
        box-sizing: border-box;
        display: flex; align-items: center; justify-content: space-between;
        padding: 0 16px;
        transition: top 0.7s var(--mod-ease);                                   /* 变形丝滑点：位置随 --t 过渡位移 */
    }
    .core .c-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .core .c-icon  { width: 16px; height: 16px; flex: none; color: var(--white-a70); display: inline-flex; }
    .core .c-icon svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    .core .c-title { font-size: 13px; font-weight: 600; color: var(--white-a90); }
    .core .c-num   { font-size: 11px; color: var(--white-a50); margin-left: 2px; }
    .core .c-num b { color: var(--white-a70); font-weight: 600; }

    /* 启用开关（自绘胶囊；aria-checked 驱动；on=accent 底，off=灰底） */
    .core .c-toggle { position: relative; width: 38px; height: 20px; flex: none; padding: 0; border: 1px solid var(--white-a10); border-radius: 999px; background: var(--white-a05); cursor: pointer; transition: background var(--transition-normal), border-color var(--transition-normal); }
    .core .c-toggle .c-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--white-a50); transition: transform var(--transition-normal), background var(--transition-normal); }
    .core .c-toggle[aria-checked="true"] { background: var(--color-accent); border-color: var(--color-accent); }
    .core .c-toggle[aria-checked="true"] .c-knob { transform: translateX(18px); background: var(--color-bg); }

    /* ============ 触发提示条（命中时）：贴输入栏顶部居中，与面板同语言 ============ */
    #mod-hint {
        position: fixed; bottom: calc(14px + var(--bar-h)); left: 50%; transform: translateX(-50%);
        background: var(--color-user-bright); color: var(--color-bg);
        border-radius: var(--radius-md);
        padding: 6px 10px; font-size: 12px; display: none; align-items: center; gap: 8px;
        z-index: 15; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        opacity: 0; transition: opacity var(--mod-fade) ease;
    }
    #mod-hint.fade { opacity: 1; }
    #mod-hint.show { display: flex; }
    #mod-hint .mh-apply { background: var(--status-error); color: var(--white-a95); border: 0; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-weight: bold; }
    #mod-hint .mh-close { background: transparent; border: 0; color: inherit; cursor: pointer; font-size: 14px; padding: 0 0 0 2px; line-height: 1; }

    /* ============ 窄屏：缩短头部/编辑器，避顶出 ============ */
    @media (max-width: 600px) {
        :root { --mod-base-h: 44px; --mod-ext-t: min(260px, calc(100vh - 140px)); }
    }
`;
document.head.appendChild(style);

// ============ DOM ============

/** 入口图标（⊘）：2026-08-28 收进 composer 半屏编辑底栏 .cp-actions（与"收起 / 发送"同排）；
 *  不可用时挂兜底 body。展开态才显示（composer .open 时由 CSS 揭示） */
const btn = document.createElement('button');
btn.id = 'mod-trigger-btn';
btn.className = 'cp-moderator';
btn.type = 'button';
btn.setAttribute('aria-label', '禁止词');
btn.title = '禁止词';
btn.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><line x1="6" y1="18" x2="18" y2="6"></line></svg>`;
{
    const actions = document.getElementById('cp-actions');
    if (actions) actions.insertBefore(btn, actions.firstChild); // 居左：禁词 / 收起 / 发送
    else document.body.appendChild(btn);
}

/** 面板：.card = .ext-top(编辑器，向上展开) + .core(头部，钉输入栏) */
const pop = document.createElement('div');
pop.id = 'mod-pop';
pop.innerHTML = `
    <div class="ext-top">
        <div class="ext-head">
            <span class="ext-title">词库</span>
            <span class="ext-count"><span class="num" id="mod-count">0</span> 个</span>
            <button class="ext-save" id="mod-save-btn" type="button">保存</button>
        </div>
        <textarea id="mod-words-input" class="ext-words" placeholder="输入词句，逗号或换行分隔"></textarea>
        <div class="ext-foot">
            <span class="ext-label">命中前缀</span>
            <span class="ext-hint">{words} = 命中词</span>
        </div>
        <textarea id="mod-prefix-input" class="ext-prefix" rows="2"></textarea>
    </div>
    <div class="core">
        <div class="c-left">
            <span class="c-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><line x1="6" y1="18" x2="18" y2="6"></line></svg></span>
            <span class="c-title">禁止词</span>
            <span class="c-num"><b id="mod-head-count">0</b> 个</span>
        </div>
        <button class="c-toggle" id="mod-toggle" type="button" role="switch" aria-checked="true" aria-label="启用禁止词过滤">
            <span class="c-knob"></span>
        </button>
    </div>
`;
document.body.appendChild(pop);

/** 触发提示条（命中时） */
const hint = document.createElement('div');
hint.id = 'mod-hint';
hint.innerHTML = `
    <span>触发: <span id="mod-hit-words" style="color:#d20; font-weight:bold;"></span></span>
    <button class="mh-apply" type="button">应用前缀</button>
    <button class="mh-close" type="button" aria-label="关闭">&times;</button>
`;
document.body.appendChild(hint);

// ============ 逻辑 ============
/** 最近一次命中的词条（「应用前缀」读取用） */
let lastHits = [];

/** 关闭动画幂等性：避免快速连点导致多个 transitionend 监听器叠加 */
let isClosing = false;

const $ = (id) => document.getElementById(id);
const wordsInput  = () => $('mod-words-input');
const prefixInput = () => $('mod-prefix-input');
const countEl     = () => $('mod-count');        // 编辑器顶部数字
const headCountEl = () => $('mod-head-count');   // 头部数字
const toggleEl    = () => $('mod-toggle');

/** 解析 textarea 文本为词数（不落库，仅用于实时预览） */
function parseWordCount(text) {
    if (!text) return 0;
    return text.split(/[,\n，]/).map(s => s.trim()).filter(Boolean).length;
}

/** 同步两个计数显示（头部 + 编辑器） */
function syncCounts(n) {
    countEl().textContent = String(n);
    headCountEl().textContent = String(n);
}

/** 同步开关视觉（aria-checked 驱动 CSS） */
function syncToggle() {
    toggleEl().setAttribute('aria-checked', String(moderator.enabled));
}

/** 打开：回填 → display → 双 rAF 后赋 .fade + .active-top 触发变形生长 + 淡入 */
function openPop() {
    wordsInput().value = moderator.getWordsString();
    prefixInput().value = moderator.prefixTemplate;
    syncCounts(moderator.words.length);
    syncToggle();
    isClosing = false;
    pop.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => {
        pop.classList.add('fade', 'active-top');
        btn.classList.add('active');
    }));
}

/** 关闭：撤销 .active-top 触发变形收起 + 淡出；过渡结束后才 display:none */
function closePop() {
    if (!pop.classList.contains('show')) return;
    if (isClosing) return;
    isClosing = true;
    pop.classList.remove('active-top', 'fade');
    btn.classList.remove('active');
    let done = false;
    const finish = () => {
        if (done) return; done = true;
        pop.classList.remove('show');
        pop.removeEventListener('transitionend', onEnd);
    };
    const onEnd = (e) => { if (e.propertyName === 'height') finish(); };
    pop.addEventListener('transitionend', onEnd);
    setTimeout(finish, 900);                                                    // 兜底（> 0.7s 过渡 + 余量）
}

// 触发按钮：切换开/关
btn.addEventListener('click', (e) => {
    e.stopPropagation();                                                        // 防止冒泡到 document 的 outside-click
    if (pop.classList.contains('show')) closePop();
    else openPop();
});

// 开关：切换启用（真接引擎，关闭后 checkText 直接跳过扫描）
toggleEl().addEventListener('click', (e) => {
    e.stopPropagation();
    moderator.enabled = !moderator.enabled;
    moderator.save();
    syncToggle();
});

// 词库编辑时：实时刷新词数（解析不落库，给用户"当前要保存 N 个"的反馈）
wordsInput().addEventListener('input', () => syncCounts(parseWordCount(wordsInput().value)));

// 保存：解析词库 → 存模板 → 刷新计数 → 收起
$('mod-save-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    moderator.syncWordsByText(wordsInput().value);
    moderator.prefixTemplate = prefixInput().value || '（警告：已触发禁止词「{words}」，请更换表达方式）';
    moderator.save();
    syncCounts(moderator.words.length);
    closePop();
});

// 引擎命中事件：展示命中词 + 淡入提示条
bus.on(EVENTS.MODERATOR_HIT, (hits) => {
    lastHits = hits;
    $('mod-hit-words').textContent = hits.map(h => h.word).join(', ');
    hint.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => hint.classList.add('fade')));
});

// 应用前缀：非破坏式注入——前缀 + 换行拼到输入框当前文本前
hint.querySelector('.mh-apply').addEventListener('click', (e) => {
    e.stopPropagation();
    if (lastHits.length === 0) return;
    const prefix = moderator.generatePrefix(lastHits);
    const cur = inputManager.text;
    if (DOM.cpText) DOM.cpText.value = prefix + '\n' + cur;
    inputManager.text = DOM.cpText ? DOM.cpText.value : (prefix + '\n' + cur);
    inputManager.composing = false;
    inputManager.compData = '';
    if (DOM.cpText) DOM.cpText.focus();
    hint.classList.remove('fade');
    setTimeout(() => hint.classList.remove('show'), 220);
});

// 关闭提示条
hint.querySelector('.mh-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hint.classList.remove('fade');
    setTimeout(() => hint.classList.remove('show'), 220);
});

// 点击面板外关闭（变形收起，不挡其它 UI 的点击）
document.addEventListener('click', (e) => {
    if (pop.classList.contains('show') && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        closePop();
    }
});
