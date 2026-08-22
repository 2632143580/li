/**
 * 思维链图标插件：love.svg（左）+ 心电图 Canvas（右）并排，纯图标无文字。
 *
 * 100% 还原用户上传的两个文件（2026-08-22）：
 *   1) love-svg.txt —— 几何原样保留（100×100 viewBox、爱心/心电折线 path、stroke-width 4 / round 端点）；
 *      颜色改为委托 rk-love-* 主题令牌（heart=主题色、line=底块同色镂空、surface=主题背景），随深浅主题自适应，不再写死黑/白。
 *   2) 心电图canvas-html.txt —— 监护仪核心视觉：网格背景（大格 50px / 小格 10px 双色层）+
 *      发光扫描波形（lineWidth 2.2 / shadowBlur 10 / #00ffaa）+ 扫描线遮罩（40px 黑色渐隐条）。
 *      绘制算法（getVoltage 的 P-QRS-T 波形函数、相位推进、回扫清残留的清除策略）逐行照搬原文件。
 *
 * 两个组件，关系必须分清（用户强调）：
 *   ① love.svg（buildLoveSvg）—— 几何原样（100×100 viewBox、爱心 path + 其内部爱心折线 path）。
 *      爱心 + 它里面的折线是「一体」的，恒显，不受任何开关控制。
 *   ② 心电图 canvas 监护仪波形（buildEcgMonitorSvg）—— 纯波形动画。
 *      这才是用户口头说的「心电图」；它受 showEcgWave 开关控制（关 → 只留爱心）。
 *   两者都在 .reasoning-toggle（flex）内并排；tree-render 直接 buildLoveSvg() + (开关?)buildEcgMonitorSvg() 组合，
 *      不再经任何「组合/兼容」导出（已删，避免把爱心与波形再绑死）。
 *
 * 动画：Canvas 不能只靠 innerHTML 字符串，渲染层设置 innerHTML 后须调用 initEcgHeartCanvases(scope)
 *   启动 rAF 循环（tree-render 已接入）。循环内部每帧自检 canvas.isConnected，DOM 重建后旧循环自动停，
 *   无泄漏。prefers-reduced-motion 时不跑循环，一次性静态铺满整幅波形。
 *
 * 情绪挂钩：emotion → 原文件的模式调制（getVoltage 的 mode 分支 + 非正常模式变琥珀色 #ffbb33）：
 *   calm→normal / excited→tachycardia / sad→bradycardia / thinking→arrhythmia。
 *
 * 依赖：无（Canvas 2D）
 */

/** love-svg.txt 原始两元素（100% 还原，顺序与属性不变）：爱心 path + 其内部爱心折线 path。 */
const LOVE_HEART_PATH = 'M 50 30 C 50 25, 40 10, 25 20 C 10 30, 10 50, 30 65 C 40 75, 50 85, 50 85 C 50 85, 60 75, 70 65 C 90 50, 90 30, 75 20 C 60 10, 50 25, 50 30 Z';
const LOVE_ECG_PATH = 'M 22 45 L 32 45 L 38 25 L 45 65 L 50 45 L 78 45';

/** emotion → 心电图 canvas 模式（对应原文件 getVoltage 的 mode 参数）。 */
const EMOTION_TO_MODE = {
    calm: 'normal',
    excited: 'tachycardia',
    sad: 'bradycardia',
    thinking: 'arrhythmia'
};

/**
 * love.svg 组件（恒显）：love-svg.txt 几何原样（100×100 viewBox、爱心/心电折线 path、round 端点）。
 * 颜色不写死，改由 .rk-love-* class 走 rk-love-* 主题令牌（chat.css 定义），随深浅主题自适应：
 *   surface=主题背景、heart=主题色、line=底块同色镂空刻进爱心（深浅皆可见）。
 * 这是「爱心 + 它里面的折线」——它俩是一体的，恒显，不受 showEcgWave 开关控制。
 * @returns {string} 内联 SVG 字符串
 */
export function buildLoveSvg() {
    return '<svg class="rk-love-ico" viewBox="0 0 100 100" aria-hidden="true" focusable="false">'
        + '<rect class="rk-love-bg" width="100" height="100" />'
        + '<path class="rk-love-heart" d="' + LOVE_HEART_PATH + '" />'
        + '<path class="rk-love-ecg" d="' + LOVE_ECG_PATH + '" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />'
        + '</svg>';
}

/**
 * 心电图（用户说的「心电图」= 波形）监护仪组件：网格背景 + canvas + 扫描线遮罩。
 * 结构与 class 与原文件一一对应（grid-background / ecgCanvas / scan-line），动画由 initEcgHeartCanvases 启动。
 * 这一块受 showEcgWave 开关控制（关 → 不渲染，只留爱心）。
 * @param {string} [emotion='calm'] 情绪键（映射到原文件的 normal/tachycardia/bradycardia/arrhythmia）
 * @returns {string} HTML 字符串
 */
