/**
 * 内置默认主题插件（仅作导出模板）
 *
 * 职责：提供当前界面的基础配色 Design Token，作为可导出模板存在。
 * exportOnly: true → 面板中只显示导出按钮、不渲染开关，也不参与挂载/卸载切换，
 * 避免对底层基础配色产生「关闭打开都不变」的空操作开关。
 *
 * 导出：DefaultThemePlugin
 * 依赖：无
 */

/** 默认主题插件对象 — ThemeEngine 注册的 'default_theme' 模板（不挂载）。 @type {object} */
export const DefaultThemePlugin = {
    meta: {
        // name: 字符串，主题在面板中显示的名称
        name: '默认主题',
        // exportOnly: 布尔标记。为 true 时该主题仅作为“可导出模板”存在（详见上方说明）。
        exportOnly: true,
        tokens: {
            '--color-bg': '#080b14',
            '--color-user': 'rgba(240, 208, 160, 0.95)',
            '--color-ai': 'rgba(170, 208, 160, 0.95)',
            '--color-accent': 'rgba(150, 220, 130, 0.9)',
            '--color-accent-soft': 'rgba(150, 220, 130, 0.15)',
            '--color-accent-bright': 'rgba(180, 240, 150, 0.9)',
            '--color-accent-solid': 'rgba(180, 240, 150, 1)',
            '--color-accent-glow': 'rgba(150, 220, 130, 0.5)',
            '--color-accent-dim': 'rgba(150, 220, 130, 0.3)',
            '--color-error': 'rgba(255, 100, 100, 0.9)',
            '--radius-sm': '4px',
            '--radius-md': '8px',
            '--radius-lg': '12px',
            '--input-ring-normal': 'rgba(200,220,180,.15)',
            '--input-ring-waiting': 'rgba(240, 180, 100, .25)',
            '--input-line': 'rgba(201,127,74,.6)',
            '--input-dot': 'rgba(212,163,115,.3)',
            '--input-text': 'rgba(240,208,160,.95)',
            '--input-cursor': 'rgba(240,208,160,.8)'
        }
    },
    onMount: function () {},
    onUnmount: function () {}
};
