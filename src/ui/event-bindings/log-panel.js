/**
 * 更新日志页（用户 2026-08-19 要求：展示版本更新时间线，结构化 / 清晰 / 简洁，非调试日志）。
 * 入口：右上顶栏最左的列表图标按钮。
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

/**
 * 更新日志数据源（手写 changelog，倒序：最新在上）。
 * 每条：tag（版本/阶段标识）、date、title、items（要点列表）。
 * @type {Array<{tag:string, date:string, title:string, items:string[]}>}
 */
const UPDATES = [
    {
        tag: '当前版本',
        date: '2026-08-20',
        title: '多会话 · 会话列表 · 会话级人设',
        items: [
            '【新增】多会话：消息导航面板改为「会话 / 消息」双 tab，支持新建 / 切换 / 重命名 / 长按删除',
            '【新增】后台继续生成：切换会话不打断 AI 回复，列表用打字点指示生成中，切回内容完整',
            '【新增】系统提示词会话级覆盖：改当前会话人设互不影响，可一键「设为全局默认」',
        ],
    },
    {
        tag: 'v2.3',
        date: '2026-08-18',
        title: '树形分支对话 · 多AI路由 · 插件系统',
        items: [
            '【新增】树形分支对话：左右滑动手势切换分支，分支导航 UI',
            '【新增】多AI路由：按 URL 自动匹配服务商，支持自定义 baseUrl',
            '【新增】背景/主题插件系统：Canvas 背景 + DOM 背景 + 主题 CSS 注入',
            '【优化】消息上下文菜单：SVG 图标 + 滑入动画 + 悬停右移',
        ],
    },
    {
        tag: 'v2.2',
        date: '2026-08-15',
        title: '语音条 · 沉浸式输入 · 性能监控',
        items: [
            '【新增】句句发语音条：AI 回复按句渲染为可点击播放的语音条',
            '【新增】Canvas 呼吸圆环输入交互（非传统 textarea）',
            '【新增】性能监控面板：token 用量 / 缓存命中 / 上下文占用圆环',
            '【优化】设置面板统一为底部抽屉 Bottom Sheet',
        ],
    },
    {
        tag: 'v2.1',
        date: '2026-08-10',
        title: '多主题 · 星空视差 · 词云分析',
        items: [
            '【新增】10 套主题色块选择器（深色/浅色双主题）',
            '【新增】星空视差背景：三层星点 + 五个呼吸光斑',
            '【新增】词云分析：轻量分词 + 专业 jieba 分词切换',
        ],
    },
];

function setupLogPanel() {
    // 双初始化防护：HMR 或重复调用时跳过
    if (document.getElementById('log-panel')) return;

    const btn = DOM.btnLogToggle;
    if (!btn) return;
    btn.style.cursor = 'pointer';

    const cards = UPDATES.map((u) => `
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

    const panel = document.createElement('div');
    panel.id = 'log-panel';
    panel.className = 'modal-overlay sheet';
    panel.innerHTML = `
        <div class="sheet-body">
            <div class="log-header">
                <span class="log-title">更新日志</span>
                <button class="log-close" id="log-close" aria-label="关闭">✕</button>
            </div>
            <div class="log-body">${cards}</div>
        </div>
    `;
    document.body.appendChild(panel);

    // 遮罩点击关闭（与设置/词云/语音一致，统一 modal 行为）
    panel.addEventListener('click', (e) => { if (e.target === panel) closeAllModals(); });
    // Escape 关闭由 global.js 统一处理，不再注册面板级 Escape 监听

    const closeBtn = panel.querySelector('#log-close');

    btn.addEventListener('click', () => {
        // 走统一模态体系：开时互斥关其它面板（修「日志+导航一起开」），并锁背景滚动
        if (getComputedStyle(panel).display !== 'none') closeAllModals();
        else openModal('log-panel');
    });
    closeBtn.addEventListener('click', () => { closeAllModals(); });
}