export function buildEcgMonitorSvg(emotion = 'calm') {
    return '<span class="rk-ecg-mon" data-emotion="' + emotion + '">'
        + '<span class="rk-ecg-grid"></span>'
        + '<canvas class="rk-ecg-cv"></canvas>'
        + '<span class="rk-ecg-scan"></span>'
        + '</span>';
}

/**
 * 启动 scope 内所有心电图 canvas 的 rAF 循环（算法逐行还原自 心电图canvas-html.txt）。
 * 幂等：同一 canvas 只启动一次；DOM 重建产生新 canvas，旧循环因 !isConnected 自动退出。
 * @param {ParentNode} [scope=document] 搜索范围
 */
export function initEcgHeartCanvases(scope = document) {
    scope.querySelectorAll('canvas.rk-ecg-cv').forEach((canvas) => {
        if (canvas._rkEcgInited) return;
        canvas._rkEcgInited = true;
        startEcgLoop(canvas);
    });
}

/* ================= 以下为原文件 IIFE 的忠实移植（仅做组件化适配） ================= */

function startEcgLoop(canvas) {
    const ctx = canvas.getContext('2d', { alpha: true });
    const container = canvas.parentElement;          // .rk-ecg-mon
    const scanLineEl = container.querySelector('.rk-ecg-scan');
    const mode = EMOTION_TO_MODE[container.dataset.emotion] || 'normal';

    // 波形颜色走主题令牌（随深浅主题自适应）：正常=主题色 --color-accent，异常=警告色 --status-warn（双套翻转）。
    // 读取最终色值（rgba 字面量），fallback 保留原监护仪绿/琥珀，避免令牌缺失时掉色。
    let ecgColor = '#00ffaa';
    function refreshEcgColor() {
        const cs = getComputedStyle(document.documentElement);
        const accent = cs.getPropertyValue('--color-accent').trim();
        const warn = cs.getPropertyValue('--status-warn').trim();
        ecgColor = mode === 'normal'
            ? (accent || '#00ffaa')
            : (warn || '#ffbb33');
    }

    // 状态（照搬原文件）
    let x = 0;
    let lastY = 0;
    let lastTime = performance.now();
    let phase = 0;                                    // 心跳相位 (0-100)

    // 配置（原字面值 = 600px 宽参照下的取值；小尺寸下按宽度等比换算，见 resizeCanvas）
    let baseSpeed = 2;
    let scanBarWidth = 40;
    let clearMargin = 4;

    function setupContext() {
        refreshEcgColor();                       // 每次重建/换肤都取最新主题色
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // 尺寸适配（非字面还原，已实测必要）：原文件 lineWidth=2.2 / shadowBlur=10
        // 按 168px 高的监视器设计（线/辉光各占高 1.3%/6%）。图标尺寸（20px）下若照搬字面值，
        // Chrome 的 shadowBlur 随 ctx.scale(dpr) 放大，辉光占满半个画布把波形糊成实心色块
        // （已用像素转储实测证实）。故按原文件的视觉比例换算，并在大尺寸下收敛回原字面值。
        const h = canvas.getBoundingClientRect().height || 20;
        ctx.lineWidth = Math.min(2.2, Math.max(1, h * 0.013));
        ctx.strokeStyle = ecgColor;
        ctx.shadowBlur = Math.min(10, h * 0.06);
        ctx.shadowColor = ecgColor;
    }

    // 主题切换（<html> 的 class/style 变化：theme-light 翻转 / 插件覆盖令牌）时，实时刷新波形颜色。
    // 不每帧取，只在主题变动时触发；canvas 断开即停观察，无泄漏。
    const themeObserver = new MutationObserver(() => { refreshEcgColor(); setupContext(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    // ========== Canvas 尺寸适配（原文件 resizeCanvas） ==========
    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const rect = container.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';

        // 尺寸适配（同 lineWidth/shadowBlur 的等比换算，600px 宽 = 原文件参照，此时收敛回字面值 2/40/4）：
        // 若照搬字面速度 2px/帧，600px 原版一次扫描 5s、迷你条 96px 只要 0.8s——回扫节奏快 6 倍，
        // 波形拍密度与「监护仪式」的时间感全失（已实测）。等比换算后：扫描耗时恒 5s、
        // 每屏拍数恒 ~1.2（与原版一致），只是整体缩小。
        const kw = rect.width / 600;
        baseSpeed = 2 * kw;
        scanBarWidth = 40 * kw;
        clearMargin = 4 * kw;

        setupContext();
        x = 0;
        // 重置 lastY 到中线，避免回扫后异常连线
        lastY = rect.height / 2;
        ctx.clearRect(0, 0, rect.width, rect.height);
        return true;
    }

    // ========== 波形生成（原文件 getVoltage，逐行照搬） ==========
    function getVoltage(p) {
        let v = 0;

        // 呼吸 / 肌电噪声
        v += Math.sin(p * 0.5) * 0.04;
        v += (Math.random() - 0.5) * 0.025;

        // P 波 (心房去极化)
        if (p > 10 && p < 20) {
            v += 0.15 * Math.sin((p - 10) * Math.PI / 10);
        }
        // QRS 波群
        else if (p >= 34 && p < 36) {
            v -= 0.15 * (p - 34) / 2;
        } else if (p >= 36 && p < 39) {
            v += 1.0;
        } else if (p >= 39 && p < 42) {
            v -= 0.25;
        }
        // T 波 (心室复极化)
        else if (p > 55 && p < 80) {
            v += 0.25 * Math.sin((p - 55) * Math.PI / 25);
        }

        // 模式调制
        switch (mode) {
            case 'tachycardia':
                v *= 1.1;
                break;
            case 'bradycardia':
                v *= 0.9;
                break;
            case 'arrhythmia':
                if (Math.random() > 0.92) v *= 1.5;
                if (Math.random() > 0.96) v = 0;
                break;
            default:
                break;
        }

        return v;
    }

    // ========== 核心绘制循环（原文件 draw，含回扫清残留修复，逐行照搬） ==========
    function draw(timestamp) {
        // DOM 已被重建/移除 → 自动退出循环，并停主题观察，无泄漏
        if (!canvas.isConnected) { themeObserver.disconnect(); return; }

        const delta = timestamp - lastTime;
        lastTime = timestamp;

        // 逻辑尺寸
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.width / dpr;
        const height = canvas.height / dpr;
        const centerY = height / 2;

        const speed = baseSpeed;
        const phaseStep = 0.4 *
            (mode === 'tachycardia' ? 1.5 :
                mode === 'bradycardia' ? 0.7 :
                mode === 'arrhythmia' ? (Math.random() > 0.95 ? 0.15 : 1.0) :
                1.0);

        // 更新相位
        phase += phaseStep;
        if (phase > 100) phase = 0;

        const voltage = getVoltage(phase);
        const scaleY = height * 0.25;
        const nextY = centerY - voltage * scaleY;

        const nextX = x + speed;

        // ---------- 清除策略 ----------
        // 正常情况：清除扫描线前方区域（即将被覆盖）
        // 回扫时：清除左侧从 0 到回扫后新位置的旧波形
        if (nextX > width) {
            // ---- 回扫 ----
            // 1) 先绘制到右边缘
            ctx.beginPath();
            ctx.moveTo(x, lastY);
            ctx.lineTo(width, nextY);
            ctx.stroke();

            // 2) 清除左侧旧波形 (关键修复)
            const newX = nextX - width; // 回扫后新的 x 位置
            const clearEnd = Math.min(newX + scanBarWidth + speed + clearMargin, width);
            ctx.clearRect(0, 0, clearEnd, height);

            // 3) 重置状态，从基线开始
            x = 0;
            lastY = centerY;

            // 4) 开始新路径，绘制从 0 到 speed 的线段（让波形立即接续）
            ctx.beginPath();
            ctx.moveTo(0, centerY);
            // 计算回扫后第一个点的电压（使用当前 phase）
            const firstVoltage = getVoltage(phase);
            const firstY = centerY - firstVoltage * scaleY;
            ctx.lineTo(speed, firstY);
            ctx.stroke();

            // 更新 lastY 为第一个点的 Y
            lastY = firstY;
            x = speed;

            // 同步扫描线位置
            scanLineEl.style.transform = 'translateX(' + x + 'px)';

            requestAnimationFrame(draw);
            return;
        }

        // ---- 正常绘制 (nextX <= width) ----
        // 清除扫描线前方的旧波形
        const clearX = nextX + scanBarWidth;
        if (clearX < width) {
            ctx.clearRect(clearX, 0, speed + clearMargin, height);
        }

        // 绘制连线
        ctx.beginPath();
        ctx.moveTo(x, lastY);
        ctx.lineTo(nextX, nextY);
        ctx.stroke();

        // 更新状态
        x = nextX;
        lastY = nextY;

        // 同步扫描线
        scanLineEl.style.transform = 'translateX(' + x + 'px)';

        requestAnimationFrame(draw);
    }

    // ========== 初始化（原文件 init 的组件化版本） ==========
    if (!resizeCanvas()) {
        // 容器尚未有尺寸（如 display:none）：等 ResizeObserver 报尺寸后再启动
        const ro = new ResizeObserver(() => {
            if (resizeCanvas()) {
                ro.disconnect();
                scanLineEl.style.transform = 'translateX(0px)';
                requestAnimationFrame(draw);
            }
        });
        ro.observe(container);
        return;
    }

    scanLineEl.style.transform = 'translateX(0px)';

    // prefers-reduced-motion：不跑循环，静态铺满一整幅波形
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.width / dpr;
        const height = canvas.height / dpr;
        const centerY = height / 2;
        const scaleY = height * 0.25;
        let px = 0, py = centerY, pp = 0;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        while (px < width) {
            pp += 0.4;
            if (pp > 100) pp = 0;
            px += baseSpeed;
            ctx.lineTo(px, centerY - getVoltage(pp) * scaleY);
        }
        ctx.stroke();
        themeObserver.disconnect();             // 静态路径不跑循环，此处显式停观察
        return;
    }

    requestAnimationFrame(draw);
}
