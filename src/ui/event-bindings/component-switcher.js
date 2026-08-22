import { DOM } from '../../core/dom.js';
import { state } from '../../core/store.js';
import { saveToLocal } from '../../core/storage.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { registerUI } from '../../core/registry.js';
import { renderChat } from '../render/tree-render.js';

registerUI('component-switcher', setupComponentSwitcher);

function setupComponentSwitcher() {
    if (document.getElementById('component-switcher') || !DOM.btnCompSwitch) return;
    const panel = document.createElement('div');
    panel.id = 'component-switcher';
    panel.className = 'modal-overlay sheet';
    panel.innerHTML = `
        <div class="sheet-body component-switcher-body">
            <div class="component-switcher-header">
                <span class="component-switcher-title">组件切换</span>
                <button class="component-switcher-close" type="button" aria-label="关闭">×</button>
            </div>
            <div class="component-switcher-options" role="radiogroup" aria-label="思维链图标样式">
                <button class="component-switcher-option" type="button" data-style="ecg" role="radio">
                    <span class="cs-preview cs-preview-ecg" aria-hidden="true"><span class="cs-ecg-line"></span></span>
                    <span><strong>医疗监护仪</strong><small>爱心与心电波形</small></span>
                </button>
                <button class="component-switcher-option" type="button" data-style="minimal" role="radio">
                    <span class="cs-preview cs-preview-minimal" aria-hidden="true"><span class="cs-minimal-line"></span></span>
                    <span><strong>极简流光</strong><small>轻量 P-QRS-T 波形</small></span>
                </button>
            </div>
        </div>`;
    document.body.appendChild(panel);

    const updateSelection = () => {
        const style = state.settings.thinkIconStyle === 'minimal' ? 'minimal' : 'ecg';
        panel.querySelectorAll('[data-style]').forEach((option) => {
            const selected = option.dataset.style === style;
            option.classList.toggle('selected', selected);
            option.setAttribute('aria-checked', String(selected));
        });
    };
    panel.addEventListener('click', (event) => {
        if (event.target === panel) closeAllModals();
        const option = event.target.closest('[data-style]');
        if (!option) return;
        state.settings.thinkIconStyle = option.dataset.style;
        saveToLocal(null, true);
        renderChat();
        updateSelection();
    });
    panel.querySelector('.component-switcher-close').addEventListener('click', closeAllModals);
    DOM.btnCompSwitch.addEventListener('click', () => {
        updateSelection();
        if (getComputedStyle(panel).display !== 'none') closeAllModals();
        else openModal('component-switcher');
    });
    updateSelection();
}
