/**
 * Composer — 输入栏 + 半屏编辑器(一壳两态)
 *
 * 职责(2026-08-28 重构,源自原 .input-bar + #fs-editor 两件套合并):
 *   - 胶囊态:底部 44px 圆角胶囊,textarea 单行自动增高(上限 ≈5 行 = 132px)
 *   - 展开态:同容器半屏升起,textarea 升为编辑器,底部工具行揭示
 *   - 键盘避让:visualViewport 实时写 --kb-h,容器 bottom 逐帧贴键盘
 *   - 动画纪律:唯一动画路径是 transform,height/padding/radius 全部瞬时;
 *     展开途中每次 vv 事件即时把高度追平到当前 editorH()(FIX-10d)
 *   - IME 状态:textarea 原生 isComposing + 自维护 composing/compData/text
 *     单例(`inputManager`),api / session-manager / moderator-ui 等模块透传读
 *   - 消息节点编辑:openComposerEditor(text, onSave, onCancel) 入口,
 *     容器顶部揭示"编辑中"占位条(原文预览 + 取消 / 完成),
 *     取消 = 还原原文 + onCancel,完成 = onSave(text)。
 *     取消逻辑与原 #fs-editor 第二参数 onSave 行为镜像。
 *
 * 导出:composer 单例(inputManager 兼容旧名 + 容器 open/close 控制),
 *      openComposer, openComposerEditor, openComposerMod, closeComposer,
 *      sendCurrent, cancelEdit, updateCount
 * 依赖:core/dom, core/logger, core/registry, engines/bg-engine, chat/tree
 */

import { DOM } from '../core/dom.js';
import { Logger } from '../core/logger.js';
import { registerUI } from '../core/registry.js';
import { BgEngine } from '../engines/bg-engine.js';
import { sendMessage } from '../chat/tree.js';

// ====================== 常量 ======================
/** 字符上限(模拟稿对齐 2000,原 .input-bar 是 500) */
const MAXLEN = 2000;
/** 胶囊态增高上限(≈5 行 14px) */
const IDLE_CAP = 132;

// ====================== DOM 引用 ======================
const composer = DOM.composer;
const cpText = DOM.cpText;
const cpSend = DOM.cpSend;
const cpSendFab = DOM.cpSendFab;
const cpNum = DOM.cpNum;
const cpCount = DOM.cpCount;
const cpExpand = DOM.cpExpand;
const cpCollapse = DOM.cpCollapse;
const cpModerator = DOM.cpModerator;             // 胶囊态 cp-side 内的禁词按钮
const cpModeratorFoot = DOM.cpModeratorFoot;     // 展开态 cp-foot 内的禁词按钮(2026-08-28 补)
const cpScrim = DOM.composerScrim;
const cpEditBar = DOM.cpEditBar;
const cpEditPreview = DOM.cpEditPreview;
const cpEditCancel = DOM.cpEditCancel;
const cpEditSave = DOM.cpEditSave;
const cpModPanel = DOM.cpModPanel;

// ====================== 运行时状态 ======================
/** 键盘高度(像素,逐帧直写 --kb-h) */
let kbPx = 0;
/** 是否因"输入超行"自动升舱过一次(防止连续触发) */
let autoOpened = false;
/** FLIP 滑入/滑出进行中标记(用于冻结 height 变更) */
let morphing = false;
/** morphing 期间的方向(true = 展开 / false = 收起) */
let opening = false;
/** 键盘安定后最终校正的 settle 定时器 */
let settleT = 0;
/** 消息节点编辑上下文:{ originalText, onSave, onCancel } 或 null */
let editCtx = null;

/** 输入管理器单例(对外门面,5 处调用方继续按原名读) */
export const inputManager = {
    /** 当前已提交的输入文本 @type {string} */
    text: '',
    /** 是否处于 IME 组合中 @type {boolean} */
    composing: false,
    /** 当前 IME 组合文本 @type {string} */
    compData: '',
    /** textarea 是否聚焦 @type {boolean} */
    focused: false
};

// ====================== 辅助函数 ======================
const isOpen = () => composer.classList.contains('open');
const isEditing = () => composer.classList.contains('editing');
const isMod = () => composer.classList.contains('mod');

/** 当前可见视口高(visualViewport 优先) */
const visibleH = () => Math.round(
    window.visualViewport ? window.visualViewport.height : window.innerHeight
);

/** 胶囊态增高上限(可视高-120,钳 [44, 132]) */
function idleCap() { return Math.min(IDLE_CAP, Math.max(44, visibleH() - 120)); }

