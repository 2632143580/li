/**
 * 插件速测沙盒（开发用）
 *
 * 解决用户的真实痛点：写插件时不用再走"建文件 → 重命名 → 启动 → 点导入 → 找目录 → 看效果"的体力循环。
 * 直接把 AI 给的插件代码字符串喂给 applyPluginCode，跳过文件系统，1 秒出结果。
 * 同时显示中文归因日志（解析类型 / 通配符告警 / 未命中气泡钩子告警），把"检查 bug + 想归因"自动化。
 *
 * 入口（已并入背景管理模态框「代码级操作」组，不再有独立浮层）：
 *   1. 左上角「背景插件」图标 → 打开 bg-modal → 在「代码级操作」组粘贴代码 → 「装载」按钮
 *   2. 快捷键 `（反引号）直接打开 bg-modal（不自动聚焦文本框，避免手机弹输入法）
 *   3. 控制台可直接 __loadPlugin(代码字符串)
 */
import { applyPluginCode } from '../chat/api.js';

/**
 * 初始化速测沙盒：绑定模态框内的文本框与按钮，挂载 window.__loadPlugin。
 * 必须在 DOM 就绪后调用（main.js init 内调用）。
 */
export function initPluginSandbox() {
    const textarea = document.getElementById('ps-code');
    const logEl = document.getElementById('ps-log');
    const loadBtn = document.getElementById('ps-load');
    const clearBtn = document.getElementById('ps-clear');
    if (!textarea || !logEl || !loadBtn || !clearBtn) return;

    const renderLogs = (logs) => {
        logEl.innerHTML = '';
        for (const { lvl, msg } of logs) {
            const line = document.createElement('div');
            line.className = 'ps-line ps-' + lvl;
            const prefix = lvl === 'error' ? '[错误] ' : lvl === 'warn' ? '[警告] ' : '[成功] ';
            line.textContent = prefix + msg;
            logEl.appendChild(line);
        }
        logEl.scrollTop = logEl.scrollHeight;
    };

    const run = (code) => {
        const logs = [];
        try {
            const desc = applyPluginCode(code, (lvl, msg) => logs.push({ lvl, msg }));
            logs.push({ lvl: 'info', msg: desc });
        } catch (e) {
            logs.push({ lvl: 'error', msg: e.message });
        }
        renderLogs(logs);
    };

    // 暴露全局，供控制台直接调用：__loadPlugin(代码字符串)
    window.__loadPlugin = (code) => run(code);

    loadBtn.addEventListener('click', () => run(textarea.value));
    clearBtn.addEventListener('click', () => { textarea.value = ''; logEl.innerHTML = ''; });

    // 快捷键：反引号 ` 打开背景管理模态框（输入框聚焦时不抢键；不自动聚焦文本框，避免手机弹输入法）
    document.addEventListener('keydown', (e) => {
        if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') return;
            e.preventDefault();
            // 复用「背景插件」图标的既有处理器（renderPluginList + openModal），不重复实现
            const bgBtn = document.getElementById('btn-bg-plugin');
            if (bgBtn) bgBtn.click();
        }
    });
}
