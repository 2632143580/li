/**
 * 主题引擎（ThemeEngine）
 *
 * 职责：与 BgEngine 平行，专注 DOM/CSS 层：注入样式、覆盖 Design Token。
 *       无 Canvas、无 rAF 循环，挂载即生效，卸载即清理。
 *       插件接口：meta.cssText / meta.tokens / onMount / onUnmount。
 *       注入给用户插件的 state 是只读 Proxy，写入被拦截。
 *
 * 导出：ThemeEngine
 * 依赖：core/logger, core/state, core/dom, plugins/default-theme, ui/input-renderer（updateInputColors）
 */
import { Logger } from '../core/logger.js';
import { state } from '../core/store.js';
import { DOM } from '../core/dom.js';
import { DefaultThemePlugin } from '../plugins/default-theme.js';
import { updateInputColors } from '../ui/input-renderer.js';

/** 解析颜色亮度（0–255），支持 #rrggbb / #rgb / rgb(r,g,b)；用于判断主题深浅以加 theme-light 信号。
 *  内联实现以避免引入 quick-themes 的依赖（防止循环依赖），且与 quick-theme.js 的 getCssBrightness 阈值 150 保持一致。 */
function parseColorBrightness(color) {
    color = String(color).trim();
    let r, g, b;
    if (color.startsWith('#')) {
        let h = color.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
    } else {
        const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (!m) return 0;
        r = +m[1]; g = +m[2]; b = +m[3];
    }
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 依据当前已激活主题的背景明暗，给 <html> 加/去 theme-light class（驱动状态色双套系统翻转）。
 *  覆盖内置配色、自定义配色、未来导入式主题插件——它们是经 ThemeEngine.mount 统一入口挂载的，故在此处统一发信号（根因级，无需各组件打补丁）。 */
function syncThemeLightClass() {
    let isLight = false;
    for (const t of ThemeEngine.activeThemes) {
        const bg = t.themeObj.meta?.tokens?.['--color-bg'];
        if (bg && parseColorBrightness(bg) >= 150) { isLight = true; break; }
    }
    document.documentElement.classList.toggle('theme-light', isLight);
}

/** 主题引擎单例 @type {object} */
export const ThemeEngine = {
    /** 当前已激活的主题实例列表：{ id, themeObj, state } @type {Array<object>} */
    activeThemes: [],
    /** 已注册主题对象表：id → themeObj @type {object<string,object>} */
    availableThemes: {},

    /** 初始化引擎，注册内置 default_theme 模板 */
    init() {
        this.register('default_theme', DefaultThemePlugin);
        return this;
    },

    /** 注册主题到可用列表 @param {string} id @param {object} themeObj */
    register(id, themeObj) {
        this.availableThemes[id] = themeObj;
    },

    /** 激活主题 — 注入 CSS + 覆盖 Token */
    mount(id) {
        if (this.activeThemes.find(t => t.id === id)) return true;   // 已挂载视为成功
        const theme = this.availableThemes[id];
        if (!theme) {
            Logger.warn(`[ThemeEngine] 主题 "${id}" 不存在`);
            return false;   // 返回状态：调用方（applyPluginCode）据 false 判失败/回滚
        }

        const readOnlyState = new Proxy(state.settings, {
            set(target, prop, value) {
                Logger.warn(`[ThemeEngine] 主题 "${id}" 尝试修改只读状态 "${String(prop)}"，已拦截`);
                return true;
            }
        });

        const instance = { id, themeObj: theme, state: readOnlyState };

        // 1. 注入 CSS 文本 (纯净注入，不清洗：布局安全由导出模板的白名单契约约束)
        if (theme.meta?.cssText) {
            const styleEl = document.createElement('style');
            styleEl.id = `theme-css-${id}`;
            styleEl.textContent = theme.meta.cssText;
            document.head.appendChild(styleEl);
        }

        // 2. 覆盖 Design Token（CSS 变量）
        if (theme.meta?.tokens) {
            const root = document.documentElement;
            for (const [key, value] of Object.entries(theme.meta.tokens)) {
                root.style.setProperty(key, value);
            }
        }

        // 3. 调用 onMount 生命周期
        // 不再用 Logger.safe 吞掉 onMount 异常：吞错会让 applyPluginCode 误判成功、把脏主题推进 activeThemes 占槽。
        // 改为显式捕获并据真值上报，使导入流程能据 false 触发回滚。
        try {
            theme.onMount?.(DOM.bgDomLayer, instance.state);
        } catch (e) {
            Logger.error(`[ThemeEngine] 主题 onMount 失败：${e?.message || e}`);
            return false;   // 初始化失败：上报 false，调用方据以判失败并回滚
        }

        this.activeThemes.push(instance);
        // 标记已有主题激活：用于门控 waifu 默认绿底皮肤(让主题统一接管 waifu 气泡外观)
        document.body.classList.add('theme-active');
        syncThemeLightClass(); // 主题挂载后同步浅色信号（驱动状态色双套系统翻转）
        updateInputColors(); // 主题挂载后刷新输入框颜色缓存
        return true;
    },

    /** 停用主题 — 移除 CSS + 还原 Token */
    unmount(id) {
        const index = this.activeThemes.findIndex(t => t.id === id);
        if (index === -1) return;
        const instance = this.activeThemes[index];

        // 1. 移除注入的 <style> 标签
        const styleEl = document.getElementById(`theme-css-${id}`);
        if (styleEl) styleEl.remove();

        // 2. 移除覆盖的 Design Token
        if (instance.themeObj.meta?.tokens) {
            const root = document.documentElement;
            for (const key of Object.keys(instance.themeObj.meta.tokens)) {
                root.style.removeProperty(key);
            }
        }

        // 3. 调用 onUnmount 生命周期
        Logger.safe('ThemeEngine.onUnmount', () => instance.themeObj.onUnmount?.());

        this.activeThemes.splice(index, 1);
        // 仅当无任何主题残留时才移除激活标记，避免多个主题并存时误关门控
        if (this.activeThemes.length === 0) document.body.classList.remove('theme-active');
        syncThemeLightClass(); // 重新评估浅色信号（残留主题可能为深色）
        updateInputColors(); // 主题卸载后刷新输入框颜色缓存
    },

};
