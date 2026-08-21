/**
 * 语音设置（句句发语音）事件绑定
 *
 * 职责（云端唯一语音源）：
 *   1. 顶栏扬声器图标 #btn-tts-toggle：点击打开「语音设置模态框」（不再是自动朗读的开/关切换）
 *   2. 模态框内：语音回复开关（ttsEnabled）、发语音概率（ttsProb 滑块）、云端音色下拉、云端 Key/接口/模型
 *   3. 图标点亮态跟随 ttsEnabled（状态指示，非切换）
 *   4. 关闭语音回复时停止正在播放的语音条，并重新渲染对话（语音条 ↔ 纯文本）
 *
 * 依赖：core/dom、core/state、core/storage、core/modal（互斥开关）、chat/tree（renderChat）、
 *       engines/tts-engine（getCloudVoices / stopCurrent / testCloudTTS / clearAutoQueue / getCloudCacheStats）、core/registry
 */
import { DOM } from '../../core/dom.js';
import { state } from '../../core/store.js';
import { saveToLocal } from '../../core/storage.js';
import { renderChat } from '../../chat/tree.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { getCloudVoices, stopCurrent, testCloudTTS, clearAutoQueue, getCloudCacheStats, clearCloudCache, setCloudCacheChangeListener } from '../../engines/tts-engine.js';
import { VOICE_CACHE_MAX_BYTES } from '../../core/voice-cache.js';
import { registerUI } from '../../core/registry.js';

registerUI('tts', bindVoiceSettings);

/** 同步发语音概率 UI（滑块值 + 百分比文案） @returns {void} */
function syncProbUI() {
    const p = Math.round((typeof state.settings.ttsProb === 'number' ? state.settings.ttsProb : 1) * 100);
    if (DOM.setVoiceProb) DOM.setVoiceProb.value = String(p);
    if (DOM.setVoiceProbVal) DOM.setVoiceProbVal.textContent = p + '%';
}

/** 同步文字消息显示模式 UI（三分段高亮） @returns {void} */
function syncDisplayModeUI() {
    const mode = state.settings.ttsDisplayMode || 'both';
    if (DOM.setDispText) DOM.setDispText.classList.toggle('active', mode === 'text');
    if (DOM.setDispBoth) DOM.setDispBoth.classList.toggle('active', mode === 'both');
    if (DOM.setDispVoice) DOM.setDispVoice.classList.toggle('active', mode === 'voice');
}

/** 把字节数格式化为 KB/MB（≥1MB 用 MB，更省眼） @param {number} bytes @returns {string} */
function fmtCacheBytes(bytes) {
    if (!bytes) return '0 KB';
    const kb = bytes / 1024;
    if (kb < 1024) return kb.toFixed(0) + ' KB';
    return (kb / 1024).toFixed(2) + ' MB';
}

/** 刷新「语音缓存」统计文案（已落盘条数 + 已用 / 上限）；供模态框打开 / 缓存变化时调用 @returns {void} */
function refreshCloudCacheStat() {
    if (!DOM.setCloudCacheStat) return;
    const { count, bytes } = getCloudCacheStats();
    // 复刻背景图持久化语义：显示「已用 X / 上限约 Y」，而非仅内存占用
    DOM.setCloudCacheStat.textContent = count + ' 句 · 已用 ' + fmtCacheBytes(bytes) + ' / 上限约 ' + fmtCacheBytes(VOICE_CACHE_MAX_BYTES);
    // 容量进度条（设计小巧思）：占用比例 = 已用 / 软上限，软上限内不会超 100%
    if (DOM.setCloudCacheBar) {
        const pct = VOICE_CACHE_MAX_BYTES > 0 ? Math.min(100, (bytes / VOICE_CACHE_MAX_BYTES) * 100) : 0;
        DOM.setCloudCacheBar.style.width = pct.toFixed(1) + '%';
    }
}

/** 填充并打开语音设置模态框 @returns {void} */
function openVoiceModal() {
    // 整段容错：面板内的任何控件若因（手机旧 dist 缺元素等）为 null 而抛错，
    // 也绝不能中断最后的 openModal —— 否则「点中图标有动效、面板却不弹」。
    try {
        if (DOM.setVoiceEnabled) DOM.setVoiceEnabled.checked = !!state.settings.ttsEnabled;
        if (DOM.setAutoRead) DOM.setAutoRead.checked = !!state.settings.ttsAutoRead;
        if (DOM.setShowReasoning) DOM.setShowReasoning.checked = !!state.settings.showReasoning;
        populateCloudVoices();
        if (DOM.setCloudKey) DOM.setCloudKey.value = state.settings.ttsCloud?.apiKey || '';
        if (DOM.setCloudBase) DOM.setCloudBase.value = state.settings.ttsCloud?.baseUrl || 'https://api.xiaomimimo.com/v1';
        if (DOM.setCloudModel) DOM.setCloudModel.value = state.settings.ttsCloud?.model || 'mimo-v2.5-tts';
        syncProbUI();
        syncDisplayModeUI();
        refreshCloudCacheStat(); // 打开即显示当前缓存条数 / 大小（内部已判空）
    } catch (err) {
        console.warn('[TTS] 语音设置面板初始化部分失败（某控件缺失，不影响打开）', err?.message || String(err));
    }
    openModal('voice-modal');
}

