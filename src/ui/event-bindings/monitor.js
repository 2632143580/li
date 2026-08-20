/**
 * 监控信息栏事件绑定：上下文占用圆环 → 编辑气泡（直接改 maxWindow，k 为单位）。
 * 原「监控详情模态框」已按用户要求删除（消息/缓存只做状态展示，不再点击弹面板）。
 * 依赖 DOM 门面、state 单例、storage 与 tree-render 的 updateMonitorUI（保存后刷新圆环）。
 */
import { DOM } from '../../core/dom.js';
import { Logger } from '../../core/logger.js';
import { state } from '../../core/store.js';
import { saveToLocal } from '../../core/storage.js';
import { updateMonitorUI } from '../render/tree-render.js';

/** 监控信息栏：圆环点击开编辑气泡 + 点外/Esc 关闭 */
import { registerUI } from '../../core/registry.js';
registerUI('monitor', bindMonitorEvents);

export function bindMonitorEvents() {
    // 点圆环 → 开编辑气泡（气泡定位在圆环下方，随视口边界翻转）
    DOM.ctxRing.addEventListener('click', (e) => {
        e.stopPropagation();
        openCtxEdit();
    });

    DOM.ctxEditSave.addEventListener('click', saveCtxEdit);
    DOM.ctxEditInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveCtxEdit();
        else if (e.key === 'Escape') closeCtxEdit();
    });

    // 点气泡/圆环外部 → 关闭
    document.addEventListener('click', (e) => {
        if (DOM.ctxEditPop.hidden) return;
        if (e.target.closest('#ctx-edit-pop') || e.target.closest('#ctx-ring')) return;
        closeCtxEdit();
    });
}

/** 打开编辑气泡：回填当前上限(k)与已用值、定位到圆环下方。不自动聚焦——移动端聚焦会弹起软键盘（规范 §6 侵入行为）。 */
function openCtxEdit() {
    DOM.ctxEditInput.value = (state.settings.maxWindow / 1000).toFixed(1);
    // 右上角显示当前已用 token（k，1 位小数；无数据显 '--'）
    const usedK = (state.stats.contextTotal || 0) / 1000;
    DOM.ctxEditUsed.textContent = usedK > 0 ? '已用 ' + usedK.toFixed(1) + 'k' : '已用 --';
    DOM.ctxEditPop.hidden = false;
    const r = DOM.ctxRing.getBoundingClientRect();
    const popW = DOM.ctxEditPop.offsetWidth;
    let left = r.left + r.width / 2 - popW / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));   // 不溢出视口
    DOM.ctxEditPop.style.left = left + 'px';
    DOM.ctxEditPop.style.top = (r.bottom + 8) + 'px';
}

/** 关闭编辑气泡。 */
function closeCtxEdit() {
    DOM.ctxEditPop.hidden = true;
}

/** 保存上限：解析 k 值 → maxWindow（token）→ 存档 → 刷新圆环。 */
function saveCtxEdit() {
    const kw = parseFloat(DOM.ctxEditInput.value);
    if (!isNaN(kw) && kw > 0) {
        state.settings.maxWindow = Math.round(kw * 1000);
        saveToLocal('已保存');
        try { updateMonitorUI(); } catch (err) { Logger.error('监控圆环刷新失败', err); }
    }
    closeCtxEdit();
}
