/**
 * 上下文菜单（右键 / 长按）
 *
 * 职责：在消息上弹出「复制 / 编辑重发 / 重新生成|重试」菜单。
 *
 * 导出：showContextMenu, hideContextMenu, bindContextMenuEvents
 * 依赖：core/dom, core/logger, ui/composer（openComposerEditor）, chat/tree（editAndResend, regenerate）
 * 2026-08-28:openFSEditor → openComposerEditor（composer 替代旧 #fs-editor 整屏浮层）
 */
import { DOM, W, H } from '../core/dom.js';
import { Logger } from '../core/logger.js';
import { openComposerEditor } from './composer.js';
import { editAndResend, regenerate } from '../chat/tree.js';

/**
 * 显示上下文菜单
 * @param {number} x - 屏幕 X 坐标
 * @param {number} y - 屏幕 Y 坐标
 * @param {object} node - 消息节点
 * @param {object} parentNode - 父节点
 */
export function showContextMenu(x, y, node, parentNode) {
    DOM.contextMenu.innerHTML = '';

    // 复制
    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制';
    copyBtn.onclick = () => {
        navigator.clipboard.writeText(node.content).catch((e) => {
            Logger.warn('[Clipboard] 复制失败', e);
        });
        hideContextMenu();
    };
    DOM.contextMenu.appendChild(copyBtn);

    if (node.role === 'user') {
        // 用户消息：编辑重发（2026-08-28:走 composer 节点编辑模式，原文 + 取消/完成占位条揭示）
        const editBtn = document.createElement('button');
        editBtn.textContent = '编辑重发';
        editBtn.onclick = () => {
            hideContextMenu();
            openComposerEditor(
                node.content,
                (text) => editAndResend(node, parentNode, text),
                () => { /* 取消 = 不做事,composer 内部已还原原文 + 关 */ }
            );
        };
        DOM.contextMenu.appendChild(editBtn);
    } else {
        // AI 消息：重新生成 / 重试
        const regenBtn = document.createElement('button');
        regenBtn.textContent = node.isError ? '重试' : '重新生成';
        regenBtn.onclick = () => {
            hideContextMenu();
            regenerate(node, parentNode);
        };
        DOM.contextMenu.appendChild(regenBtn);
    }

    DOM.contextMenu.style.display = 'block';
    const rect = DOM.contextMenu.getBoundingClientRect();
    let left = x, top = y;
    // 钳制到右/下视口内：菜单贴边时整体内移，避免溢出屏幕；左/上因 clientX/clientY ≥ 0 不会越界
    if (left + rect.width > W) left = W - rect.width - 10;
    if (top + rect.height > H) top = H - rect.height - 10;
    DOM.contextMenu.style.left = left + 'px';
    DOM.contextMenu.style.top = top + 'px';
}

/** 隐藏上下文菜单 */
export function hideContextMenu() {
    DOM.contextMenu.style.display = 'none';
}

/** 绑定上下文菜单全局隐藏逻辑（点击外部 / 触摸外部） */
import { registerUI } from '../core/registry.js';
registerUI('context-menu', bindContextMenuEvents);

export function bindContextMenuEvents() {
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('touchstart', (e) => {
        if (!DOM.contextMenu.contains(e.target)) hideContextMenu();
    });
}
