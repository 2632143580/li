// ============================================================
// modal.js - 模态框统一开关（根治互斥逻辑散落）
// 背景：settings/plugin-panel/wordcloud/tree/quick-theme 各自手动
//   style.display='flex' 打开面板，互斥逻辑重复散落——新增面板要改所有旧函数。
// 根治：注册制——openModal(id) 先关其他主面板，再开目标；closeAllModals() 全关。
// 所有主面板均走 openModal/closeAllModals 互斥开关；已无 class 切换的悬浮面板。
// 依赖：core/logger（同属 core 层，满足「core 零外部依赖」硬约束）。
// ============================================================

import { Logger } from './logger.js';

/** 参与互斥的主面板 id 清单（按需追加新面板，旧代码零改动） @type {string[]} */
const MODAL_IDS = [
    'modal',              // 设置面板
    'wordcloud-dialog',   // 词云
    'bg-modal',           // 背景管理
    'custom-scheme-modal',// 自定义配色
    'voice-modal',        // 语音设置（句句发语音）
    'fs-editor',          // 全屏编辑器
    'crop-modal',         // 背景裁剪编辑器——曾漏加导致 closeAllModals 永远跳过它、确认/取消都关不掉（"上传图片背景关不掉"根因）
    'log-panel',          // 更新日志页
    'msg-nav'             // 消息快速导航面板
];

/**
 * 关闭所有主面板（可排除若干 id——如 crop-modal 从 bg-modal 打开时不能关掉 bg-modal）
 * @param {string|string[]} [exclude] 排除的 id 或 id 数组，不参与关闭
 * @returns {void}
 */
export function closeAllModals(exclude) {
    const ex = Array.isArray(exclude) ? exclude : (exclude ? [exclude] : []);
    MODAL_IDS.forEach(id => {
        if (ex.includes(id)) return;
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = 'none';
    });
    syncBodyScrollLock();
}

/**
 * 打开指定主面板（先互斥关闭其他，再显示目标）
 * @param {string} id 面板 id（须在 MODAL_IDS 内）
 * @param {string|string[]} [exclude] 同时保持打开的 id（同 closeAllModals 的 exclude）
 * @returns {HTMLElement|null} 目标元素（不存在返回 null）
 */
export function openModal(id, exclude) {
    closeAllModals(exclude);
    const el = document.getElementById(id);
    if (el) {
        el.style.display = 'flex';
        syncBodyScrollLock();
    } else {
        // 未知 id：多为拼写错误或忘了在 MODAL_IDS 注册。原实现静默返回 null 难定位，改为显式告警。
        Logger.warn(`[modal] openModal 未知面板 id: "${id}"（DOM 中未找到，已跳过打开）`);
    }
    return el;
}

/**
 * 同步 body 滚动锁：任一主面板可见 → body.modal-open（overflow:hidden 锁滚动，
 * 防止 Via 等移动端在模态框内滑动穿透到底层聊天记录）；全部关闭 → 解锁。
 * 各面板的关闭点必须统一走 closeAllModals/openModal，锁才能正确恢复。
 * @returns {void}
 */
function syncBodyScrollLock() {
    const anyOpen = MODAL_IDS.some(id => {
        const el = document.getElementById(id);
        return !!el && getComputedStyle(el).display !== 'none';
    });
    document.body.classList.toggle('modal-open', anyOpen);
}
