/**
 * 窗口 / 全局键盘事件绑定（Stage 3 解耦产出，原 bindGlobalEvents）。
 * 依赖 DOM 门面、H 活绑定（来自 core/dom，随视口变化刷新）、storage、main.onResize 活绑定。
 * 循环依赖安全说明：本模块 import main.onResize，main import 本模块的 bindEvents；
 *   onResize 仅在 bindGlobalEvents() 运行时作为 listener 引用被读取，非模块顶层求值。
 */
import { DOM, H } from '../../core/dom.js';
import { closeAllModals } from '../../core/modal.js';
import { saveToLocal } from '../../core/storage.js';
import { onResize } from '../../main.js';

/** 窗口 / 全局键盘 */
import { registerUI } from '../../core/registry.js';
registerUI('global', bindGlobalEvents);

export function bindGlobalEvents() {
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize);
    }
    window.addEventListener('resize', onResize);

    // 点击底部区域聚焦输入框
    window.addEventListener('click', (e) => {
        if (e.target.id !== 'chat' && e.target.id !== 'bg' && e.target.id !== 'ui-canvas') return;
        if (e.clientY > H - 80) DOM.hiddenInput.focus();
    });

    // 页面卸载前保存
    window.addEventListener('beforeunload', () => {
        saveToLocal(null, true);
    });

    // Escape 关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (DOM.fsEditor.style.display === 'flex') {
            DOM.fsCancel.click();
        } else if (DOM.modal.style.display === 'flex') {
            DOM.modalCancel.click();
        } else if (DOM.bgModal.style.display === 'flex') {
            DOM.bgModalClose.click();
        } else if (DOM.customSchemeModal && DOM.customSchemeModal.style.display === 'flex') {
            closeAllModals();
        }
    });
}
