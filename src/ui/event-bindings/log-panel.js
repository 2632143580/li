/**
 * 调试用运行日志面板（临时调试组件，用户 2026-08-19 要求加在 waifu 按钮旁）。
 *
 * 职责：在右上顶栏「waifu 按钮」旁放一个日志开关按钮，点击弹出实时日志面板，
 *       订阅 Logger 内存环，展示自动朗读入队/播放、云端预加载跳过/命中 等看不见的行为，
 *       便于确认 bug 修复与优化是否真正生效。
 *
 * 依赖：core/dom（DOM.btnLogToggle）、core/logger（订阅/缓冲）、core/registry（registerUI）。
 */
import { DOM } from '../../core/dom.js';
import { Logger } from '../../core/logger.js';
import { registerUI } from '../../core/registry.js';

registerUI('log-panel', setupLogPanel);

/** 临时调试日志面板 setup */
function setupLogPanel() {
    const btn = DOM.btnLogToggle;
    if (!btn) { Logger.warn('[LogPanel] 未找到 #btn-log-toggle，日志面板未挂载'); return; }
    btn.style.cursor = 'pointer';

    // —— 面板外壳（fixed 右下，初始隐藏）——
    const panel = document.createElement('div');
    panel.id = 'log-panel';
    panel.style.cssText = [
        'position:fixed', 'right:12px', 'bottom:64px',
        'width:min(92vw,400px)', 'max-height:62vh', 'display:none',
        'flex-direction:column', 'background:var(--bg-modal)',
        'border:1px solid var(--white-a12)', 'border-radius:12px',
        'box-shadow:0 8px 28px var(--black-a40)', 'z-index:60',
        'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        'color:var(--white-a85)', 'overflow:hidden'
    ].join(';') + ';';
    panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--white-a10);">
            <span style="font-weight:600;flex:1;color:var(--white-a90);">运行日志</span>
            <button id="log-clear" style="padding:4px 8px;border:1px solid var(--white-a15);background:var(--white-a06);color:var(--white-a80);border-radius:6px;cursor:pointer;font:inherit;">清空</button>
            <button id="log-copy" style="padding:4px 8px;border:1px solid var(--white-a15);background:var(--white-a06);color:var(--white-a80);border-radius:6px;cursor:pointer;font:inherit;">复制</button>
            <button id="log-close" style="padding:4px 10px;border:1px solid var(--white-a15);background:var(--white-a06);color:var(--white-a80);border-radius:6px;cursor:pointer;font:inherit;">✕</button>
        </div>
        <div id="log-body" style="overflow:auto;padding:6px 8px;flex:1;"></div>
    `;
    document.body.appendChild(panel);
    const body = panel.querySelector('#log-body');
    const clearBtn = panel.querySelector('#log-clear');
    const copyBtn = panel.querySelector('#log-copy');
    const closeBtn = panel.querySelector('#log-close');

    const fmt = (entry) => {
        const text = entry.args.map(a =>
            typeof a === 'string' ? a
            : (a && a.message) ? a.message
            : (a instanceof Error) ? (a.stack || a.message)
            : JSON.stringify(a)
        ).join(' ');
        return `[${entry.ts}] [${entry.level.toUpperCase()}] ${text}`;
    };
    const colorFor = (level) =>
        level === 'error' ? 'var(--color-error)'
        : level === 'warn' ? '#e6b800'
        : level === 'debug' ? 'var(--white-a45)'
        : 'var(--white-a85)';

    const appendEntry = (entry) => {
        const row = document.createElement('div');
        row.style.cssText = 'white-space:pre-wrap;word-break:break-word;padding:1px 0;border-bottom:1px solid var(--white-a05);color:' + colorFor(entry.level) + ';';
        row.textContent = fmt(entry);
        body.appendChild(row);
        while (body.childElementCount > 300) body.removeChild(body.firstChild); // DOM 行数兜底，防失控
        body.scrollTop = body.scrollHeight;
    };

    // 订阅实时日志；cb(null) = 缓冲被清空
    Logger.subscribe((entry) => {
        if (entry === null) { body.innerHTML = ''; return; }
        appendEntry(entry);
    });
    // 初始填充历史缓冲
    for (const e of Logger.getBuffer()) appendEntry(e);

    // 交互
    btn.addEventListener('click', () => {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    clearBtn.addEventListener('click', () => Logger.clear());
    copyBtn.addEventListener('click', () => {
        const text = Logger.getBuffer().map(fmt).join('\n');
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = '已复制'; setTimeout(() => (copyBtn.textContent = '复制'), 1200);
            }).catch(() => {});
        }
    });

    Logger.info('[LogPanel] 日志面板已挂载（点击 waifu 旁的列表按钮开关）');
}