/** 编辑器态目标高(可视高 50%,但留 84px 顶部空间,下限 240) */
function editorH() {
    const v = visibleH();
    return Math.max(240, Math.min(Math.round(v * 0.5), v - 84));
}

/** 实测 textarea 内容高(临时脱离 flex 拉伸) */
function contentH() {
    cpText.style.flex = '0 0 auto';
    cpText.style.height = 'auto';
    const h = cpText.scrollHeight;
    cpText.style.flex = '';
    cpText.style.height = '';
    return h;
}

/** 胶囊态目标高(内容高与上限取小) */
function capsuleH() { return Math.min(Math.max(44, contentH()), idleCap()); }

/**
 * 瞬时布局(FLIP 的 F + L):写完强制 flush,提交起始/终态姿态。
 * 必须在 transform/height 过渡前调用。
 */
function noanim(fn) {
    composer.style.transition = 'none';
    fn();
    void composer.offsetHeight; // flush
    composer.style.transition = '';
}

/**
 * 滑移(FLIP 的 I:Invert→Play),纯 transform 合成器渲染。
 * @param {number} dy 位移
 * @param {number} dur 秒
 * @param {string} ease
 * @param {Function} [done] 完成回调
 */
function slide(dy, dur, ease, done) {
    composer.style.transition = `transform ${dur}s ${ease}`;
    composer.style.transform = `translateY(${dy}px)`;
    let closed = false;
    const finish = () => {
        if (closed) return;
        closed = true;
        composer.removeEventListener('transitionend', onEnd);
        composer.style.transition = '';
        composer.style.transform = '';
        done && done();
    };
    const onEnd = (e) => {
        if (e.target === composer && e.propertyName === 'transform') finish();
    };
    composer.addEventListener('transitionend', onEnd);
    setTimeout(finish, dur * 1000 + 90); // reduced-motion / 后台标签兜底
}

/**
 * 高度调度:FIX-10d 展开途中即时追平,收起途中冻结。
 * height 已无常驻过渡(写入瞬时生效),且 transform 过渡只认
 * transform 自身的值变化,改 height 不会打断/重定向滑入。
 */
function applyHeight() {
    if (morphing) {
        if (opening) composer.style.height = editorH() + 'px';
        return;
    }
    if (isOpen() || isMod()) { composer.style.height = editorH() + 'px'; return; }
    const need = contentH(), cap = idleCap();
    composer.style.height = Math.min(Math.max(44, need), cap) + 'px';
    composer.classList.toggle('roomy', need > 60);
}

// ====================== 开/关/发 ======================

/** 展开为半屏编辑。已开或正在 morphing 则跳过。 */
export function openComposer() {
    if (isOpen() || morphing) return;
    morphing = true; opening = true;
    // 关掉所有可能竞争的弹层(气泡面板 / 提示词面板 / 模态)——展开是大屏单任务
    document.body.classList.add('composer-open');
    const startH = composer.offsetHeight, endH = editorH(), dy = endH - startH;
    noanim(() => {
        composer.classList.add('open');
        composer.classList.remove('roomy');
        composer.style.height = endH + 'px';
        composer.style.transform = `translateY(${dy}px)`;
    });
    cpText.placeholder = '说点什么吧…';
    cpText.focus({ preventScroll: true }); // 唤起键盘 → vv resize → applyHeight 追平
    slide(0, 0.38, 'cubic-bezier(.22,1,.36,1)', () => {
        morphing = false; opening = false;
        applyHeight(); // 此时通常已是空操作
    });
    updateCount();
}

/**
 * 展开为半屏禁词面板(2026-08-28 改造)：从胶囊态升起,容器内切换显示内容
 * (cp-textarea / cp-side / cp-foot 隐藏,cp-mod-panel 显示)。
 * 已开 / 已 mod / 正在 morphing 则跳过。点 cp-moderator / 关闭都走此机制,
 * 跟半屏编辑共用 FLIP 滑入,面板自身不再走浮层互斥。
 */
export function openComposerMod() {
    if (isOpen() || isMod() || morphing) return;
    morphing = true; opening = true;
    document.body.classList.add('composer-open');
    const startH = composer.offsetHeight, endH = editorH(), dy = endH - startH;
    noanim(() => {
        composer.classList.add('open', 'mod');
        composer.classList.remove('roomy');
        composer.style.height = endH + 'px';
        composer.style.transform = `translateY(${dy}px)`;
    });
    if (cpText) cpText.blur(); // 禁词面板不抢键盘
    slide(0, 0.38, 'cubic-bezier(.22,1,.36,1)', () => {
        morphing = false; opening = false;
        applyHeight();
    });
}

