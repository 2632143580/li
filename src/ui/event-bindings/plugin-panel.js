/**
 * 背景插件面板事件绑定（Stage 3 解耦产出，原 bindPluginPanelEvents）。
 * 含背景图上传 + 缩放/移动裁剪编辑全套（applyBgTransform / mountImage / openCropEditor /
 * renderCropPreview / clampCrop / renderPluginList / createPluginItem 均为本函数体内嵌套函数）。
 * 模块级裁剪状态仅被本模块使用，原属 api.js，随 bindPluginPanelEvents 一并迁入。
 */
import { DOM } from '../../core/dom.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { Logger } from '../../core/logger.js';
import { state } from '../../core/store.js';
import { safeParseInt } from '../../core/utils.js';
import { saveToLocal } from '../../core/storage.js';
import { BgEngine } from '../../engines/bg-engine.js';
import { ThemeEngine } from '../../engines/theme-engine.js';
import { applyPluginCode } from '../../chat/api.js';

/** 已上传的原始背景图 dataURL @type {string|null} */
let bgOriginalSrc = null;
/** 编辑中的临时变换（缩放+平移，相对百分比，分辨率无关） @type {{scale:number,xPct:number,yPct:number}} */
let cropTmp = { scale: 1, xPct: 0, yPct: 0 };
/** 当前图片恰好铺满屏幕所需的缩放倍数（object-fit:contain 基准下；scale=此值即无黑边铺满） @type {number} */
let currentCoverRatio = 1;
/** 缩放上限 @type {number} */
let cropMaxScale = 4;
/** 裁剪基准量 @type {number} */
let cropContain = 1;
/** 原图宽 / 高 / 屏宽 / 屏高 @type {number} */
let cropNatW = 1, cropNatH = 1, cropScrW = 1, cropScrH = 1;
/** 编辑确认后的回调 @type {function|null} */
let cropConfirmCallback = null;

import { registerUI } from '../../core/registry.js';
registerUI('plugin-panel', bindPluginPanelEvents);

