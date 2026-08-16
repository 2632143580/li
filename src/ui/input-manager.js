/**
 * 输入管理器（hiddenInput 焦点 / IME / 文本同步 / 全屏编辑器）
 *
 * 职责：管理隐藏输入框的焦点状态、IME 组合输入、回车发送；并提供全屏编辑器开关。
 *       inputManager.text 是渲染器读取的输入文本来源。
 *
 * 导出：inputManager, openFSEditor, alignIcons, currentAlign, bindFsEditorEvents
 * 依赖：core/dom, ui/input-renderer, engines/bg-engine, chat/tree（sendMessage）
 */
import { DOM } from '../core/dom.js';
import { openModal, closeAllModals } from '../core/modal.js';
import { inputRenderer } from './input-renderer.js';
import { BgEngine } from '../engines/bg-engine.js';
import { sendMessage } from '../chat/tree.js';

/** 输入管理器单例 @type {object} */
export const inputManager = {
    /** 当前已提交的输入文本 @type {string} */
    text: "",
    /** 是否处于 IME 组合中 @type {boolean} */
    composing: false,
    /** 当前 IME 组合文本 @type {string} */
    compData: "",
    /** 隐藏输入框是否聚焦 @type {boolean} */
    focused: false,

    /** 初始化：绑定焦点、IME、输入、回车发送等事件 */
    init() {
        DOM.hiddenInput.addEventListener("focus", () => {
            this.focused = true;
            inputRenderer.markDirty();
        });
        DOM.hiddenInput.addEventListener("blur", () => {
            this.focused = false;
            inputRenderer.markDirty();
        });
        DOM.hiddenInput.addEventListener("compositionstart", () => {
            this.composing = true;
            inputRenderer.markDirty();
        });
        DOM.hiddenInput.addEventListener("compositionupdate", (e) => {
            this.compData = e.data;
            inputRenderer.markDirty();
        });
        DOM.hiddenInput.addEventListener("compositionend", () => {
            this.composing = false;
            this.compData = "";
            this.text = DOM.hiddenInput.value;
            inputRenderer.markDirty();
        });
        DOM.hiddenInput.addEventListener("input", () => {
            if (!this.composing) {
                this.text = DOM.hiddenInput.value;
                inputRenderer.markDirty();
            }
        });
        DOM.hiddenInput.addEventListener("keydown", (e) => {
            BgEngine.triggerKeydown(e);
            if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                const t = this.text.trim();
                if (t) {
                    DOM.hiddenInput.value = "";
                    this.text = "";
                    this.compData = "";
                    sendMessage(t);
                }
            }
            if (e.key === "Escape") DOM.hiddenInput.blur();
        });
    }
};

/** 对齐方式图标 SVG（center / left） @type {object<string,string>} */
export const alignIcons = {
    center: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="16" y2="18"/></svg>',
    left: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>'
};

/** 全屏编辑器当前对齐方式 @type {'center'|'left'} */
export let currentAlign = 'center';

/**
 * 打开全屏编辑器
 * @param {string} initialText - 初始文本
 * @param {function(string)|null} onSave - 保存回调（非发送模式）
 * @param {boolean} isSendMode - 是否为发送模式（直接发送消息）
 */
export function openFSEditor(initialText, onSave, isSendMode) {
    DOM.hiddenInput.blur();
    DOM.fsTextarea.value = initialText;
    openModal('fs-editor');   // 走统一互斥开关（含 body 滚动锁）
    currentAlign = 'center';
    DOM.fsTextarea.style.textAlign = 'center';
    DOM.fsAlignBtn.innerHTML = alignIcons.center;
    setTimeout(() => DOM.fsTextarea.focus(), 100);
    DOM.fsTitle.textContent = isSendMode ? "沉浸式书写" : "沉浸式编辑";
    DOM.fsConfirm.textContent = isSendMode ? "发送" : "完成";

    DOM.fsConfirm.onclick = () => {
        const text = DOM.fsTextarea.value;
        closeAllModals();
        if (isSendMode) {
            DOM.hiddenInput.value = "";
            inputManager.text = "";
            inputManager.compData = "";
            sendMessage(text);
        } else {
            onSave(text);
        }
    };
    DOM.fsCancel.onclick = () => {
        closeAllModals();
    };
}

/** 绑定全屏编辑器事件（对齐切换 / 触发 / 快捷键） */
import { registerUI } from '../core/registry.js';
registerUI('fs-editor', bindFsEditorEvents);

export function bindFsEditorEvents() {
    DOM.fsAlignBtn.addEventListener('click', () => {
        if (currentAlign === 'center') {
            currentAlign = 'left';
            DOM.fsTextarea.style.textAlign = 'left';
            DOM.fsAlignBtn.innerHTML = alignIcons.left;
        } else {
            currentAlign = 'center';
            DOM.fsTextarea.style.textAlign = 'center';
            DOM.fsAlignBtn.innerHTML = alignIcons.center;
        }
    });
    DOM.fsTriggerBtn.addEventListener('click', () => openFSEditor(DOM.hiddenInput.value, null, true));

    DOM.fsTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            DOM.fsCancel.click();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            DOM.fsConfirm.click();
        }
    });
}
