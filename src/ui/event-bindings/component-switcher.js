import { DOM } from '../../core/dom.js';
import { state } from '../../core/store.js';
import { saveToLocal } from '../../core/storage.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { registerUI } from '../../core/registry.js';
import { renderChat } from '../render/tree-render.js';
import { buildLoveSvg } from '../../plugins/love-icon.js';
import { buildEcgMonitorSvg, initEcgHeartCanvases } from '../../plugins/ecg-heart.js';
import { buildGlmThinkSvg } from '../../plugins/think-glm.js';
import { buildMinimalThinkSvg } from '../../plugins/think-minimal.js';
import { BgEngine } from '../../engines/bg-engine.js';

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
                <button class="component-switcher-option" type="button" data-provider="ecg" role="radio" aria-checked="false">
                    <span class="cs-preview" data-preview="ecg" aria-hidden="true"></span>
                    <span><strong>ECG · 医疗监护仪</strong><small>爱心、网格与扫描波形</small></span>
                </button>
                <button class="component-switcher-option" type="button" data-provider="glm" role="radio" aria-checked="false">
                    <span class="cs-preview" data-preview="glm" aria-hidden="true"></span>
                    <span><strong>GLM · 双线流光</strong><small>暗底轨迹与流动脉冲</small></span>
                </button>
                <button class="component-switcher-option" type="button" data-provider="kimi" role="radio" aria-checked="false">
                    <span class="cs-preview" data-preview="kimi" aria-hidden="true"></span>
                    <span><strong>Kimi · 单线流光</strong><small>单条脉冲流动</small></span>
                </button>
            </div>
            <div class="component-switcher-wave">
                <label class="toggle-switch"><input type="checkbox" id="cs-showEcgWave"><span class="toggle-slider"></span></label>
                <span class="cs-wave-text">显示波形（爱心始终显示）</span>
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
            <div class="component-switcher-perf">
                <span class="component-switcher-label">性能控制</span>
                <div class="component-switcher-perf-row">
                    <label class="toggle-switch"><input type="checkbox" id="cs-ecgAnimation"><span class="toggle-slider"></span></label>
                    <span class="cs-perf-text">心电图动画</span>
                </div>
                <div class="component-switcher-perf-row">
                    <label class="toggle-switch"><input type="checkbox" id="cs-ecgGlow"><span class="toggle-slider"></span></label>
                    <span class="cs-perf-text">波形辉光</span>
                </div>
                <div class="component-switcher-perf-row">
                    <label class="toggle-switch"><input type="checkbox" id="cs-historyEcg"><span class="toggle-slider"></span></label>
                    <span class="cs-perf-text">历史消息动画</span>
                </div>
                <div class="component-switcher-perf-row">
                    <label class="toggle-switch"><input type="checkbox" id="cs-ecgHalfRate"><span class="toggle-slider"></span></label>
                    <span class="cs-perf-text">波形 30fps（省电）</span>
                </div>
                <div class="component-switcher-perf-row">
                    <label class="toggle-switch"><input type="checkbox" id="cs-bgAnimation"><span class="toggle-slider"></span></label>
                    <span class="cs-perf-text">背景动画</span>
                </div>
                <div class="component-switcher-perf-row">
                    <label class="toggle-switch"><input type="checkbox" id="cs-bgCanvas"><span class="toggle-slider"></span></label>
                    <span class="cs-perf-text">背景画布</span>
                </div>
            </div>
        </div>`;
    document.body.appendChild(panel);

    // 真实「爱心 + 波形」预览：爱心恒显，波形在右、受 showEcgWave 控
    const renderPreview = (previewEl, provider) => {
        const emotion = ['calm', 'excited', 'sad', 'thinking'].includes(state.settings.ecgEmotion) ? state.settings.ecgEmotion : 'calm';
        const size = ['xs', 'sm', 'md', 'lg', 'xl'].includes(state.settings.ecgSize) ? state.settings.ecgSize : 'md';
        previewEl.innerHTML = buildLoveSvg();
        if (state.settings.showEcgWave) {
            if (provider === 'ecg') previewEl.insertAdjacentHTML('beforeend', buildEcgMonitorSvg(emotion, size));
            else if (provider === 'glm') previewEl.insertAdjacentHTML('beforeend', buildGlmThinkSvg(emotion, size));
            else previewEl.insertAdjacentHTML('beforeend', buildMinimalThinkSvg(emotion, size));
        }
    };
    const renderAllPreviews = () => {
        panel.querySelectorAll('[data-preview]').forEach((el) => renderPreview(el, el.dataset.preview));
        // 启动 ecg 预览 canvas（无 canvas 则无操作）；30fps 省电模式同步作用于预览
        initEcgHeartCanvases(panel, state.settings.ecgAnimation, state.settings.ecgGlow, state.settings.ecgHalfRate);
    };

    const updateSelection = () => {
        const size = ['xs', 'sm', 'md', 'lg', 'xl'].includes(state.settings.ecgSize) ? state.settings.ecgSize : 'md';
        panel.querySelectorAll('.component-switcher-option').forEach((option) => {
            const cur = ['ecg', 'glm', 'kimi'].includes(state.settings.thinkIconProvider) ? state.settings.thinkIconProvider : 'ecg';
            const selected = option.dataset.provider === cur;
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
        const waveToggle = panel.querySelector('#cs-showEcgWave');
        if (waveToggle) waveToggle.checked = !!state.settings.showEcgWave;
        const perfIds = ['ecgAnimation', 'ecgGlow', 'historyEcg', 'ecgHalfRate', 'bgAnimation', 'bgCanvas'];
        perfIds.forEach((id) => {
            const el = panel.querySelector('#cs-' + id);
            if (el) el.checked = !!state.settings[id];
        });
        renderAllPreviews();
    };
    panel.addEventListener('click', (event) => {
        if (event.target === panel) { closeAllModals(); return; }
        const option = event.target.closest('[data-provider], [data-size], [data-emotion]');
        if (!option) return;
        if (option.dataset.provider) {
            state.settings.thinkIconProvider = option.dataset.provider;
            state.settings.thinkIconStyle = option.dataset.provider === 'kimi' ? 'minimal' : 'ecg'; // 同步旧字段，避免残留 'minimal' 一票否决 provider
        }
        if (option.dataset.size) state.settings.ecgSize = option.dataset.size;
        if (option.dataset.emotion) state.settings.ecgEmotion = option.dataset.emotion;
        saveToLocal(null, true);
        renderChat();
        updateSelection();
    });
    // 波形显示开关（自设置页迁入）：写全局设置 + 保存 + 实时显隐预览 + 同步思维链头部
    panel.querySelector('#cs-showEcgWave').addEventListener('change', (e) => {
        state.settings.showEcgWave = e.target.checked;
        saveToLocal(null, true);
        renderAllPreviews();
        renderChat();
    });

    // 性能控制开关
    ['ecgAnimation', 'ecgGlow', 'historyEcg', 'ecgHalfRate', 'bgAnimation', 'bgCanvas'].forEach((id) => {
        panel.querySelector('#cs-' + id)?.addEventListener('change', (e) => {
            state.settings[id] = e.target.checked;
            saveToLocal(null, true);
            renderAllPreviews();
            renderChat();
            if (id === 'bgAnimation') {
                if (state.settings.bgAnimation) BgEngine.startLoop();
                else BgEngine.stopLoop();
            }
            if (id === 'bgAnimation' || id === 'bgCanvas') {
                window.dispatchEvent(new Event('resize'));
            }
        });
    });

    panel.querySelector('.component-switcher-close').addEventListener('click', closeAllModals);
    DOM.btnCompSwitch.addEventListener('click', () => {
        updateSelection();
        if (getComputedStyle(panel).display !== 'none') closeAllModals();
        else openModal('component-switcher');
    });
    updateSelection();
}
