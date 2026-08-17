/**
 * 共享背景应用层（背景图库 / UI 触发 / 手动上传 共用，消除三处重复）
 *
 * 职责：把"一张图片作为聊天背景"这件事收敛到唯一实现——注册 custom_image 插件、卸载其它背景插件
 *   （solid 等不透明底色会遮住 img 层）、显示 img/遮罩层、应用已保存浓度与变换。裁剪编辑器与
 *   AI 触发器都只调用这里的 mountImage / clearBackground，不再各自造一套。
 *
 * 导出：currentBgSrc, mountImage, clearBackground, applyBgTransform, pinBackground, unpinBackground
 * 依赖：core/dom, core/store, core/storage, engines/bg-engine
 */
import { DOM } from '../core/dom.js';
import { state } from '../core/store.js';
import { saveToLocal } from '../core/storage.js';
import { BgEngine } from '../engines/bg-engine.js';

/** 当前生效背景的源（object URL 或 dataURL），供裁剪编辑器复用。切换/清除时同步更新。 @type {string|null} */
export let currentBgSrc = null;

/** 当前由本模块创建的 object URL（用于下次切换时 revoke，避免内存泄漏）。 @type {string|null} */
let currentObjectUrl = null;

/** 将背景变换（缩放+平移，相对百分比）应用到 <img> 层；与裁剪预览框共用同一变换，所见即所得。 */
export function applyBgTransform(t) {
    DOM.bgImgLayer.style.transformOrigin = 'center center';
    DOM.bgImgLayer.style.transform = `scale(${t.scale}) translate(${t.xPct}%, ${t.yPct}%)`;
}

/**
 * 把一张图片设为背景。
 * @param {string} src - 图片源（object URL 或 dataURL）
 */
export function mountImage(src) {
    currentBgSrc = src;
    const imgPlugin = {
        meta: { name: '本地图片背景' },
        init: function (ctx, W, H, pluginState) {
            DOM.bgImgLayer.src = src;
            DOM.bgImgLayer.style.display = 'block';
            document.body.style.background = 'transparent';
            // 应用已保存浓度（来自 state.settings，刷新后保留用户设置）
            const opacity = (pluginState && pluginState.bgDimOpacity) ?? 0.4;
            DOM.bgDimLayer.style.opacity = opacity;
            DOM.bgDimLayer.style.display = 'block';
            // 应用已保存的缩放/平移
            applyBgTransform(pluginState.bgTransform || { scale: 1, xPct: 0, yPct: 0 });
        },
        // animate 置空：遮罩已是 CSS 合成层，无需 Canvas 每帧重绘
        animate: function () {},
        onUnmount: function () {
            DOM.bgImgLayer.style.display = 'none';
            DOM.bgImgLayer.removeAttribute('src');
            DOM.bgImgLayer.style.transform = '';
            DOM.bgDimLayer.style.display = 'none';
            document.body.style.background = '';
        }
    };
    BgEngine.registerPlugin('custom_image', imgPlugin);
    // 卸载所有现有背景插件（含 solid）：避免不透明底色遮挡 img 层
    [...BgEngine.activePlugins].forEach((p) => BgEngine.unmount(p.id));
    BgEngine.mount('custom_image');
}

/** 清除背景：卸载 custom_image、隐藏图层、复位 body 底色与固定状态。 */
export function clearBackground() {
    const existing = BgEngine.activePlugins.find((p) => p.id === 'custom_image');
    if (existing) BgEngine.unmount('custom_image');
    DOM.bgImgLayer.style.display = 'none';
    DOM.bgImgLayer.removeAttribute('src');
    DOM.bgImgLayer.style.transform = '';
    DOM.bgDimLayer.style.display = 'none';
    document.body.style.background = '';
    currentBgSrc = null;
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
    }
    state.settings.bgPinnedId = null;
    saveToLocal('背景已清除');
}

/**
 * 切换背景到指定 Blob（供 AI 触发器调用）：建 object URL → mountImage → 记录以便后续回收。
 * @param {Blob} blob - 原图 Blob
 * @returns {Promise<void>}
 */
export async function applyBlob(blob) {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(blob);
    mountImage(currentObjectUrl);
}

/** 固定当前背景（锁定，AI 触发不再覆盖）。 @param {string} id */
export function pinBackground(id) {
    state.settings.bgPinnedId = id;
    saveToLocal('背景已固定');
}

/** 取消固定。 */
export function unpinBackground() {
    state.settings.bgPinnedId = null;
    saveToLocal('已取消固定');
}
