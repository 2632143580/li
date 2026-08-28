/**
 * 禁止词面板 — 2026-08-28 改造：与 composer 合并
 *
 * 交互（容器视角）：点 composer 的 ⊘ 按钮（cp-moderator，常驻在 cp-side），
 *   composer 容器从胶囊态升起到半屏 → 内部切换显示内容（cp-textarea / cp-side / cp-foot 隐藏，
 *   cp-mod-panel 显示）。再点 ⊘ 或点 scrim 或按 Esc → 缩回胶囊态。
 *
 * 视觉：cp-mod-panel 三段式 ——
 *   · 头部（标题 / 词数 / 启用开关）：钉在面板顶部
 *   · 主体（词库 textarea + 命中前缀 textarea）：flex:1 撑满
 *   · 底栏（说明 + 收起 / 保存）
 *
 * 关键 UX：
 *   · 头部开关真接引擎 `enabled`：关闭后引擎 checkText 跳过扫描，命中提示不再触发
 *   · 词数在头部实时刷新（解析不落库，仅预览）
 *   · 命中时浮条 #mod-hint 贴在 composer 上方（fixed），与 cp-mod-panel 互不冲突
 *   · 命中提示"应用前缀"：非破坏式注入——前缀 + 换行拼到输入框当前文本前
 *
 * 依赖：engines/moderator-engine、core/bus、core/dom、ui/input-manager、ui/composer
 * 导出：无（副作用导入）
 */
import { moderator } from '../engines/moderator-engine.js';
import { bus, EVENTS } from '../core/bus.js';
import { DOM } from '../core/dom.js';
import { inputManager } from './input-manager.js';
import { openComposerMod, closeComposer } from './composer.js';

// ====================== DOM 引用 ======================
const wordsInput = () => document.getElementById('cp-mod-words');
const prefixInput = () => document.getElementById('cp-mod-prefix');
const numEl = () => document.getElementById('cp-mod-num');
const toggleEl = () => document.getElementById('cp-mod-toggle');
const saveBtn = () => document.getElementById('cp-mod-save');
const cancelBtn = () => document.getElementById('cp-mod-cancel');
/** 2026-08-28 改造:两个位置的禁词触发按钮 ——
 *  · #cp-moderator 胶囊态 cp-side 内(textarea 右下角)
 *  · #cp-moderator-foot 展开态 cp-foot .cp-actions 内(与"收起 / 发送"同排)
 * 共享同一份状态:点任一都同步数据 + 调 openComposerMod/closeComposer。 */
const triggerBtns = () => [
    document.getElementById('cp-moderator'),
    document.getElementById('cp-moderator-foot')
].filter(Boolean);
const hintEl = () => document.getElementById('mod-hint');
const hitWordsEl = () => document.getElementById('mod-hit-words');

// ====================== 状态 ======================
/** 最近一次命中的词条（「应用前缀」读取用） */
let lastHits = [];

// ====================== 辅助函数 ======================
/** 解析 textarea 文本为词数（不落库，仅用于实时预览） */
function parseWordCount(text) {
    if (!text) return 0;
    return text.split(/[,\n，]/).map((s) => s.trim()).filter(Boolean).length;
}

/** 同步词数显示 */
function syncCount(n) {
    const el = numEl();
    if (el) el.textContent = String(n);
}

/** 同步开关视觉（aria-checked 驱动 CSS） */
function syncToggle() {
    const el = toggleEl();
    if (el) el.setAttribute('aria-checked', String(moderator.enabled));
}

// ====================== 事件绑定 ======================
// 触发按钮:两个位置共享同一份处理（同步词库/前缀 + 切半屏禁词面板）
function onTriggerClick(e) {
    e.stopPropagation();
    const composer = document.getElementById('composer');
    const isMod = composer && composer.classList.contains('mod');
    if (isMod) {
        closeComposer();
        return;
    }
    // 切半屏禁词面板前同步词库 / 前缀 / 词数 / 开关
    const w = wordsInput();
    const p = prefixInput();
    if (w) w.value = moderator.getWordsString();
    if (p) p.value = moderator.prefixTemplate;
    syncCount(moderator.words.length);
    syncToggle();
    openComposerMod();
}
triggerBtns().forEach((btn) => btn.addEventListener('click', onTriggerClick));

const tg = toggleEl();
if (tg) {
    tg.addEventListener('click', (e) => {
        e.stopPropagation();
        moderator.enabled = !moderator.enabled;
        moderator.save();
        syncToggle();
    });
}

const wInput = wordsInput();
if (wInput) {
    wInput.addEventListener('input', () => syncCount(parseWordCount(wInput.value)));
}

const sv = saveBtn();
if (sv) {
    sv.addEventListener('click', (e) => {
        e.stopPropagation();
        const w = wordsInput();
        const p = prefixInput();
        if (w) moderator.syncWordsByText(w.value);
        if (p) moderator.prefixTemplate = p.value || '（警告：已触发禁止词「{words}」，请更换表达方式）';
        moderator.save();
        syncCount(moderator.words.length);
        closeComposer(); // 关闭整个 composer（含 .mod 态）
    });
}

const cBtn = cancelBtn();
if (cBtn) {
    cBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeComposer(); // 关闭整个 composer
    });
}

// 引擎命中事件：展示命中词 + 淡入提示条（贴在 composer 上方）
bus.on(EVENTS.MODERATOR_HIT, (hits) => {
    lastHits = hits;
    const hw = hitWordsEl();
    if (hw) hw.textContent = hits.map((h) => h.word).join(', ');
    const h = hintEl();
    if (!h) return;
    h.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => h.classList.add('fade')));
});

// 应用前缀：非破坏式注入——前缀 + 换行拼到输入框当前文本前
const hint = hintEl();
if (hint) {
    const apply = hint.querySelector('.mh-apply');
    if (apply) {
        apply.addEventListener('click', (e) => {
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
    }
    const close = hint.querySelector('.mh-close');
    if (close) {
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            hint.classList.remove('fade');
            setTimeout(() => hint.classList.remove('show'), 220);
        });
    }
}
