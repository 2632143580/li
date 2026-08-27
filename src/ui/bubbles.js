/**
 * 气泡弹窗互斥（mutual exclusion）
 *
 * 「气泡弹窗」是项目里的专门术语——区别于「模态 sheet 抽屉」(#modal / #voice-modal /
 * #bg-modal 等贴底大面板)。共 3 个，同一时刻只允许一个可见，打开新的自动关旧的：
 *   - 上下文占用编辑气泡  #ctx-edit-pop（点 #ctx-ring 触发）
 *   - 顶栏主体            #tb-body  （点 #monitor-bar 切换展开/收起驱动）
 *   - 提示词面板          #prompt-panel（点 #prompt-toggle 触发）
 *
 * 用法：每个 opener 在自己显示前调用 closeBubbles(except)，传自己的 id 保留自己、关其他。
 *   openCtxEdit()          → closeBubbles('ctx-edit')
 *   setCollapsed(false)    → closeBubbles('tb-body')
 *   openPanel()            → closeBubbles('prompt-panel')
 *
 * 与 core/modal.js 的 closeAllModals 互不替代：后者管 sheet 模态，本文件管气泡弹窗。
 *
 * 依赖：core/dom（仅 DOM 引用）。无事件订阅、无副作用导入。
 */
import { DOM } from '../core/dom.js';

/** 关闭所有气泡弹窗，except 指定保留的那个 id。 @param {'ctx-edit'|'tb-body'|'prompt-panel'|null} [except=null] @returns {void} */
export function closeBubbles(except) {
    if (except !== 'ctx-edit' && DOM.ctxEditPop) DOM.ctxEditPop.hidden = true;
    if (except !== 'tb-body' && DOM.topBarLeft) DOM.topBarLeft.classList.add('collapsed');
    if (except !== 'prompt-panel' && DOM.promptPanel) DOM.promptPanel.hidden = true;
}