export function bindPluginPanelEvents() {
    DOM.btnBgPlugin.addEventListener('click', () => {
        renderPluginList();
        openModal('bg-modal');
    });
    DOM.bgModalClose.addEventListener('click', () => {
        closeAllModals();
    });
    DOM.bgModal.addEventListener('click', (e) => {
        if (e.target === DOM.bgModal) closeAllModals();
    });
    // 点击裁剪编辑器遮罩空白处 = 取消裁剪，返回背景管理面板（与 bg-modal 同款手势；曾缺失导致裁剪器只能靠按钮关）
    DOM.cropModal.addEventListener('click', (e) => {
        if (e.target === DOM.cropModal) closeAllModals(['bg-modal']);
    });

    // 导入代码插件 (自动识别背景/主题；支持一次多选多个文件批量导入)
    DOM.btnImportCode.addEventListener('click', () => DOM.fileImportCode.click());

    DOM.fileImportCode.addEventListener('change', async (e) => {
        // 先快照文件列表再清空：multiple 时可能多个；清空避免同文件二次选择不触发 change
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (files.length === 0) return;

        const readText = (file) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
            reader.readAsText(file);
        });

        // 逐个读取并导入，任一失败不影响其余；收集结果后统一汇报
        const results = await Promise.all(files.map(async (file) => {
            try {
                const codeString = await readText(file);
                const desc = applyPluginCode(codeString);
                return { name: file.name, ok: true, desc };
            } catch (err) {
                return { name: file.name, ok: false, msg: err.message };
            }
        }));

        renderPluginList();
        const okCount = results.filter(r => r.ok).length;
        const failed = results.filter(r => !r.ok);
        if (files.length === 1) {
            const r = results[0];
            if (r.ok) alert(r.desc);
            else { alert('插件导入失败: ' + r.msg); Logger.error('[Import] 插件导入失败', r.msg); }
        } else {
            let msg = `批量导入完成：${okCount}/${files.length} 个成功`;
            if (failed.length) msg += '\n失败：' + failed.map(f => `${f.name}（${f.msg}）`).join('；');
            alert(msg);
            if (failed.length) Logger.error('[Import] 批量导入部分失败', failed);
        }
    });

    // 解析+分发挂载逻辑已抽到模块级 applyPluginCode（文件导入、批量导入、沙盒 __loadPlugin 共用）

    // -------- 背景图片：上传 → 缩放/移动编辑（CSS 变换，保留 WebP 动画） --------
    const IMG_PLUGIN_ID = 'custom_image';

    // 将背景变换（缩放+平移，相对百分比）应用到 <img> 层；与编辑预览框共用同一变换，所见即所得
    function applyBgTransform(t) {
        DOM.bgImgLayer.style.transformOrigin = 'center center';
        DOM.bgImgLayer.style.transform = `scale(${t.scale}) translate(${t.xPct}%, ${t.yPct}%)`;
    }

    // 挂载图片插件（动画图由 <img> 原生播放；遮罩用 CSS 层；并应用已保存的缩放/平移）
    function mountImage(src) {
        const imgPlugin = {
            meta: { name: '本地图片背景' },
            init: function (ctx, W, H, state) {
                // 动画图由 <img> 层原生播放；遮罩改用独立 CSS 层，避免 Canvas 每帧 fillRect 导致掉帧
                DOM.bgImgLayer.src = src;
                DOM.bgImgLayer.style.display = 'block';
                // body 背景透明，让 z-index:-1 的 <img> 层可见
                document.body.style.background = 'transparent';
                // 应用已保存浓度：state 由 mount 注入（= 全局 state.settings），刷新后保留用户设置，无需再读闭包全局
                const opacity = (state && state.bgDimOpacity) ?? 0.4;
                // 遮罩用实底黑 + opacity（纯黑 opacity α == rgba(0,0,0,α) 视觉一致，但 opacity 走合成器、零重绘，
                // 滑块拖动/浓度变化不再触发全屏重绘——原 rgba 写法是「拖动遮罩滑块 77% GPU」的重绘来源）
                DOM.bgDimLayer.style.opacity = opacity;
                DOM.bgDimLayer.style.display = 'block';
                // 应用已保存的缩放/平移：同样来自注入的 state
                applyBgTransform(state.bgTransform || { scale: 1, xPct: 0, yPct: 0 });
            },
            // animate 置空：遮罩已是 CSS 合成层，无需 Canvas 每帧重绘（掉帧根因在此）
            animate: function () {},
            onUnmount: function () {
                // 卸载时隐藏 <img> 层与 CSS 遮罩层，恢复 body 底色
                DOM.bgImgLayer.style.display = 'none';
                DOM.bgImgLayer.removeAttribute('src');
                DOM.bgImgLayer.style.transform = ''; // 复位变换，下次挂载由 init 重新应用
                DOM.bgDimLayer.style.display = 'none';
                document.body.style.background = '';
            }
        };
        BgEngine.registerPlugin(IMG_PLUGIN_ID, imgPlugin);
        // 卸载所有现有插件（含 solid），因为 solid 画不透明底色会遮住 <img> 层
        [...BgEngine.activePlugins].forEach((p) => BgEngine.unmount(p.id));
        BgEngine.mount(IMG_PLUGIN_ID);
        renderPluginList();
        DOM.btnEditBg.disabled = false; // 已上传，允许再次编辑
    }

    // 打开缩放/移动编辑：预览框=屏幕比例，框内所见即最终背景
    function openCropEditor(src, onConfirm, fresh) {
        DOM.cropPreview.src = src;
        // 预览框按当前屏幕比例，保证预览与真实背景一致
        DOM.cropFrame.style.aspectRatio = (window.innerWidth / window.innerHeight).toFixed(4);
        const img = new Image();
        img.onload = () => {
            const cw = window.innerWidth, ch = window.innerHeight;
            const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
            const contain = Math.min(cw / nw, ch / nh); // 完整显示整张图所需缩放
            const cover = Math.max(cw / nw, ch / nh);   // 铺满屏幕所需缩放
            // 记录基准量，供逐轴钳制平移使用（按真实溢出而非「是否超过铺满点」判断，铺满态下溢出轴才可拖）
            cropContain = contain;
            cropNatW = nw; cropNatH = nh; cropScrW = cw; cropScrH = ch;
            currentCoverRatio = cover / contain;        // scale=此值时恰好铺满（无黑边）
            // 缩放上限：取「至少 4 倍」「铺满所需」「已保存值」三者最大，保证滑块/滚轮都能拉到目标且不越界
            cropMaxScale = Math.max(4, currentCoverRatio, (state.settings && state.settings.bgTransform && state.settings.bgTransform.scale) || 0);
            // 滑块是百分比域（min=100 即 scale=1）；上限必须换算成百分比，否则会出现 max<min 导致圆点锁死、无法拖动
            DOM.cropZoom.max = Math.ceil(cropMaxScale * 100);
            const saved = (state.settings && state.settings.bgTransform) || { scale: currentCoverRatio, xPct: 0, yPct: 0 };
            // 新上传默认铺满（符合背景预期）；再次编辑沿用已保存变换
            const startScale = fresh ? currentCoverRatio : (saved.scale || currentCoverRatio);
            cropTmp = {
                scale: startScale,
                xPct: fresh ? 0 : (saved.xPct || 0),
                yPct: fresh ? 0 : (saved.yPct || 0)
            };
            clampCrop();
            renderCropPreview();
        };
        img.src = src;
        cropConfirmCallback = onConfirm || null;
        openModal('crop-modal', 'bg-modal'); // crop 从 bg-modal 内打开，排除它保持底层面板开着
    }

    // 将 cropTmp 渲染到预览图（与真实背景同一变换）
    function renderCropPreview() {
        DOM.cropPreview.style.transformOrigin = 'center center';
        DOM.cropPreview.style.transform = `scale(${cropTmp.scale}) translate(${cropTmp.xPct}%, ${cropTmp.yPct}%)`;
        const z = Math.round(cropTmp.scale * 100);
        DOM.cropZoom.value = z;
        DOM.cropZoomVal.textContent = z + '%';
    }

    // 逐轴钳制平移：按图片在「该轴」实际覆盖屏幕的比例计算可平移量，
    // 任一轴有溢出即允许在该轴拖动（铺满态下非受限轴有溢出→可拖；完整态两轴均无溢出→不动）
    function clampCrop() {
        const s = cropTmp.scale;
        const wFill = s * (cropContain * cropNatW) / cropScrW; // 图片宽相对屏宽的覆盖比（effective scale = s*contain）
        const hFill = s * (cropContain * cropNatH) / cropScrH;
        const maxXPct = Math.max(0, (wFill - 1) / 2) / s * 100;
        const maxYPct = Math.max(0, (hFill - 1) / 2) / s * 100;
        cropTmp.xPct = Math.max(-maxXPct, Math.min(maxXPct, cropTmp.xPct));
        cropTmp.yPct = Math.max(-maxYPct, Math.min(maxYPct, cropTmp.yPct));
    }

    // 上传
    DOM.btnUploadImage.addEventListener('click', () => DOM.fileImportBgImage.click());
    DOM.fileImportBgImage.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            bgOriginalSrc = event.target.result; // 保存原始图，供再次编辑（不做 Canvas 重编码，保留动画）
            openCropEditor(bgOriginalSrc, () => mountImage(bgOriginalSrc), true);
            // 关掉底层面板但保留裁剪编辑器（crop-modal 已在 MODAL_IDS，直接全关会把裁剪器一起关掉）
            closeAllModals(['crop-modal']);
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // 编辑当前背景（缩放/移动）
    DOM.btnEditBg.addEventListener('click', () => {
        if (!bgOriginalSrc) return; // 无背景图时按钮禁用
        // 若图片插件未挂载（例如切到了其他背景），先挂载
        if (!BgEngine.activePlugins.find((p) => p.id === IMG_PLUGIN_ID)) {
            mountImage(bgOriginalSrc);
        }
        openCropEditor(bgOriginalSrc, null, false);
        closeAllModals();
    });

    // 缩放滑块
    DOM.cropZoom.addEventListener('input', () => {
        cropTmp.scale = safeParseInt(DOM.cropZoom.value, 100) / 100;
        clampCrop();
        renderCropPreview();
    });

    // 拖动平移
    let cropDrag = null;
    DOM.cropFrame.addEventListener('mousedown', (e) => {
        cropDrag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
        if (!cropDrag) return;
        const r = DOM.cropFrame.getBoundingClientRect();
        cropTmp.xPct += (e.clientX - cropDrag.x) / r.width * 100;
        cropTmp.yPct += (e.clientY - cropDrag.y) / r.height * 100;
        cropDrag.x = e.clientX;
        cropDrag.y = e.clientY;
        clampCrop();
        renderCropPreview();
    });
    window.addEventListener('mouseup', () => { cropDrag = null; });

    // 滚轮缩放
    DOM.cropFrame.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        const maxS = cropMaxScale;
        cropTmp.scale = Math.max(1, Math.min(maxS, cropTmp.scale + delta));
        clampCrop();
        renderCropPreview();
    }, { passive: false });

    // 触摸：单指平移、双指捏合缩放（适配手机端）
    let touchState = null;
    DOM.cropFrame.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
            const t = e.touches[0];
            touchState = { mode: 'pan', lastX: t.clientX, lastY: t.clientY };
        } else if (e.touches.length === 2) {
            const a = e.touches[0], b = e.touches[1];
            touchState = {
                mode: 'pinch',
                lastDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                lastMidX: (a.clientX + b.clientX) / 2,
                lastMidY: (a.clientY + b.clientY) / 2
            };
        }
    }, { passive: false });
    DOM.cropFrame.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (!touchState) return;
        const r = DOM.cropFrame.getBoundingClientRect();
        if (touchState.mode === 'pan' && e.touches.length === 1) {
            const t = e.touches[0];
            cropTmp.xPct += (t.clientX - touchState.lastX) / r.width * 100;
            cropTmp.yPct += (t.clientY - touchState.lastY) / r.height * 100;
            touchState.lastX = t.clientX;
            touchState.lastY = t.clientY;
            clampCrop();
            renderCropPreview();
        } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
            const a = e.touches[0], b = e.touches[1];
            const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
            const midX = (a.clientX + b.clientX) / 2;
            const midY = (a.clientY + b.clientY) / 2;
            const factor = dist / (touchState.lastDist || dist);
            const maxS = cropMaxScale;
            cropTmp.scale = Math.max(1, Math.min(maxS, cropTmp.scale * factor));
            cropTmp.xPct += (midX - touchState.lastMidX) / r.width * 100;
            cropTmp.yPct += (midY - touchState.lastMidY) / r.height * 100;
            touchState.lastDist = dist;
            touchState.lastMidX = midX;
            touchState.lastMidY = midY;
            clampCrop();
            renderCropPreview();
        }
    }, { passive: false });
    DOM.cropFrame.addEventListener('touchend', (e) => {
        e.preventDefault();
        if (e.touches.length === 0) {
            touchState = null;
        } else if (e.touches.length === 1) {
            // 双指松一指后切换回单指平移，避免跳变
            const t = e.touches[0];
            touchState = { mode: 'pan', lastX: t.clientX, lastY: t.clientY };
        }
    }, { passive: false });

    // 确认：保存变换并应用到真实背景
    DOM.cropConfirm.addEventListener('click', () => {
        state.settings.bgTransform = { scale: cropTmp.scale, xPct: cropTmp.xPct, yPct: cropTmp.yPct };
        applyBgTransform(state.settings.bgTransform);
        saveToLocal('背景已调整');
        closeAllModals(['bg-modal']);
        if (cropConfirmCallback) cropConfirmCallback();
    });

    // 取消：回退到编辑前的变换
    DOM.cropCancel.addEventListener('click', () => {
        applyBgTransform((state.settings && state.settings.bgTransform) || { scale: 1, xPct: 0, yPct: 0 });
        closeAllModals(['bg-modal']);
    });

    // 完整：scale=1 完整显示整张图（不丢内容，可能有黑边）
    DOM.cropReset.addEventListener('click', () => {
        cropTmp = { scale: 1, xPct: 0, yPct: 0 };
        renderCropPreview();
    });
    // 填充：缩放至恰好铺满屏幕（等效旧 cover 效果，无黑边）
    DOM.cropFit.addEventListener('click', () => {
        cropTmp.scale = currentCoverRatio;
        cropTmp.xPct = 0;
        cropTmp.yPct = 0;
        renderCropPreview();
    });

    // 渲染插件列表到管理面板（背景区 + 主题区）
    function renderPluginList() {
        // --- 背景插件区 ---
        DOM.pluginListContainer.innerHTML = '';
        for (const id in BgEngine.availablePlugins) {
            const plugin = BgEngine.availablePlugins[id];
            const isActive = BgEngine.activePlugins.find(p => p.id === id);
            DOM.pluginListContainer.appendChild(createPluginItem(id, plugin, isActive, 'bg'));
        }

        // --- 主题插件区 ---
        if (DOM.themeListContainer) {
            DOM.themeListContainer.innerHTML = '';
            for (const id in ThemeEngine.availableThemes) {
                // 快速配色（内置 quick_theme_ + 自定义 custom_theme_）是宿主配色系统功能，不占用「主题插件栈」可视化槽位（有自己的色块入口）
                if (id.startsWith('quick_theme_') || id.startsWith('custom_theme_')) continue;
                const theme = ThemeEngine.availableThemes[id];
                const isActive = ThemeEngine.activeThemes.find(t => t.id === id);
                DOM.themeListContainer.appendChild(createPluginItem(id, theme, isActive, 'theme'));
            }
        }
    }

    // 生成插件项 DOM（含导出按钮与开关）
    function createPluginItem(id, plugin, isActive, type) {
        const item = document.createElement('div');
        item.className = 'plugin-item';

        const header = document.createElement('div');
        header.className = 'plugin-header';

        const nameWrap = document.createElement('div');
        nameWrap.style.display = 'flex';
        nameWrap.style.flexDirection = 'column';
        nameWrap.style.gap = '2px';

        const name = document.createElement('div');
        name.className = 'plugin-name';
        name.textContent = plugin.meta?.name || id;
        nameWrap.appendChild(name);

        if (plugin.getStatusText) {
            const statusText = document.createElement('div');
            statusText.className = 'plugin-status-text';
            statusText.style.fontSize = '10px';
            statusText.style.color = isActive ? 'var(--color-accent)' : 'var(--white-a30)';
            statusText.textContent = plugin.getStatusText(state);
            nameWrap.appendChild(statusText);
        }
        header.appendChild(nameWrap);

        const actions = document.createElement('div');
        actions.className = 'plugin-actions';

        // 仅当插件非 exportOnly 时渲染开关；exportOnly 为主题模板，无开关意义
        const isExportOnly = !!plugin.meta?.exportOnly;
        if (!isExportOnly) {
            // 开关
            const toggleLabel = document.createElement('label');
            toggleLabel.className = 'toggle-switch';
            const toggleInput = document.createElement('input');
            toggleInput.type = 'checkbox';
            toggleInput.checked = !!isActive;
            toggleInput.onchange = () => {
                if (toggleInput.checked) {
                    if (type === 'bg') BgEngine.mount(id);
                    else if (type === 'theme') ThemeEngine.mount(id);
                } else {
                    if (type === 'bg') BgEngine.unmount(id);
                    else if (type === 'theme') ThemeEngine.unmount(id);
                }
                renderPluginList();
            };
            const toggleSpan = document.createElement('span');
            toggleSpan.className = 'toggle-slider';
            toggleLabel.appendChild(toggleInput);
            toggleLabel.appendChild(toggleSpan);
            actions.appendChild(toggleLabel);
        }

        header.appendChild(actions);
        item.appendChild(header);
        return item;
    }
}