/** 关闭语音设置模态框 @returns {void} */
function closeVoiceModal() {
    closeAllModals();
    if (DOM.cloudVoiceOptions) DOM.cloudVoiceOptions.classList.remove('show');
}

/** 顶栏图标点亮态跟随语音回复开关：切换 .tts-on 并置换图标符号（开=声波 / 关=静音斜杠） @returns {void} */
function updateTtsIcon() {
    const on = !!state.settings.ttsEnabled;
    DOM.btnTtsToggle.classList.toggle('tts-on', on);
    const use = DOM.btnTtsToggle.querySelector('use');
    if (use) use.setAttribute('href', on ? '#i-vol-on' : '#i-vol-off');
}

/** 填充云端音色下拉（MiMo 预置清单；选中态读 ttsCloud.voice） @returns {void} */
function populateCloudVoices() {
    if (!DOM.cloudVoiceOptions) return;
    const cur = state.settings.ttsCloud?.voice || 'mimo_default';
    DOM.cloudVoiceOptions.innerHTML = '';
    DOM.cloudVoiceText.textContent = cloudVoiceLabel(cur);
    getCloudVoices().forEach(v => {
        const b = document.createElement('button');
        b.className = 'vt-voice-opt';
        b.dataset.voice = v.id;
        b.textContent = `${v.name}（${v.lang === 'zh' ? '中' : '英'}·${v.gender}）`;
        if (cur === v.id) b.classList.add('active');
        DOM.cloudVoiceOptions.appendChild(b);
    });
}

/** 云端音色展示文案 @param {string} id @returns {string} */
function cloudVoiceLabel(id) {
    const hit = getCloudVoices().find(x => x.id === id);
    return hit ? `${hit.name}（${hit.lang === 'zh' ? '中' : '英'}·${hit.gender}）` : '默认（中国集群=冰糖）';
}

