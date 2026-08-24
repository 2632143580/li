/**
 * 背景插件面板事件绑定（Stage 3 解耦产出，原 bindPluginPanelEvents）。
 * 现含两大部分：
 *  1) 背景/主题插件栈开关列表（renderPluginList / createPluginItem）
 *  2) 背景管理（多图库 + AI 触发词）：上传 / 列表 / 触发词编辑 / 删除 / 固定 / 清除 / 存储提示
 * 裁剪编辑器（缩放/移动）保留，复用共享 bg-image 的 mountImage。
 *
 * 依赖：core/dom, core/modal, core/store, core/utils, core/storage, core/toast, core/idb,
 *       engines/bg-engine, engines/theme-engine, ui/bg-image
 */
import { DOM } from '../../core/dom.js';
import { openModal, closeAllModals } from '../../core/modal.js';
import { state } from '../../core/store.js';
import { safeParseInt } from '../../core/utils.js';
import { saveToLocal } from '../../core/storage.js';
import { showToast } from '../../core/toast.js';
import { BgEngine } from '../../engines/bg-engine.js';
import { ThemeEngine } from '../../engines/theme-engine.js';
import {
    putImage, deleteImage, getAllImagesMeta, getImage, getSetting, putSetting, defaultSettings
} from '../../core/idb.js';
import {
    currentBgSrc, mountImage, clearBackground, applyBgTransform, applyBlob
} from '../../ui/bg-image.js';

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
/** 被选中的卡片 id 集合（缩略图点击仅选中、不立即应用，避免误覆盖固定背景）。 @type {Set<string>} */
const selectedIds = new Set();
/** 背景指示器自动隐藏定时器句柄（短暂确认后淡出，非长驻） @type {number|null} */
let indicatorHideTimer = null;

import { registerUI } from '../../core/registry.js';
registerUI('plugin-panel', bindPluginPanelEvents);