/** 收起回胶囊。已关或正在 morphing 则跳过。同时清掉 .mod / .editing。 */
export function closeComposer() {
    if ((!isOpen() && !isMod()) || morphing) return;
    morphing = true; opening = false; // 收起途中冻结高度(下坠中缩高发虚)
    const startH = composer.offsetHeight, endH = capsuleH(), dy = startH - endH;
    if (cpText) {
        cpText.placeholder = '输入消息…';
        cpText.blur(); // 键盘下落 → bottom 逐帧下贴
    }
    document.body.classList.remove('composer-open');
    // 退出编辑模式时也清掉上下文(避免下次开时残留)
    if (editCtx) {
        editCtx = null;
        composer.classList.remove('editing');
    }
    slide(dy, 0.3, 'cubic-bezier(.5,0,.75,.4)', () => {
        noanim(() => {
            composer.classList.remove('open', 'mod');
            composer.style.height = endH + 'px';
            composer.classList.toggle('roomy', contentH() > 60);
        });
        morphing = false;
        applyHeight();
    });
}

/**
 * 字符数 / 发送按钮 / 计数色阶同步。
 * 2026-08-28 改造：胶囊态的发送按钮（cp-send-fab）用 [hidden] 显隐——
 *   无文字时完全隐藏（占位 0 宽,textarea 文字区右扩），有文字时滑入。
 *   展开态的发送按钮（cp-send）维持 disabled 切换（用户在编辑器态下需要看得到按钮以触发发送）。
 * 计数 90% 黄色 / 满 2000 红色。
 */
export function updateCount() {
    if (!cpText || !cpNum) return;
    const n = cpText.value.length;
    cpNum.textContent = String(n);
    const has = !!cpText.value.trim();
    // 胶囊态发送 fab：无文字 → hidden（不占位，textarea 占满）；有文字 → 显示
    if (cpSendFab) cpSendFab.hidden = !has;
    // 展开态底栏发送：维持 disabled 切换（按钮始终可见,灰态表达不可发）
    if (cpSend) cpSend.disabled = !has;
    if (cpCount) {
        cpCount.classList.toggle('warn', n >= MAXLEN * 0.9 && n < MAXLEN);
        cpCount.classList.toggle('full', n >= MAXLEN);
    }
    if (!n) autoOpened = false;
    // 同步 inputManager 单例(其他模块透传读)
    inputManager.text = cpText.value;
}

/**
 * 提交当前文本:编辑模式 → 走 onSave;否则调 sendMessage。
 * 共用一个出口,与原 .input-bar 的 submitInput 行为镜像。
 */
export function sendCurrent() {
    const t = cpText.value.trim();
    if (!t) return;
    if (editCtx) {
        const cb = editCtx.onSave;
        editCtx = null;
        composer.classList.remove('editing');
        cpText.value = '';
        updateCount();
        closeComposer();
        cb(t);
        return;
    }
    cpText.value = '';
    updateCount();
    closeComposer();
    sendMessage(t);
}

/**
 * 取消编辑模式:还原原文字 + onCancel,关 composer。
 * 与原 #fs-editor 的 cancel 行为完全镜像(原文同步回 + 不丢编辑)。
 */
export function cancelEdit() {
    if (!editCtx) return;
    const cb = editCtx.onCancel;
    const oldText = editCtx.originalText;
    editCtx = null;
    composer.classList.remove('editing');
    if (oldText != null) cpText.value = oldText;
    updateCount();
    closeComposer();
    cb && cb();
}

/**
 * 打开消息节点编辑(原 openFSEditor 替代):编辑某条用户消息时调用。
 * 进入编辑模式后,composer 顶部揭示"编辑中"占位条(原文预览 + 取消 / 完成);
 * 取消 = 还原原文;完成 = onSave(text) 替换原节点。
 * @param {string} initialText 原文字
 * @param {(text:string)=>void} onSave 完成回调(发消息链路)
 * @param {()=>void} [onCancel] 取消回调
 */
