/**
 * 左侧顶栏折叠（渐进披露）：默认收起(仅监控)，**点击监控区（monitor-bar，非圆环区域）切换展开/收起**；
 * 原独立箭头按钮（tb-left-toggle）已按用户要求移除——展开逻辑由监控承担。
 * 状态记 localStorage。
 * 复用项目 registerUI 自注册范式（与 monitor.js / wordcloud-panel.js 一致）。
 *
 * 关键约束（避免埋 bug）：
 *   - 监控区内「圆环」（#ctx-ring）的点击是「编辑上下文上限」，由 monitor.js 绑定并 stopPropagation，
 *     不会冒泡到 monitor-bar 触发展开——两者互不干扰。
 *   - 折叠状态用独立 localStorage 键保存，不混入主存档（STORAGE_KEY 的 chatTree/settings 白名单），
 *     避免被主存档序列化覆盖或污染。
 */

import { DOM } from '../../core/dom.js';
import { registerUI } from '../../core/registry.js';
import { closeBubbles } from '../bubbles.js';

/** 折叠状态的持久化键（'1' = 收起，'0'/缺失 = 展开）。 @type {string} */
const STORAGE_KEY = 'li.topbarLeftCollapsed';

/**
 * 切换折叠态：collapsed 类驱动 CSS 显隐，同步持久化。
 * 展开时调 closeBubbles('tb-body')——与其他气泡弹窗（#ctx-edit-pop / #prompt-panel）互斥。
 * @param {boolean} collapsed true=收起(仅监控) / false=展开(显示全部按钮)
 * @returns {void}
 */
function setCollapsed(collapsed) {
    const bar = DOM.topBarLeft;
    if (!bar) return;
    if (!collapsed) closeBubbles('tb-body');
    bar.classList.toggle('collapsed', collapsed);
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch (_) { /* 隐私模式静默 */ }
}

/**
 * 读取持久化折叠状态；默认收起（用户决策：默认只显示监控）。
 * @returns {boolean} true=收起 / false=展开
 */
function loadCollapsed() {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        // 无记录 → 默认收起；显式 '0' → 展开；'1' → 收起
        return v === null ? true : v === '1';
    } catch (_) {
        return true;
    }
}

export function bindTopBarEvents() {
    const bar = DOM.topBarLeft;
    if (!bar) return;

    // 初始态：默认收起，并恢复上次选择
    setCollapsed(loadCollapsed());

    // 点击监控区（非圆环区域）切换展开/收起；圆环的 click 由 monitor.js 绑定并 stopPropagation，不会到达这里
    DOM.monitorBar.addEventListener('click', () => {
        setCollapsed(bar.classList.contains('collapsed') ? false : true);
    });
}

registerUI('topbar', bindTopBarEvents);