export function bindPluginPanelEvents() {
    DOM.btnBgPlugin.addEventListener('click', () => {
        // 每次打开面板重置批量选择与输入，避免上一轮残留选中误导
        selectedIds.clear();
        DOM.bgBatchWords.value = '';
        renderPluginList();
        renderBgLibrary();
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

    // ---------- 背景管理：上传 / 模式 / 固定 / 清除 ----------
    DOM.btnUploadBgImg.addEventListener('click', () => DOM.fileImportBgImage.click());
    DOM.fileImportBgImage.addEventListener('change', onUploadBgImages);

    // 匹配模式：自绘分段按钮（禁用原生 select，符合项目 UI 铁律）；点哪个立即生效
    const modeItems = DOM.bgModeSelect.querySelectorAll('.segmented__item');
    function syncModeButtons(mode) {
        modeItems.forEach((b) => b.classList.toggle('segmented__item--active', b.dataset.mode === mode));
    }
    modeItems.forEach((b) => {
        b.addEventListener('click', async () => {
            const mode = b.dataset.mode;
            const s = (await getSetting()) || defaultSettings();
            s.globalMode = mode;
            await putSetting(s);
            syncModeButtons(mode);
        });
    });

    DOM.btnBgPin.addEventListener('click', onPin);
    DOM.btnBgClear.addEventListener('click', onClear);
    DOM.btnBgCleanOld.addEventListener('click', onCleanOld);

    // 批量加词：输入词 + 选中多图 → 一次应用到全部选中图（免逐张填写）
    DOM.btnBgBatchApply.addEventListener('click', onBatchAddWords);
    DOM.bgBatchWords.addEventListener('input', syncBatchApplyState);
    DOM.bgBatchWords.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onBatchAddWords(); // 输入直达：回车即应用（内部有空的选中/无词守卫）
    });

    // 清除批量选中：清空选中集合并重建卡片（同时刷新状态行与「清除选中」按钮可见性）
    DOM.btnBgClearSel.addEventListener('click', () => {
        selectedIds.clear();
        renderBgLibrary();
    });

    // -------- 裁剪编辑器（缩放/移动编辑，复用共享 mountImage） --------
    const IMG_PLUGIN_ID = 'custom_image';

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

    // 编辑当前背景（缩放/移动）
    DOM.btnEditBg.addEventListener('click', () => {
        if (!currentBgSrc) return; // 无背景图时按钮禁用
        // 若图片插件未挂载（例如切到了其他背景），先挂载
        if (!BgEngine.activePlugins.find((p) => p.id === IMG_PLUGIN_ID)) {
            mountImage(currentBgSrc);
        }
        openCropEditor(currentBgSrc, null, false); // openCropEditor 内部已 openModal('crop-modal','bg-modal')，保持底层 bg-modal 开着，切勿再 closeAllModals 否则把刚开的裁剪器也关掉
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
        if (e.touches.length === 1) {
            const t = e.touches[0];
            cropDrag = { startX: t.clientX, startY: t.clientY };
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

    // 生成插件项 DOM（名称/状态 + 挂载开关）
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

        // 挂载/卸载开关（全部已注册插件均有；无主题模板例外——default_theme 导出模板已于 2026-08-24 移除）
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

        header.appendChild(actions);
        item.appendChild(header);
        return item;
    }

    // ============================================================
    // 背景管理（多图库 + AI 触发词）
    // ============================================================

    /** 生成小缩略图 dataURL（上传时调用，列表只渲缩略图不解码原图，满足"列表<1s"）。svg 无尺寸则回退原 blob url。 */
    function makeThumb(blob, max = 240) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                const nw = img.naturalWidth || img.width || 0;
                const nh = img.naturalHeight || img.height || 0;
                if (!nw || !nh) { URL.revokeObjectURL(url); resolve(url); return; } // svg 无尺寸 → 退回原 url
                const scale = Math.min(1, max / Math.max(nw, nh));
                const w = Math.max(1, Math.round(nw * scale));
                const h = Math.max(1, Math.round(nh * scale));
                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                const ctx = cv.getContext('2d');
                try { ctx.drawImage(img, 0, 0, w, h); }
                catch (_) { URL.revokeObjectURL(url); resolve(url); return; }
                try {
                    const t = cv.toDataURL('image/png');
                    URL.revokeObjectURL(url);
                    resolve(t);
                } catch (_) { URL.revokeObjectURL(url); resolve(url); }
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    }

    /** 渲染背景库（列表 + 存储提示 + 按钮可用态） */
    async function renderBgLibrary() {
        const meta = await getAllImagesMeta();
        const settings = (await getSetting()) || defaultSettings();
        syncModeButtons(settings.globalMode || 'exact');
        DOM.bgImgGrid.innerHTML = '';
        for (const m of meta) {
            DOM.bgImgGrid.appendChild(createBgCard(m, settings));
        }
        updateStorageInfo(meta);
        const hasCurrent = !!settings.currentId || BgEngine.activePlugins.find(p => p.id === IMG_PLUGIN_ID);
        DOM.btnBgPin.disabled = !settings.currentId;
        DOM.btnBgClear.disabled = !hasCurrent;
        DOM.btnEditBg.disabled = !currentBgSrc;
        syncBatchApplyState();
    }

    /** 构建单张图卡片 */
    function createBgCard(m, settings) {
        const isActive = m.id === settings.currentId;
        const isPinned = m.id === settings.pinnedId;
        const card = document.createElement('div');
        card.className = 'bg-card'
            + (isActive ? ' active' : '')
            + (isPinned ? ' pinned' : '');

        const thumb = document.createElement('img');
        thumb.className = 'bg-card-thumb';
        thumb.src = m.thumb || '';
        thumb.alt = m.name;
        thumb.title = '点击选中（不立即应用，用「应用」按钮切换背景）';
        if (selectedIds.has(m.id)) card.classList.add('selected');
        // 缩略图点击仅选中高亮，不立即应用——避免误覆盖当前/固定背景（bug：缩略图切换即应用会破坏固定）
        thumb.addEventListener('click', () => toggleSelect(card, m.id));
        card.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'bg-card-info';
        const name = document.createElement('div');
        name.className = 'bg-card-name';
        name.textContent = m.name + (isPinned ? '（已固定）' : '');
        info.appendChild(name);

        const time = document.createElement('div');
        time.className = 'bg-card-time';
        time.textContent = new Date(m.uploadedAt).toLocaleString();
        info.appendChild(time);

        // 「当前使用」标识：圆角矩形包裹的对号徽标，右对齐（替代原先不显眼的行内小对号）
        if (isActive) {
            const badge = document.createElement('span');
            badge.className = 'bg-card-badge';
            badge.textContent = '✓';
            info.appendChild(badge);
        }

        // 触发词编辑（逗号/换行分隔多个）
        const tw = document.createElement('textarea');
        tw.className = 'bg-card-words';
        tw.placeholder = '触发词，逗号/换行分隔';
        tw.value = m.triggerWords || '';
        tw.addEventListener('change', () => updateTriggerWords(m.id, tw.value));
        info.appendChild(tw);

        card.appendChild(info);

        const acts = document.createElement('div');
        acts.className = 'bg-card-acts';
        const applyBtn = document.createElement('button');
        applyBtn.className = 'fs-btn';
        applyBtn.textContent = '应用';
        applyBtn.addEventListener('click', () => applyImageById(m.id));
        const delBtn = document.createElement('button');
        delBtn.className = 'fs-btn';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => deleteImageById(m.id));
        acts.appendChild(applyBtn);
        acts.appendChild(delBtn);
        card.appendChild(acts);

        return card;
    }

    /** 更新存储用量提示；接近需求容量下限时显示"清理最旧"入口 */
    function updateStorageInfo(meta) {
        const total = meta.reduce((s, m) => s + (m.size || 0), 0);
        const mb = (total / 1024 / 1024).toFixed(1);
        const capMB = 372; // 背景图存储上限（约值，原需求按 62×6MB 估算）
        let info = `背景图已用 ${mb} MB / 上限约 ${capMB} MB`;
        const near = total > capMB * 1024 * 1024 * 0.94;
        if (near) info += '（即将占满，可清理最旧图片）';
        DOM.bgStorageInfo.textContent = info;
        DOM.btnBgCleanOld.style.display = near ? 'block' : 'none';
    }

    /** 上传多图：校验类型/可渲染，生成缩略图，入库；首张立即设为当前背景 */
    async function onUploadBgImages(e) {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        let added = 0, skipped = 0;
        let firstId = null, firstName = null;
        for (const file of files) {
            const okType = /image\/(png|jpeg|webp|svg\+xml)/.test(file.type)
                || /\.(png|jpe?g|webp|svg)$/i.test(file.name);
            if (!okType) { skipped++; continue; }
            const thumb = await makeThumb(file); // 无法渲染（损坏）→ null，跳过
            if (!thumb) { skipped++; continue; }
            const id = 'bg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            await putImage({
                id,
                name: file.name,
                type: file.type || 'image',
                size: file.size,
                uploadedAt: Date.now(),
                triggerWords: '',
                thumb,
                blob: file
            });
            added++;
            if (!firstId) { firstId = id; firstName = file.name; }
        }
        if (firstId) {
            const rec = await getImage(firstId);
            if (rec) {
                await applyBlob(rec.blob); // 立即预览首张（保留旧"上传即见"）
                const s = (await getSetting()) || defaultSettings();
                s.currentId = firstId;
                await putSetting(s);
                setIndicator(firstName);
            }
        }
        await renderBgLibrary();
        if (skipped) showToast(`已添加 ${added} 张，跳过 ${skipped} 张（格式不支持或图片损坏）`, 'warn');
        else if (added) showToast(`已添加 ${added} 张背景图`, 'info');
    }

    /** 手动应用某张图为背景 */
    async function applyImageById(id) {
        const rec = await getImage(id);
        if (!rec) return;
        await applyBlob(rec.blob);
        const s = (await getSetting()) || defaultSettings();
        s.currentId = id;
        await putSetting(s);
        await renderBgLibrary();
        setIndicator(rec.name);
    }

    /** 更新某图的触发词（change 时落库，无需防抖） */
    async function updateTriggerWords(id, value) {
        const rec = await getImage(id);
        if (!rec) return;
        rec.triggerWords = value;
        await putImage(rec); // 覆盖同 id
    }

    /** 删除某图：其触发词随记录一起消失（需求三十二）；若删的是当前/固定则清显示 */
    async function deleteImageById(id) {
        const s = (await getSetting()) || defaultSettings();
        const wasCurrent = s.currentId === id;
        const wasPinned = s.pinnedId === id;
        await deleteImage(id);
        if (wasCurrent || wasPinned) clearBackground(); // 卸载 + 隐藏图层
        s.currentId = wasCurrent ? null : s.currentId;
        s.pinnedId = wasPinned ? null : s.pinnedId;
        await putSetting(s);
        await renderBgLibrary();
        setIndicator(null);
    }

    /** 固定当前背景（锁定，AI 触发不再覆盖） */
    async function onPin() {
        const s = (await getSetting()) || defaultSettings();
        if (!s.currentId) return;
        s.pinnedId = s.currentId;
        await putSetting(s);
        await renderBgLibrary();
        setIndicatorName(s.currentId);
    }

    /** 清除背景 + 解除固定/当前 */
    async function onClear() {
        clearBackground();
        const s = (await getSetting()) || defaultSettings();
        s.pinnedId = null;
        s.currentId = null;
        await putSetting(s);
        await renderBgLibrary();
        setIndicator(null);
    }

    /** 清理最旧的一张图（存储接近上限时的兜底入口） */
    async function onCleanOld() {
        const meta = await getAllImagesMeta();
        if (!meta.length) return;
        const oldest = meta[0]; // 已按上传时间升序
        await deleteImageById(oldest.id);
        showToast('已清理最旧图片：' + oldest.name, 'info');
    }

    // ---------- 小工具 ----------
    /** 缩略图点击：仅切换卡片选中高亮，不立即应用（避免误覆盖固定背景）。 */
    function toggleSelect(card, id) {
        if (selectedIds.has(id)) { selectedIds.delete(id); card.classList.remove('selected'); }
        else { selectedIds.add(id); card.classList.add('selected'); }
        syncBatchApplyState();
    }

    /**
     * 按触发词分隔规则解析输入（与单图 textarea / AI 匹配引擎同一套规则）。
     * @param {string} input
     * @returns {string[]} 去空白后的非空词条
     */
    function parseWords(input) {
        return String(input || '').split(/[,\n，]/).map((s) => s.trim()).filter(Boolean);
    }

    /**
     * 把新词合并进已有触发词串：词条级去重（与已有完全相同的词不重复添加），统一用半角逗号重排。
     * @param {string} existing - 已有触发词串（可为空）
     * @param {string[]} words - 待添加的词条
     * @returns {string}
     */
    function mergeWords(existing, words) {
        const set = new Set(parseWords(existing));
        for (const w of words) set.add(w);
        return [...set].join(',');
    }

    /** 刷新批量区块可用态与状态行（选中数 + 是否有输入词决定按钮是否可用）。 */
    function syncBatchApplyState() {
        const n = selectedIds.size;
        const hasWords = parseWords(DOM.bgBatchWords.value).length > 0;
        DOM.btnBgBatchApply.disabled = !(n > 0 && hasWords);
        DOM.btnBgClearSel.style.display = n > 0 ? '' : 'none';
        if (!n) DOM.bgBatchStatus.textContent = '点缩略图选中图片（可多选）';
        else if (!hasWords) DOM.bgBatchStatus.textContent = `已选 ${n} 张图，输入触发词后可批量添加`;
        else DOM.bgBatchStatus.textContent = `已选 ${n} 张图，点「应用词到选中图」批量添加`;
    }

    /** 批量添加触发词：把输入词合并进每张选中图的 triggerWords（词条级去重），完成后清输入、保留选中。 */
    async function onBatchAddWords() {
        const words = parseWords(DOM.bgBatchWords.value);
        const ids = [...selectedIds];
        if (!words.length || !ids.length) return;
        let changed = 0;
        for (const id of ids) {
            const rec = await getImage(id);
            if (!rec) continue;
            const merged = mergeWords(rec.triggerWords || '', words);
            if (merged !== (rec.triggerWords || '')) {
                rec.triggerWords = merged;
                await putImage(rec);
                changed++;
            }
        }
        DOM.bgBatchWords.value = '';
        await renderBgLibrary(); // 重建卡片让各图 textarea 显示合并后的词；选中态由 selectedIds 恢复
        showToast(changed > 0 ? `已添加触发词到 ${changed} 张图` : '所选图片已包含这些触发词，无需重复添加', changed > 0 ? 'info' : 'warn');
    }

    /**
     * 更新背景指示器：短暂显示"背景：NAME"后自动淡出（约 2.5s），非长驻。
     * 此前设计为长驻导致"背景：X"永久贴在屏幕上（用户反馈「toast 一直不消失」），
     * 故改为短暂确认提示。
     * @param {string|null} name
     */
    function setIndicator(name) {
        const el = DOM.bgCurrentIndicator;
        if (!el) return;
        if (indicatorHideTimer) { clearTimeout(indicatorHideTimer); indicatorHideTimer = null; }
        if (name) {
            el.textContent = '背景：' + name;
            el.classList.add('show');
            indicatorHideTimer = setTimeout(() => {
                el.classList.remove('show');
                indicatorHideTimer = null;
            }, 2500);
        } else {
            el.classList.remove('show');
        }
    }
    async function setIndicatorName(id) {
        const meta = await getAllImagesMeta();
        const m = meta.find((x) => x.id === id);
        setIndicator(m ? m.name : null);
    }
}