export function openComposerEditor(initialText, onSave, onCancel) {
    if (typeof onSave !== 'function') {
        Logger.warn('[Composer] openComposerEditor: onSave 必传');
        return;
    }
    editCtx = {
        originalText: initialText || '',
        onSave,
        onCancel: typeof onCancel === 'function' ? onCancel : () => {}
    };
    cpText.value = initialText || '';
    composer.classList.add('editing');
    if (cpEditPreview) cpEditPreview.textContent = initialText || '';
    updateCount();
    if (isOpen()) {
        cpText.focus({ preventScroll: true });
    } else {
        openComposer();
    }
}

// ====================== 事件绑定 ======================

/** 完整事件绑定(registerUI 自动执行) */
function bindComposerEvents() {
    if (!composer) {
        Logger.warn('[Composer] #composer DOM 缺失,跳过事件绑定');
        return;
    }

    // 容器点击 → 抢占焦点(除按钮 / 文本选区)
    composer.addEventListener('click', (e) => {
        if (morphing || e.target.closest('button')) return;
        const sel = window.getSelection();
        if (sel && String(sel)) return;
        cpText.focus({ preventScroll: true });
    });

    // IME 组合
    cpText.addEventListener('compositionstart', () => { inputManager.composing = true; });
    cpText.addEventListener('compositionupdate', (e) => { inputManager.compData = e.data; });
    cpText.addEventListener('compositionend', () => {
        inputManager.composing = false;
        inputManager.compData = '';
        inputManager.text = cpText.value;
        updateCount();
    });

    // 实时输入 + 胶囊态自动增高 / 超上限自动升舱
    cpText.addEventListener('input', () => {
        if (!inputManager.composing) {
            inputManager.text = cpText.value;
            updateCount();
        }
        if (isOpen()) return;
        const need = contentH(), cap = idleCap();
        if (need <= cap) {
            composer.style.height = Math.max(44, need) + 'px';
            composer.classList.toggle('roomy', need > 60);
            autoOpened = false;
        } else if (!autoOpened) {
            autoOpened = true;
            openComposer();
        }
    });

    // 键盘:⌘/Ctrl+Enter 始终发送;Enter 在胶囊态发送 / 展开态换行;Esc 走 global.js 关 composer
    cpText.addEventListener('keydown', (e) => {
        BgEngine.triggerKeydown(e);
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            sendCurrent();
            return;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isOpen()) {
            e.preventDefault();
            sendCurrent();
        }
    });

    cpText.addEventListener('focus', () => { inputManager.focused = true; });
    cpText.addEventListener('blur', () => { inputManager.focused = false; });

    // 按钮
    if (cpExpand) cpExpand.addEventListener('click', (e) => { e.stopPropagation(); openComposer(); });
    if (cpCollapse) cpCollapse.addEventListener('click', (e) => { e.stopPropagation(); closeComposer(); });
    if (cpSend) cpSend.addEventListener('click', (e) => { e.stopPropagation(); sendCurrent(); });
    if (cpSendFab) cpSendFab.addEventListener('click', (e) => { e.stopPropagation(); sendCurrent(); });
    // 禁词按钮 click 由 ui/moderator-ui.js 全权管(同步词库/前缀/开关 + 调 openComposerMod/closeComposer),
    // 此处不再挂监听避免双触发。
    if (cpScrim) cpScrim.addEventListener('click', closeComposer);

    // 编辑模式占位条
    if (cpEditCancel) cpEditCancel.addEventListener('click', (e) => { e.stopPropagation(); cancelEdit(); });
    if (cpEditSave) cpEditSave.addEventListener('click', (e) => { e.stopPropagation(); sendCurrent(); });

    // 键盘避让:visualViewport → --kb-h 逐帧直写
    const vv = window.visualViewport;
    if (vv) {
        const sync = () => {
            kbPx = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            document.documentElement.style.setProperty('--kb-h', kbPx + 'px');
            if (morphing && opening) applyHeight(); // 键盘升起中:不等 settle,立即追平
            clearTimeout(settleT);
            settleT = setTimeout(applyHeight, 150); // 键盘安定后最终校正(通常空操作)
        };
        vv.addEventListener('resize', sync);
        vv.addEventListener('scroll', sync);
        sync();
    }
    window.addEventListener('resize', applyHeight);

    updateCount();
    applyHeight();
}

registerUI('composer', bindComposerEvents);

/**
 * updateInputLayout 占位(原 .input-bar 时代需要,现在由 .composer CSS 全权负责,
 * resize 链路上保留这个 noop 以维持 main.js / session-manager.js 既有调用点签名兼容)。
 * @returns {void}
 */
export function updateInputLayout() {
    /* 布局已由 .composer CSS 全权负责(fixed bottom:14px 居中,见 composer.css) */
}