export function bindVoiceSettings() {
    // —— 顶栏扬声器图标 → 打开语音设置模态框：必须最先绑定 ——
    // 原因：bindVoiceSettings 被 registry 的 Logger.safe 包裹，一旦后续某行因元素缺失抛错，
    // 后续绑定会被吞掉不执行；把此核心绑定放最前，确保「声音设置」永远能打开（详见坑 16 复盘）。
    if (DOM.btnTtsToggle) DOM.btnTtsToggle.addEventListener('click', openVoiceModal);
    updateTtsIcon(); // 初始点亮态

    // —— 关闭类处理优先绑定（防御性）：即便后续某个控件绑定异常，模态框也始终可关闭，
    //    杜绝 2026-08-14「按钮全失效 + 无法关闭」同类问题复发。
    if (DOM.voiceModalClose) DOM.voiceModalClose.addEventListener('click', closeVoiceModal);
    if (DOM.voiceModalCancel) DOM.voiceModalCancel.addEventListener('click', closeVoiceModal);
    if (DOM.voiceModal) DOM.voiceModal.addEventListener('click', (e) => {
        if (e.target === DOM.voiceModal) closeVoiceModal();
    });
    // Escape 关闭（与设置/词云/消息导航/日志一致，统一模态交互）
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && DOM.voiceModal && getComputedStyle(DOM.voiceModal).display !== 'none') closeVoiceModal();
    });

    // 云端音频缓存变化 → 刷新设置面板统计（重听命中、LRU 淘汰、清空均会触发）
    setCloudCacheChangeListener(refreshCloudCacheStat);

    // 清空本地语音缓存（仅清内存 Blob，不影响已存存档）
    if (DOM.cloudCacheClear) {
        DOM.cloudCacheClear.addEventListener('click', () => {
            clearCloudCache();
            refreshCloudCacheStat();
        });
    }

    // 语音回复开关
    DOM.setVoiceEnabled.addEventListener('change', () => {
        state.settings.ttsEnabled = DOM.setVoiceEnabled.checked;
        updateTtsIcon();
        if (!state.settings.ttsEnabled) { stopCurrent(); clearAutoQueue(); } // 关闭时停止正在播放的语音条 + 清空自动朗读队列
        renderChat(); // 重新渲染：开启→语音条 / 关闭→纯文本
        saveToLocal(null, true);
    });

    // 自动朗读开关（独立于语音回复：仅决定「有了语音条是否自动逐句播」）
    if (DOM.setAutoRead) {
        DOM.setAutoRead.addEventListener('change', () => {
            state.settings.ttsAutoRead = DOM.setAutoRead.checked;
            if (!state.settings.ttsAutoRead) clearAutoQueue(); // 关闭自动朗读即停当前自动播
            saveToLocal(null, true);
        });
    }

    // 显示思维链开关（决定有 reasoning 的 AI 回复是否渲染可折叠思维链块；随对话缓存持久化，与正文一致）
    if (DOM.setShowReasoning) {
        DOM.setShowReasoning.addEventListener('change', () => {
            state.settings.showReasoning = DOM.setShowReasoning.checked;
            renderChat(); // 重新渲染：开启→显示思维链块 / 关闭→隐藏（数据仍在内存，再开即显）
            saveToLocal(null, true);
        });
    }

    // 发语音概率（滑块 0~100% → ttsProb 0~1；按消息掷骰，逻辑见 tree-render.getRenderKind）
    DOM.setVoiceProb.addEventListener('input', () => {
        const p = parseInt(DOM.setVoiceProb.value, 10);
        state.settings.ttsProb = p / 100;
        DOM.setVoiceProbVal.textContent = p + '%';
        saveToLocal(null, true);
        // 注：voice 模式已恒渲染语音条（getRenderKind 不再按概率掷骰），node._voiceChosen 为历史残留字段，不影响显示
    });

    // 文字消息显示模式（只显示文字 / 都显示 / 只显示语音）：覆盖 getRenderKind 的语音/文字决策
    const onDisp = (mode) => {
        state.settings.ttsDisplayMode = mode;
        syncDisplayModeUI();
        clearAutoQueue(); // 切换显示模式打断当前自动朗读（避免跨模式串台）
        renderChat(); // 重新渲染：文字 ↔ 语音条
        saveToLocal(null, true);
    };
    if (DOM.setDispText) DOM.setDispText.addEventListener('click', () => onDisp('text'));
    if (DOM.setDispBoth) DOM.setDispBoth.addEventListener('click', () => onDisp('both'));
    if (DOM.setDispVoice) DOM.setDispVoice.addEventListener('click', () => onDisp('voice'));

    // 云端 API Key 输入（明文存本机，个人自用）
    if (DOM.setCloudKey) {
        DOM.setCloudKey.addEventListener('input', () => {
            if (!state.settings.ttsCloud) state.settings.ttsCloud = {};
            state.settings.ttsCloud.apiKey = DOM.setCloudKey.value.trim();
            saveToLocal(null, true);
        });
    }

    // 云端接口地址 / 模型（高级，一般不动；写入存档便于排查）
    const bindCloudText = (el, key) => {
        if (!el) return;
        el.addEventListener('input', () => {
            if (!state.settings.ttsCloud) state.settings.ttsCloud = {};
            state.settings.ttsCloud[key] = el.value.trim();
            saveToLocal(null, true);
        });
    };
    bindCloudText(DOM.setCloudBase, 'baseUrl');
    bindCloudText(DOM.setCloudModel, 'model');

    // 云端连接测试：一句话验证配置可用，结果直接显示在模态框内（红/绿），不再静默失败
    if (DOM.cloudTest) {
        DOM.cloudTest.addEventListener('click', async () => {
            if (DOM.cloudTestResult) {
                DOM.cloudTestResult.style.display = 'block';
                DOM.cloudTestResult.textContent = '测试中…';
                DOM.cloudTestResult.style.borderColor = '';
                DOM.cloudTestResult.style.color = '';
            }
            const r = await testCloudTTS();
            if (DOM.cloudTestResult) {
                DOM.cloudTestResult.style.display = 'block';
                DOM.cloudTestResult.textContent = (r.ok ? '✓ ' : '✗ ') + r.msg;
                DOM.cloudTestResult.style.borderColor = r.ok
                    ? 'color-mix(in srgb, #4ade80 55%, transparent)'
                    : 'color-mix(in srgb, #ff5a5a 55%, transparent)';
                DOM.cloudTestResult.style.color = r.ok ? '#c9f7d4' : '#ffd5d5';
            }
        });
    }

    // 云端音色下拉（自绘，复用 .vt-voice-* 结构；写入 ttsCloud.voice）
    if (DOM.cloudVoiceTrigger) {
        DOM.cloudVoiceTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            DOM.cloudVoiceOptions.classList.toggle('show');
        });
        document.addEventListener('click', (e) => {
            if (DOM.cloudVoiceOptions && !DOM.cloudVoiceOptions.contains(e.target) && !DOM.cloudVoiceTrigger.contains(e.target)) {
                DOM.cloudVoiceOptions.classList.remove('show');
            }
        });
        DOM.cloudVoiceOptions.addEventListener('click', (e) => {
            const opt = e.target.closest('.vt-voice-opt');
            if (!opt) return;
            if (!state.settings.ttsCloud) state.settings.ttsCloud = {};
            state.settings.ttsCloud.voice = opt.dataset.voice;
            DOM.cloudVoiceText.textContent = opt.textContent;
            DOM.cloudVoiceOptions.classList.remove('show');
            saveToLocal(null, true);
        });
    }

    // 标签页隐藏时停止自动朗读/播放（后台标签页自动播放无意义，切回需用户重新触发）
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) clearAutoQueue();
    });
}
