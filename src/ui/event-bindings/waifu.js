/**
 * 妻子（看板娘）模式切换事件绑定（Stage 3 解耦产出，原 bindWaifuEvents）。
 * 依赖 DOM 门面、state 单例、storage 与 chat/tree 的 renderChat 活函数。
 */
import { DOM } from '../../core/dom.js';
import { state } from '../../core/store.js';
import { debouncedSave } from '../../core/storage.js';
import { renderChat } from '../../chat/tree.js';

/** 妻子模式切换 */
import { registerUI } from '../../core/registry.js';
registerUI('waifu', bindWaifuEvents);

export function bindWaifuEvents() {
    DOM.btnWaifuToggle.addEventListener('click', () => {
        state.waifuMode = !state.waifuMode;
        state.settings.waifuMode = state.waifuMode;
        DOM.chat.classList.toggle('waifu-mode', state.waifuMode);
        DOM.btnWaifuToggle.classList.toggle('active', state.waifuMode);
        renderChat();
        debouncedSave();
    });
}
