/**
 * 更新日志页（用户 2026-08-19 要求：展示版本更新时间线，结构化 / 清晰 / 简洁，非调试日志）。
 * 入口：右上顶栏 waifu 按钮左侧的列表图标按钮。
 * 依赖：core/dom（DOM.btnLogToggle）、core/registry（registerUI）。
 */
import { DOM } from '../../core/dom.js';
import { registerUI } from '../../core/registry.js';

registerUI('log-panel', setupLogPanel);

/**
 * 更新日志数据源（手写 changelog，倒序：最新在上）。
 * 每条：tag（版本/阶段标识）、date、title、items（要点列表）。
 * @type {Array<{tag:string, date:string, title:string, items:string[]}>}
 */
const UPDATES = [
    {
        tag: '当前版本',
        date: '2026-08-19',
        title: '自动朗读重播修复 · 云端TTS预加载 · 更新日志页',
        items: [
            '【修复】自动朗读播到倒数第二句跳回前面重播：入队去重改为按句序，流式期文本原地更新，每句只播一次完整版',
            '【优化】云端 TTS 有限并发 ≤2 + 按需预加载（播当前句时预拉下一句 / 悬停预拉）；仅云端源生效，本地合成无需预加载',
            '【新增】更新日志页（waifu 按钮左侧）'
        ]
    },
    {
        tag: 'v1.0.0',
        date: '2026-08-18',
        title: '语音面板优化 · 云端TTS音频持久化 · 自动构建',
        items: [
            '语音面板纯正向优化（缓存卡片 / 容量进度条 / 提示卡 / 圆角 chip）',
            '云端 TTS 音频落盘 IndexedDB 持久化（本地系统合成不落盘）',
            'Release 自动构建工作流（.github/workflows/release-build.yml）'
        ]
    }
];

/** 转义 HTML，防注入（UPDATES 虽为内部常量，仍统一转义） */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 更新日志面板 setup */
function setupLogPanel() {
    const btn = DOM.btnLogToggle;
    if (!btn) return;
    btn.style.cursor = 'pointer';

    const panel = document.createElement('div');
    panel.id = 'log-panel';
    panel.style.cssText = [
        'position:fixed', 'right:12px', 'bottom:64px',
        'width:min(92vw,380px)', 'max-height:64vh', 'display:none',
        'flex-direction:column', 'background:var(--bg-modal)',
        'border:1px solid var(--white-a12)', 'border-radius:12px',
        'box-shadow:0 8px 28px var(--black-a40)', 'z-index:60',
        'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
        'color:var(--white-a85)', 'overflow:hidden'
    ].join(';') + ';';

    const cards = UPDATES.map(u => {
        const isCurrent = u.tag === '当前版本';
        const items = u.items.map(t => `<li style="margin:2px 0;color:var(--white-a75);">${escapeHtml(t)}</li>`).join('');
        return `
            <div style="padding:10px 12px;border-bottom:1px solid var(--white-a08);${isCurrent ? 'background:color-mix(in srgb, var(--color-accent) 10%, transparent);' : ''}">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span style="font-weight:700;color:var(--white-a90);">${escapeHtml(u.tag)}</span>
                    <span style="color:var(--white-a45);font-size:11px;">${escapeHtml(u.date)}</span>
                    ${isCurrent ? '<span style="margin-left:auto;color:var(--color-accent);font-size:11px;font-weight:700;">● 当前</span>' : ''}
                </div>
                <div style="color:var(--white-a90);font-weight:600;margin-bottom:4px;">${escapeHtml(u.title)}</div>
                <ul style="margin:0;padding-left:18px;">${items}</ul>
            </div>`;
    }).join('');

    panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--white-a10);">
            <span style="font-weight:600;flex:1;color:var(--white-a90);">更新日志</span>
            <button id="log-close" style="padding:4px 10px;border:1px solid var(--white-a15);background:var(--white-a06);color:var(--white-a80);border-radius:6px;cursor:pointer;font:inherit;">✕</button>
        </div>
        <div id="log-body" style="overflow:auto;flex:1;">${cards}</div>
    `;
    document.body.appendChild(panel);
    /* 滚动吸收：面板内滚动只滚面板自身，背景聊天记录不被穿透滚动（非 modal，可日志+导航双开） */
    panel.addEventListener('wheel', (e) => e.stopPropagation());
    panel.addEventListener('touchmove', (e) => e.stopPropagation());
    const closeBtn = panel.querySelector('#log-close');

    btn.addEventListener('click', () => {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
}
