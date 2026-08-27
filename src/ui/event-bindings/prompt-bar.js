/**
 * 顶部中央提示栏（系统提示词 / 人设）独立入口
 *
 * 从设置面板迁出的逻辑：系统提示词编辑不再藏在设置 modal 的 prompt 区块，
 * 改为顶栏独立胶囊 + 编辑面板，位于左侧栏闭合处之后、右侧栏之前。
 *
 * 双轨存储语义与全链路一致（sessions.js：getEffectiveSysPrompt）：
 *   - state.settings.sysPrompt：全局默认
 *   - state.sessionSysPrompt：会话级覆盖（null = 继承全局默认）
 * applySettings（tree.js）统一把根 content 同步为「有效系统提示词」，并广播 SYS_PROMPT_CHANGE。
 *
 * 复用项目 registerUI 自注册范式（与 topbar.js / monitor.js 一致）：
 *   模块加载即 registerUI('prompt-bar', setup)，启动期由 initUI 统一执行。
 */

import { DOM } from '../../core/dom.js';
import { registerUI } from '../../core/registry.js';
import { state } from '../../core/store.js';
import { saveToLocal, saveSession } from '../../core/storage.js';
import { getEffectiveSysPrompt } from '../../core/sessions.js';
import { applySettings } from '../../chat/tree.js';
import { bus, EVENTS } from '../../core/bus.js';

/** 面板内「未提交」的编辑值（关闭 / 取消则丢弃，不回写 state）。 @type {string} */
let pendingPrompt = '';

/**
 * 当前生效状态徽文案：会话级覆盖 → 「会话级」，否则「全局默认」。
 * @returns {string}
 */
function badgeText() {
    return state.sessionSysPrompt != null ? '会话级' : '全局默认';
}

/**
 * 同步胶囊状态徽文案与图标点亮态（有效提示词非空则点亮）。
 * 订阅 SYS_PROMPT_CHANGE，覆盖所有「改了提示词」的路径（含设置页其它保存触发 applySettings）。
 * @returns {void}
 */
function syncBadge() {
    if (DOM.promptBadge) DOM.promptBadge.textContent = badgeText();
    if (DOM.promptToggle) DOM.promptToggle.classList.toggle('active', getEffectiveSysPrompt().trim() !== '');
}

/** 打开面板：载入当前生效值（重开即显示已提交值），聚焦编辑区。 @returns {void} */
function openPanel() {
    pendingPrompt = getEffectiveSysPrompt();
    if (DOM.promptTextarea) DOM.promptTextarea.value = pendingPrompt;
    if (DOM.promptPanel) DOM.promptPanel.hidden = false;
    if (DOM.promptTextarea) DOM.promptTextarea.focus();
}

/** 关闭面板（不提交 pending）。 @returns {void} */
function closePanel() {
    if (DOM.promptPanel) DOM.promptPanel.hidden = true;
}

/** 写入当前会话级覆盖：覆盖优先，applySettings 同步根 content 并广播变化。 @returns {void} */
function applyToSession() {
    state.sessionSysPrompt = pendingPrompt;
    applySettings();
    saveSession(state.activeSessionId);
    closePanel();
    syncBadge();
}

/** 提升为全局默认：清空当前会话覆盖（继承新默认），其它会话不受影响。 @returns {void} */
function setGlobal() {
    state.settings.sysPrompt = pendingPrompt;
    state.sessionSysPrompt = null;
    applySettings();
    saveToLocal('已设为全局默认');
    closePanel();
    syncBadge();
}

/** 触发隐藏文件选择框。 @returns {void} */
function importFile() {
    if (DOM.promptFile) DOM.promptFile.click();
}

/** 读入所选文本文件到编辑区。 @param {Event} e @returns {void} */
function onFileChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        pendingPrompt = String(ev.target.result || '');
        if (DOM.promptTextarea) DOM.promptTextarea.value = pendingPrompt;
    };
    reader.readAsText(file);
    e.target.value = '';
}

/**
 * 导出提示词为 .txt 文件：所见即所得（编辑区当前值），空则回退当前生效值。
 * Blob + 临时 <a download> 触发下载，URL 用完即回收。
 * 注意 ①：revokeObjectURL 必须 setTimeout 延迟 —— 移动端浏览器下载启动是异步的，
 *   同步 revoke 会令 href 提前失效导致手机无法导出（与 data-exchange 同一配方）。
 * 注意 ②：临时 <a> 的程序化点击必须掐断冒泡 —— 否则冒到 document 命中
 *   「点面板外部关闭」监听器，导出瞬间面板会被顺带关闭。
 * @returns {void}
 */
function exportFile() {
    const text = pendingPrompt != null && pendingPrompt.trim() !== '' ? pendingPrompt : getEffectiveSysPrompt();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `系统提示词_${new Date().toISOString().slice(0, 10)}.txt`;
    a.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
    saveToLocal('已导出提示词');
}

export function bindPromptBarEvents() {
    if (!DOM.promptToggle) return;

    syncBadge();
    // 任何路径改了有效提示词都刷新状态徽（含设置页保存触发的 applySettings）
    bus.on(EVENTS.SYS_PROMPT_CHANGE, () => syncBadge());

    // 胶囊：开 / 关面板（阻止冒泡，避免被「点外部关闭」抢先关闭）
    DOM.promptToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (DOM.promptPanel && DOM.promptPanel.hidden) openPanel();
        else closePanel();
    });

    // 关闭按钮
    if (DOM.promptClose) DOM.promptClose.addEventListener('click', closePanel);

    // 编辑区输入：实时写入 pending（不提交，提交仅经「应用 / 全局」按钮）
    if (DOM.promptTextarea) DOM.promptTextarea.addEventListener('input', () => {
        pendingPrompt = DOM.promptTextarea.value;
    });

    // 应用 / 全局 / 导入 / 导出
    if (DOM.promptApply) DOM.promptApply.addEventListener('click', applyToSession);
    if (DOM.promptGlobal) DOM.promptGlobal.addEventListener('click', setGlobal);
    if (DOM.promptImport) DOM.promptImport.addEventListener('click', importFile);
    if (DOM.promptExport) DOM.promptExport.addEventListener('click', exportFile);
    if (DOM.promptFile) DOM.promptFile.addEventListener('change', onFileChange);

    // 点面板外部关闭（不提交）
    document.addEventListener('click', (e) => {
        if (!DOM.promptPanel || DOM.promptPanel.hidden) return;
        if (e.target.closest && e.target.closest('#prompt-bar')) return; // 点在栏自身不关
        closePanel();
    });

    // Esc 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && DOM.promptPanel && !DOM.promptPanel.hidden) closePanel();
    });
}

registerUI('prompt-bar', bindPromptBarEvents);
