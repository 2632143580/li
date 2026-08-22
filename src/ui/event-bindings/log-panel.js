/**
 * 更新日志页（用户 2026-08-19 要求：展示版本更新时间线，结构化 / 清晰 / 简洁，非调试日志）。
 * 入口：右上顶栏最左的列表图标按钮。
 *
 * 数据外置（用户 2026-08-22 要求）：日志数据从根目录 changelog.json 读取（fetch），
 * 改 JSON 即生效、无需重编译，部署时带上该文件即可。
 *   - 路径用相对 './changelog.json'（非 '/changelog.json'）：本项目 base 为 './' 且支持
 *     子路径部署，绝对路径在子路径下 404；同时单文件产物若以 file:// 双击打开，
 *     fetch 会被浏览器 CORS 拦截（预期行为，走下面的失败兜底）。
 *   - 兜底：加载失败（漏部署 / file:// 双击 / JSON 损坏）时显示一条提示卡片，不白屏。
 *
 * 样式外提：所有 CSS 已移入 modal.css（#log-panel 前缀），本模块不含内联 style。
 * Escape 关闭由 global.js 统一处理，本模块不注册 Escape 监听。
 *
 * 依赖：core/dom（DOM.btnLogToggle）、core/registry（registerUI）、core/modal（openModal/closeAllModals）。
 */
import { DOM } from '../../core/dom.js';
import { registerUI } from '../../core/registry.js';
import { openModal, closeAllModals } from '../../core/modal.js';

registerUI('log-panel', setupLogPanel);

/** 模块级缓存：fetch 成功一次后驻留，后续开关面板零请求 */
let cachedUpdates = null;

/** fetch Promise 去重：并发打开面板只发一次请求 */
let loading = null;

/**
 * 加载外部 changelog.json（结构：[{tag, date, title, items[]}]，倒序最新在上）。
 * @returns {Promise<Array|null>} 成功返回数组并写入缓存；失败返回 null（渲染层显示兜底提示）
 */
async function loadUpdates() {
    if (cachedUpdates) return cachedUpdates;
    if (!loading) {
        loading = fetch('./changelog.json')
            .then((r) => {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then((data) => {
                // 结构校验：必须是数组且每条含必需字段，损坏 JSON 不进缓存
                if (!Array.isArray(data) || !data.every((u) => u && typeof u.tag === 'string'
                    && typeof u.date === 'string' && typeof u.title === 'string'
                    && Array.isArray(u.items))) throw new Error('结构不符合');
                cachedUpdates = data;
                return data;
            })
            .catch(() => null) // 静默降级：调用方拿 null 走兜底提示
            .finally(() => { loading = null; });
    }
    return loading;
}

/** 渲染日志卡片列表；数据缺失时渲染单条兜底提示（不白屏） */
function renderCards(updates) {
    if (!updates) {
        return `
            <div class="log-card">
                <div class="log-card-header">
                    <span class="log-card-tag">—</span>
                </div>
                <div class="log-card-title">更新日志加载失败</div>
                <ul class="log-card-items">
                    <li>未读取到 changelog.json（file:// 双击打开时浏览器拦截本地请求；HTTP 部署需将该文件与页面放同目录）</li>
                </ul>
            </div>
        `;
    }
    return updates.map((u) => `
        <div class="log-card">
            <div class="log-card-header">
                <span class="log-card-tag">${u.tag}</span>
                <span class="log-card-date">${u.date}</span>
            </div>
            <div class="log-card-title">${u.title}</div>
            <ul class="log-card-items">
                ${u.items.map((i) => `<li>${i}</li>`).join('')}
            </ul>
        </div>
    `).join('');
}

function setupLogPanel() {
    // 双初始化防护：HMR 或重复调用时跳过
    if (document.getElementById('log-panel')) return;

    const btn = DOM.btnLogToggle;
    if (!btn) return;
    btn.style.cursor = 'pointer';

    const panel = document.createElement('div');
    panel.id = 'log-panel';
    panel.className = 'modal-overlay sheet';
    panel.innerHTML = `
        <div class="sheet-body">
            <div class="log-header">
                <span class="log-title">更新日志</span>
                <button class="log-close" id="log-close" aria-label="关闭">✕</button>
            </div>
            <div class="log-body"></div>
        </div>
    `;
    document.body.appendChild(panel);

    const body = panel.querySelector('.log-body');

    // 首次打开面板时才 fetch（懒加载）：单文件产物 file:// 双击场景不产生无谓失败请求
    let firstOpen = true;
    async function fillBody() {
        const updates = await loadUpdates();
        body.innerHTML = renderCards(updates);
    }

    // 遮罩点击关闭（与设置/词云/语音一致，统一 modal 行为）
    panel.addEventListener('click', (e) => { if (e.target === panel) closeAllModals(); });
    // Escape 关闭由 global.js 统一处理，不再注册面板级 Escape 监听

    const closeBtn = panel.querySelector('#log-close');

    btn.addEventListener('click', async () => {
        // 走统一模态体系：开时互斥关其它面板（修「日志+导航一起开」），并锁背景滚动
        if (getComputedStyle(panel).display !== 'none') { closeAllModals(); return; }
        if (firstOpen) { // 首开触发加载并渲染；后续开关直接用缓存，零请求
            firstOpen = false;
            await fillBody();
        }
        openModal('log-panel');
    });
    closeBtn.addEventListener('click', () => { closeAllModals(); });
}
