/**
 * DOM 引用集中管理 + 视口状态
 *
 * 职责：统一收口所有 getElementById，避免散落各处的 DOM 查询；
 *       提供视口尺寸 W/H 的活绑定（setViewport 重载），供跨模块只读读取。
 *
 * 导出：DOM, uiCtx, W, H, setViewport
 * 依赖：无（最底层视图层，不 import 任何业务模块）
 */

/** 全局 DOM 元素总表：camelCase 键 → HTMLElement。所有模块仅通过 DOM.xxx 访问页面元素。 @type {object<string, HTMLElement>} */
export const DOM = {};

(function buildDOMCache() {
    // 原单文件 buildDOMCache 的 id 清单，逐字保留以保证与 index.html 的 id 对齐
    const ids = [
        'bg', 'bg-img-layer', 'bg-dim-layer', 'bg-dom-layer', 'chat', 'ui-canvas', 'hiddenInput', 'save-indicator',
        'top-msg-count', 'cache-status', 'cache-hit-val', 'context-menu',
        'settings-icon', 'modal', 'modal-close', 'modal-cancel',
        'set-apiUrl', 'set-apiKey', 'set-model-text',
        'set-model-options',
        'set-bgDim', 'set-bgDim-val', 'bg-dim-sim',
        'set-aiName', 'set-sysPrompt',
        'api-key-toggle',
        'provider-tabs', 'provider-hint', 'btn-reset-api', 'btn-fetch-models',
        'quick-theme-palette',
        'custom-scheme-modal', 'custom-scheme-input', 'custom-scheme-preview', 'custom-scheme-list',
        'custom-scheme-mix',
        'custom-scheme-cancel', 'custom-scheme-save',
        'btn-wordcloud', 'wordcloud-dialog', 'wordcloud-close', 'wordcloud-list',
        'wordcloud-query', 'wordcloud-query-result', 'wordcloud-quick', 'wordcloud-status',
        'wordcloud-seg-light', 'wordcloud-seg-jieba', 'wordcloud-note',
        'bg-modal', 'btn-bg-plugin', 'bg-modal-close', 'plugin-list-container', 'theme-list-container',
        'fs-editor', 'fs-textarea', 'fs-title', 'fs-confirm', 'fs-cancel',
        'fs-trigger-btn', 'fs-align-btn',
        'btn-waifu-toggle', 'btn-clear-chat', 'btn-import-all', 'btn-export-all',
        'btn-tts-toggle',
        // 语音设置模态框
        'voice-modal', 'voice-modal-close', 'voice-modal-cancel',
        'set-voiceEnabled', 'set-autoRead', 'voice-name-trigger', 'voice-name-options', 'voice-name-text',
        'set-voiceRate', 'set-voiceRate-val',
        'set-voiceProb', 'set-voiceProb-val', 'set-voiceProb-0', 'set-voiceProb-100',
        'set-voiceSourceSystem', 'set-voiceSourceCloud',
        'voice-system-panel', 'voice-cloud-panel',
        'set-cloudKey', 'cloud-key-toggle', 'cloud-voice-trigger', 'cloud-voice-text', 'cloud-voice-options',
        'set-cloudBase', 'set-cloudModel', 'cloud-test', 'cloud-test-result',
        'set-cloud-cache-stat', 'cloud-cache-clear',
        // 文字消息显示模式（只显示文字 / 都显示 / 只显示语音）
        'set-disp-text', 'set-disp-both', 'set-disp-voice',
        // 语音条右键菜单（转文字）
        'vt-ctx',
        'btn-edit-bg', 'bg-mode-select', 'btn-upload-bg-img', 'btn-bg-pin', 'btn-bg-clear',
        'bg-storage-info', 'btn-bg-clean-old', 'bg-img-grid', 'btn-bg-export', 'btn-bg-import',
        'bg-batch-words', 'btn-bg-batch-apply', 'bg-batch-status',
        'crop-modal', 'crop-frame', 'crop-preview', 'crop-zoom', 'crop-zoom-val', 'crop-fit', 'crop-reset', 'crop-cancel', 'crop-confirm',
        'file-import-all', 'file-import-prompt', 'file-import-bg-image', 'file-import-bg-config', 'bg-current-indicator',
        'sys-prompt-import',
        // 监控信息栏：消息灯 + 缓存灯 + 上下文占用圆环（点击弹编辑气泡改上限）；监控区即展开开关
        'top-bar-left', 'monitor-bar',
        'ctx-ring', 'ctx-ring-fill', 'ctx-ring-pct',
        'ctx-edit-pop', 'ctx-edit-input', 'ctx-edit-used', 'ctx-edit-save'
    ];
    for (const id of ids) {
        // 将 kebab-case 转为 camelCase：set-apiUrl → setApiUrl
        // 注意：字符类含 [a-z0-9]——连字符后若跟数字（如 set-voiceProb-0）也要转大写消连字符，
        // 否则会得到 setVoiceProb-0（带连字符），与 tts.js 引用的 DOM.setVoiceProb0 对不上 → undefined → 绑定抛错。
        const camelKey = id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
        DOM[camelKey] = document.getElementById(id);
    }
})();

/** UI 画布 2D 上下文，供输入渲染器（drawInputArea）绘制呼吸圆环与文本。 @type {CanvasRenderingContext2D} */
export const uiCtx = DOM.uiCanvas.getContext("2d");

/**
 * 视口尺寸（CSS 像素）。以 let 导出实现「活绑定」：
 * 消费者 import { W, H } 后看到的值会随 setViewport 实时更新（ES Module 活绑定语义）。
 * 注意：除 setViewport 外，任何模块都不得对其赋值（导入绑定是只读的，写入会抛 TypeError）。
 * @type {number}
 */
export let W = 0;
/** 视口高度（CSS 像素），活绑定，规则同 W。 @type {number} */
export let H = 0;

/**
 * 重载视口尺寸。这是 W/H 唯一允许的写入点，放在 dom 层避免 dom 反向依赖输入渲染器造成循环引用。
 * @param {number} w - 视口宽（CSS 像素）
 * @param {number} h - 视口高（CSS 像素）
 */
export function setViewport(w, h) {
    W = w;
    H = h;
}
