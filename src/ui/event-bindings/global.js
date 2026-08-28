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
import { clearAutoQueue } from '../../engines/tts-engine.js';   // 关闭页面前清空自动朗读队列（避免后台继续响）
import { closeComposer } from '../composer.js';                 // 2026-08-28:Esc 关 composer 替代旧 DOM.fsCancel.click()

/** 窗口 / 全局键盘 */
import { registerUI } from '../../core/registry.js';
registerUI('global', bindGlobalEvents);

export function bindGlobalEvents() {
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onResize);
    }
    window.addEventListener('resize', onResize);

    // 点击底部区域聚焦输入框（2026-08-28 改向 .composer 内的 cpText）
    window.addEventListener('click', (e) => {
        if (e.target.id !== 'chat' && e.target.id !== 'bg') return;
        if (e.clientY > H - 80 && DOM.cpText) DOM.cpText.focus();
    });

    // 页面卸载前：保存 + 清空自动朗读队列（与「清空对话/切换分支/切到后台/关闭语音」一致，避免后台继续响）
    window.addEventListener('beforeunload', () => {
        saveToLocal(null, true);
        clearAutoQueue();
    });

    // Escape 关闭弹窗：覆盖全部主面板（原实现漏了词云/裁剪/语音三块，ESC 对它们完全无效）。
    // 各面板的关闭点保持与点击「×/取消/确认」完全一致，避免两套关闭逻辑分叉。
    // 2026-08-28:Composer 替代原 #fs-editor,直接调 closeComposer()(关输入/收 scrim/清编辑态)。
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // 优先关 composer(open 状态下最高优先级,避免 sheet 把它盖住后关不掉)
        if (DOM.composer && DOM.composer.classList.contains('open')) {
            closeComposer();
            return;
        }
        // 按 DOM 层级从高到低检查每个互斥面板（global.js 是唯一 Escape 处理点，各面板不再自建监听）
        const msgNav = document.getElementById('msg-nav');
        if (msgNav && getComputedStyle(msgNav).display !== 'none') {
            closeAllModals();
        } else if (DOM.modal && DOM.modal.style.display === 'flex') {
            DOM.modalCancel.click();
        } else if (DOM.bgModal && DOM.bgModal.style.display === 'flex') {
            DOM.bgModalClose.click();
        } else if (DOM.customSchemeModal && DOM.customSchemeModal.style.display === 'flex') {
            closeAllModals();
        } else if (DOM.cropModal && DOM.cropModal.style.display === 'flex') {
            DOM.cropCancel.click();
        } else if (DOM.voiceModal && DOM.voiceModal.style.display === 'flex') {
            DOM.voiceModalCancel.click();
        }
    });
}
