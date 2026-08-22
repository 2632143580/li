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
            <div class="component-switcher-options" role="radiogroup" aria-label="组件类型">
                <button class="component-switcher-option" type="button" data-provider="glm" role="radio">
                    <span class="cs-preview cs-preview-ecg" aria-hidden="true"><span class="cs-ecg-line"></span></span>
                    <span><strong>GLM · 医疗监护仪</strong><small>爱心、网格与扫描波形</small></span>
                </button>
                <button class="component-switcher-option" type="button" data-provider="kimi" role="radio">
                    <span class="cs-preview cs-preview-minimal" aria-hidden="true"><span class="cs-minimal-line"></span></span>
                    <span><strong>Kimi · 极简流光</strong><small>轨迹底线与高亮脉冲</small></span>
                </button>
            </div>
            <div class="component-switcher-options" role="radiogroup" aria-label="思维链图标样式">
                <button class="component-switcher-option" type="button" data-style="ecg" role="radio"><span><strong>监护仪形态</strong><small>保留爱心与心电网格</small></span></button>
                <button class="component-switcher-option" type="button" data-style="minimal" role="radio"><span><strong>流光形态</strong><small>轨迹底线与动态高亮</small></span></button>
            </div>
            <div class="component-switcher-emotions" role="radiogroup" aria-label="情绪状态">
                <span class="component-switcher-label">情绪状态</span>
                <button type="button" data-emotion="calm" role="radio">平静</button>
                <button type="button" data-emotion="excited" role="radio">兴奋</button>
                <button type="button" data-emotion="sad" role="radio">悲伤</button>
                <button type="button" data-emotion="thinking" role="radio">思考</button>
            </div>
            <div class="component-switcher-size">
                <span class="component-switcher-label">波形尺寸</span>
                <div class="component-switcher-size-options" role="radiogroup" aria-label="心电图尺寸">
                    <button type="button" class="component-switcher-size-option" data-size="xs" role="radio">14</button>
                    <button type="button" class="component-switcher-size-option" data-size="sm" role="radio">16</button>
                    <button type="button" class="component-switcher-size-option" data-size="md" role="radio">20</button>
                    <button type="button" class="component-switcher-size-option" data-size="lg" role="radio">28</button>
                    <button type="button" class="component-switcher-size-option" data-size="xl" role="radio">40</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(panel);

    const updateSelection = () => {
        const style = state.settings.thinkIconStyle === 'minimal' ? 'minimal' : 'ecg';
        const size = ['xs', 'sm', 'md', 'lg', 'xl'].includes(state.settings.ecgSize) ? state.settings.ecgSize : 'md';
        panel.querySelectorAll('[data-style]').forEach((option) => {
            const selected = option.dataset.style === style;
            option.classList.toggle('selected', selected);
            option.setAttribute('aria-checked', String(selected));
        });
        panel.querySelectorAll('[data-provider]').forEach((option) => {
            const selected = option.dataset.provider === (state.settings.thinkIconProvider === 'kimi' ? 'kimi' : 'glm');
            option.classList.toggle('selected', selected);
            option.setAttribute('aria-checked', String(selected));
        });
        panel.querySelectorAll('[data-size]').forEach((option) => {
            const selected = option.dataset.size === size;
            option.classList.toggle('selected', selected);
            option.setAttribute('aria-checked', String(selected));
        });
        panel.querySelectorAll('[data-emotion]').forEach((option) => {
            const selected = option.dataset.emotion === (state.settings.ecgEmotion || 'calm');
            option.classList.toggle('selected', selected);
            option.setAttribute('aria-checked', String(selected));
        });
    };
    panel.addEventListener('click', (event) => {
        if (event.target === panel) { closeAllModals(); return; }
        const option = event.target.closest('[data-style], [data-provider], [data-size], [data-emotion]');
        if (!option) return;
        if (option.dataset.style) state.settings.thinkIconStyle = option.dataset.style;
        if (option.dataset.provider) state.settings.thinkIconProvider = option.dataset.provider;
        if (option.dataset.size) state.settings.ecgSize = option.dataset.size;
        if (option.dataset.emotion) state.settings.ecgEmotion = option.dataset.emotion;
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
