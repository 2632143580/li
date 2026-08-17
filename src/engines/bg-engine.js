/**
 * 背景插件引擎（BgEngine）
 *
 * 职责：管理 Canvas 背景动画插件的注册与生命周期。每个插件独立 state，互不干扰。
 *       插件接口：init / animate / onMount / onUnmount / onMessage / onKeydown。
 *       DOM 型插件（type:'dom'）挂载到专属 DOM 层 bg-dom-layer，不进 Canvas rAF 循环。
 *       注入给用户插件的 state 是只读 Proxy，任何写入尝试被拦截并告警。
 *
 * 导出：BgEngine
 * 依赖：core/logger, core/state, core/dom
 */
import { Logger } from '../core/logger.js';
import { state } from '../core/store.js';
import { DOM, W, H } from '../core/dom.js';

/** 背景插件引擎单例 @type {object} */
export const BgEngine = {
    /** 背景画布元素（由 init 注入） @type {HTMLCanvasElement|null} */
    canvas: null,
    /** 背景画布 2D 上下文 @type {CanvasRenderingContext2D|null} */
    ctx: null,
    /** rAF 句柄，null 表示无活动循环 @type {number|null} */
    animationId: null,
    /** 当前已激活的插件实例列表：{ id, pluginObj, state, domNodes? } @type {Array<object>} */
    activePlugins: [],
    /** 已注册但未必激活的插件对象表：id → pluginObj @type {object<string,object>} */
    availablePlugins: {},
    /** 引擎级 DOM 引用（body / chat / hiddenInput），供插件 onMount 使用 @type {object} */
    domRefs: {},

    /** 初始化引擎，绑定 Canvas 与 DOM 引用（内置 star 插件已移除：满屏动画 Canvas 是移动端 GPU 大面开销根因，背景现由纯 CSS 底色兜底，零持续动画）*/
    init(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.domRefs = {
            body: document.body,
            chat: DOM.chat,
            hiddenInput: DOM.hiddenInput
        };
        this.setupOverlayWatch();
        return this;
    },

    /**
     * 侦测「任意全屏遮罩是否打开」，用于冻结背景动画循环（零视觉损失 + 消除整屏模糊重算）。
     * 用 MutationObserver 监听 DOM 显示状态变化，与模态框开关路径完全解耦——
     * 项目里很多关闭路径直接 `el.style.display='none'`（settings/plugin-panel/tts/wordcloud 等），
     * 并不走 closeAllModals，所以不能依赖某个开关函数去维护标志，必须自己侦测真实 DOM 状态。
     * 真值只在脏标记时重算（最多每帧一次），避免流式期间频繁属性变更带来的开销。
     * @returns {void}
     */
    setupOverlayWatch() {
        this.overlayOpen = false;
        this.overlayDirty = true;
        const overlays = '.modal-overlay, #fs-editor';
        const recompute = () => {
            this.overlayDirty = true;
        };
        if (typeof MutationObserver !== 'undefined') {
            this._overlayMO = new MutationObserver(recompute);
            this._overlayMO.observe(document.documentElement, {
                subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'class']
            });
        }
        this._computeOverlayOpen = () => {
            const els = document.querySelectorAll(overlays);
            for (const el of els) {
                if (getComputedStyle(el).display !== 'none') return true;
            }
            return false;
        };
    },

    /** 按脏标记惰性重算遮罩状态（避免高频属性变更时反复 getComputedStyle） @returns {void} */
    refreshOverlayState() {
        if (this.overlayDirty) {
            this.overlayOpen = this._computeOverlayOpen();
            this.overlayDirty = false;
        }
    },

    /** 注册插件到可用列表 @param {string} id @param {object} pluginObj */
    registerPlugin(id, pluginObj) {
        this.availablePlugins[id] = pluginObj;
    },

    /** 激活插件 — 若已激活则跳过 */
    mount(id) {
        if (this.activePlugins.find(p => p.id === id)) return;
        const plugin = this.availablePlugins[id];
        if (!plugin) {
            Logger.warn(`[BgEngine] 插件 "${id}" 不存在`);
            return false;   // 返回状态：调用方（applyPluginCode）据 false 判失败/回滚
        }
        // 注入全局 state.settings 的只读代理给插件，防止插件直接修改污染全局状态
        const readOnlyState = new Proxy(state.settings, {
            set(target, prop, value) {
                Logger.warn(`[BgEngine] 插件 "${id}" 尝试修改只读状态 "${String(prop)}"，已拦截`);
                return true; // 拦截写入，返回 true 避免严格模式报错打断插件运行
            }
        });

        const instance = { id, pluginObj: plugin, state: readOnlyState };
        this.activePlugins.push(instance);

        // DOM 背景插件：挂载到专属 DOM 层，不进入 Canvas 渲染循环
        if (plugin.type === 'dom') {
            // 记录 onMount 前专属背景层的子节点集合，用于卸载时兜底清理：
            // 防止插件 onUnmount 未清理其注入节点(如浮动光斑)导致"关不掉、背景残留"。
            const beforeNodes = new Set(DOM.bgDomLayer.children);
            // 不再用 Logger.safe 吞掉 onMount 异常：吞错会让调用方（applyPluginCode）误判成功、
            // 把"半初始化脏实例"推进 activePlugins 占槽。改为显式捕获并据真值上报。
            try {
                plugin.onMount?.(DOM.bgDomLayer, instance.state);
            } catch (e) {
                Logger.error(`[BgEngine] DOM 背景 onMount 失败：${e?.message || e}`);
                return false;   // 初始化失败：上报 false，调用方据以判失败并回滚
            }
            const afterNodes = new Set(DOM.bgDomLayer.children);
            instance.domNodes = [...afterNodes].filter(n => !beforeNodes.has(n));
            return true;
        }

        // Canvas 型：onMount + init 任一抛错都视为挂载失败。
        // 旧实现分两处 Logger.safe 各自吞错 → init 抛错被静默、mount 不抛 → 调用方拿到"假成功"、
        // 脏实例进 activePlugins。现显式捕获并据真值上报，使 applyPluginCode 能据 false 触发回滚。
        try {
            plugin.onMount?.(this.domRefs, instance.state);
            plugin.init?.(this.ctx, W, H, instance.state);
        } catch (e) {
            Logger.error(`[BgEngine] 背景插件初始化失败（onMount/init 抛错）：${e?.message || e}`);
            return false;   // 初始化失败：上报 false，调用方据以判失败并回滚
        }
        if (!this.animationId) this.startLoop();
        return true;
    },

    /** 停用插件 — 清理状态并可能停止渲染循环 */
    unmount(id) {
        const index = this.activePlugins.findIndex(p => p.id === id);
        if (index === -1) return;
        const instance = this.activePlugins[index];

        // 重要：plugin 是 mount 的局部变量，unmount 作用域只有 instance，必须用 instance.pluginObj
        if (instance.pluginObj.type === 'dom') {
            Logger.safe('BgEngine.onUnmount(DOM)', () => instance.pluginObj.onUnmount?.(DOM.bgDomLayer, instance.state));
            // 兜底清理：移除本插件在 onMount 时注入到专属背景层的节点，
            // 即使插件自身 onUnmount 未清理，也保证"关掉后无背景残留"(不留残留物原则)。
            if (Array.isArray(instance.domNodes)) {
                instance.domNodes.forEach(n => { if (n.parentNode === DOM.bgDomLayer) n.remove(); });
            }
        } else {
            Logger.safe('BgEngine.onUnmount', () => instance.pluginObj.onUnmount?.(this.domRefs, instance.state));
        }

        // 不再无条件重置 body 的 cursor/background：这是引擎越权清理，会抹掉 custom_image 在
        // init 时设的 transparent，导致跨配色切换(卸载背景插件)时图片背景被关。body 副作用应由
        // 插件自管(custom_image 的 onUnmount 已恢复为 ''），引擎不碰外部 DOM。
        this.activePlugins.splice(index, 1);

        // 仅当无任何 Canvas 插件时停止渲染循环(DOM 插件不参与 Canvas 循环)
        const hasCanvasPlugin = this.activePlugins.some(p => p.pluginObj.type !== 'dom');
        if (!hasCanvasPlugin && this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
            this.ctx.clearRect(0, 0, W, H);
        }
    },

    /** 启动渲染循环 — 每帧调用所有活跃插件的 animate */
    startLoop() {
        // 节流目标帧率：背景动画是缓变装饰，无需跟随 60/120Hz 屏幕刷新率全速重绘。
        // 移动端常态把填充率开销直接减半（60→30fps），肉眼几乎无差别。
        const targetFps = 30;
        const minDelta = 1000 / targetFps;
        let last = -Infinity;
        const loop = (t) => {
            // 冻结条件：① 页面不可见（切后台/锁屏）整轮跳过，避免后台空转；
            // ② 全屏遮罩打开——遮罩背后背景动画完全不可见，且遮罩带整屏 backdrop-filter 模糊，
            //    背景动画每帧变动会逼浏览器每帧重算模糊（常态 GPU 占大头却看不见的「大面」开销）。
            //    冻结后模糊只算一次，零视觉损失。遮罩状态由 MutationObserver 惰性侦测（见 setupOverlayWatch）。
            // 两种情况下都保留画布最后一帧（不 clearRect），恢复时立即接着画。
            this.refreshOverlayState();
            const blocked = document.hidden || this.overlayOpen;
            if (!blocked && t - last >= minDelta) {
                last = t;
                this.ctx.clearRect(0, 0, W, H);
                for (const p of this.activePlugins) {
                    Logger.safe('BgEngine.animate', () => p.pluginObj.animate?.(this.ctx, W, H, t, p.state));
                }
            }
            this.animationId = requestAnimationFrame(loop);
        };
        this.animationId = requestAnimationFrame(loop);
    },


    /** 向所有活跃插件广播消息事件 @param {string} role @param {string} text */
    triggerMessage(role, text) {
        for (const p of this.activePlugins) {
            Logger.safe('BgEngine.onMessage', () => p.pluginObj.onMessage?.(role, text, p.state, this.ctx, W, H));
        }
    },

    /** 向所有活跃插件广播键盘事件 @param {KeyboardEvent} e */
    triggerKeydown(e) {
        for (const p of this.activePlugins) {
            Logger.safe('BgEngine.onKeydown', () => p.pluginObj.onKeydown?.(e, p.state, this.ctx, W, H));
        }
    }
};
