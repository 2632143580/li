/**
 * 性能诊断模块（开发/调优用，非业务代码）
 *
 * 触发：URL 带 ?perf=1（main.js 动态 import），手机访问 http://<IP>:5173/?perf=1 即开启。
 * 职责：右下角悬浮面板，实时显示帧驱动源（FPS / 应用 rAF / clearRect / 运行动画 /
 *       backdrop-filter 残留 / 无限动画 / DOM 规模），并支持「测 3 秒」场景对比。
 *
 * 原理：包装 window.requestAnimationFrame 与 CanvasRenderingContext2D.prototype.clearRect
 *       计数（诊断自身 rAF 通过回调引用排除，不计入「应用 rAF」），getAnimations 枚举运行动画。
 * 注意：本模块不修改任何业务逻辑，仅观测；面板 DOM 全部带 perf- 前缀，避免与业务 id 冲突。
 */

/** 应用 rAF 计数（诊断自身循环不计） @type {number} */
let rafApp = 0;
/** 诊断自身的 rAF 回调引用（计数时跳过） @type {function|null} */
let diagCb = null;

(function patchCounters() {
    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb, ...rest) => {
        if (cb !== diagCb) rafApp++;
        return origRaf(cb, ...rest);
    };

    /** clearRect 计数（按 canvas id 分桶） @type {object<string, number>} */
    window.__perfCr = {};
    const origCr = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        const id = (this.canvas && this.canvas.id) || '?';
        window.__perfCr[id] = (window.__perfCr[id] || 0) + 1;
        return origCr.apply(this, args);
    };
})();

/** 面板根节点 @type {HTMLElement|null} */
let panel = null;
/** 实时行数据更新句柄 @type {number|null} */
let liveTimer = null;
/** FPS 滑动窗（最近 40 帧时间戳） @type {number[]} */
let frameTimes = [];
/** 诊断循环累计帧数（测量用；滑动窗满 40 帧后 length 不再增长，不能用 length 差算 FPS） @type {number} */
let diagFrames = 0;
/** 上次 FPS 采样点 @type {number} */
let lastFpsAt = 0;

/** 创建面板 DOM（幂等） @returns {void} */
function ensurePanel() {
    if (panel) return;
    const style = document.createElement('style');
    style.textContent = `
#perf-panel{position:fixed;right:12px;bottom:12px;z-index:99999;width:236px;max-height:72vh;
  background:rgba(10,12,18,.94);border:1px solid rgba(255,255,255,.14);border-radius:12px;
  color:#e8e8e8;font:11px/1.55 ui-monospace,'SF Mono',Menlo,Consolas,monospace;overflow:hidden;
  box-shadow:0 10px 34px rgba(0,0,0,.5)}
#perf-panel header{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;
  background:rgba(255,255,255,.06);font-weight:700;letter-spacing:1px;cursor:pointer}
#perf-panel header button{background:none;border:none;color:#8ab;font:inherit;cursor:pointer}
#perf-body{padding:8px 10px 10px;overflow-y:auto;max-height:62vh}
#perf-body .row{display:flex;justify-content:space-between;gap:8px}
#perf-body .row b{color:#ffd479}
#perf-panel table{width:100%;border-collapse:collapse;margin-top:6px;font-size:10px}
#perf-panel th,#perf-panel td{border-top:1px solid rgba(255,255,255,.08);padding:2px 4px;text-align:left;white-space:nowrap}
#perf-panel details{margin-top:6px}
#perf-panel summary{cursor:pointer;color:#8ab}
#perf-list{max-height:140px;overflow:auto;margin:4px 0 0;white-space:pre-wrap;color:#9fc}
#perf-measure{margin-top:8px;width:100%;padding:5px;border:1px solid rgba(255,255,255,.18);
  border-radius:8px;background:rgba(255,255,255,.08);color:#e8e8e8;font:inherit;cursor:pointer}
#perf-note{margin-top:6px;width:100%;box-sizing:border-box;padding:4px 6px;border-radius:6px;
  border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.25);color:#e8e8e8;font:inherit}
#perf-hist-empty{color:#667;padding:4px 0}
`;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'perf-panel';
    panel.innerHTML = `
<header><span>PERF DIAGNOSE</span><button id="perf-fold">收起</button></header>
<div id="perf-body">
  <div class="row"><span>FPS（滑动均值）</span><b id="perf-fps">-</b></div>
  <div class="row"><span>应用 rAF/s</span><b id="perf-raf">-</b></div>
  <div class="row"><span>canvas clearRect/s</span><b id="perf-cr">-</b></div>
  <div class="row"><span>运行中动画</span><b id="perf-anims">-</b></div>
  <div class="row"><span>backdrop-filter 残留</span><b id="perf-bf">-</b></div>
  <div class="row"><span>无限动画元素</span><b id="perf-inf">-</b></div>
  <div class="row"><span>DOM 元素</span><b id="perf-dom">-</b></div>
  <details><summary>运行动画明细</summary><pre id="perf-list"></pre></details>
  <button id="perf-measure">测 3 秒（当前场景）</button>
  <input id="perf-note" placeholder="备注，如：语音播放中 / 开设置" />
  <table id="perf-hist"></table>
  <div id="perf-hist-empty">尚未测量。切到目标场景后点「测 3 秒」。</div>
</div>`;
    document.body.appendChild(panel);

    const foldBtn = panel.querySelector('#perf-fold');
    const body = panel.querySelector('#perf-body');
    let folded = false;
    panel.querySelector('header').addEventListener('click', () => {
        folded = !folded;
        body.style.display = folded ? 'none' : '';
        foldBtn.textContent = folded ? '展开' : '收起';
    });
    panel.querySelector('#perf-measure').addEventListener('click', () => measure3s());
}

/** 读取当前运行中动画（排除诊断面板自身 transition） @returns {Array<object>} */
function runningAnims() {
    const list = [];
    for (const a of document.getAnimations ? document.getAnimations() : []) {
        if (a.playState !== 'running') continue;
        const el = a.effect && a.effect.target;
        if (!el || (el.closest && el.closest('#perf-panel'))) continue;
        const props = [];
        try {
            (a.effect.getKeyframes ? a.effect.getKeyframes() : []).forEach(k =>
                Object.keys(k).forEach(p => { if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p) && !props.includes(p)) props.push(p); }));
        } catch (e) { /* 忽略读取失败 */ }
        list.push({
            name: a.animationName || '(transition)',
            props: props.join(','),
            target: el.tagName + (el.className && el.className.toString ? '.' + String(el.className).split(' ')[0] : '')
        });
    }
    return list;
}

/** 扫描页面级性能隐患（backdrop-filter / 无限动画 / 大 Canvas / DOM 规模） @returns {object} */
function scanPage() {
    const all = document.querySelectorAll('*');
    let bf = 0, inf = 0, bigCanvas = [];
    for (const el of all) {
        if (el.closest && el.closest('#perf-panel')) continue;
        const cs = getComputedStyle(el);
        if (cs.backdropFilter && cs.backdropFilter !== 'none') bf++;
        if (cs.animationIterationCount === 'infinite') inf++;
    }
    for (const cv of document.querySelectorAll('canvas')) {
        if (cv.width > window.innerWidth / 2 && cv.height > window.innerHeight / 2) {
            bigCanvas.push(`${cv.id || '?'}:${cv.width}x${cv.height}`);
        }
    }
    return { bf, inf, bigCanvas: bigCanvas.join(' '), dom: all.length };
}

/** 实时刷新面板数据 @returns {void} */
function updateLive() {
    const fps = frameTimes.length >= 2
        ? (frameTimes.length - 1) / ((frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000) : 0;
    const rafSec = rafApp - lastRafMark;
    const crSec = totalCr() - lastCrMark;
    lastRafMark = rafApp;
    lastCrMark = totalCr();

    panel.querySelector('#perf-fps').textContent = fps.toFixed(0);
    panel.querySelector('#perf-raf').textContent = String(rafSec);
    panel.querySelector('#perf-cr').textContent = String(crSec);
    const anims = runningAnims();
    panel.querySelector('#perf-anims').textContent = String(anims.length);
    panel.querySelector('#perf-list').textContent = anims.length
        ? anims.map(a => `${a.name}(${a.props}) on ${a.target}`).join('\n') : '(无)';
    const scan = scanPage();
    panel.querySelector('#perf-bf').textContent = String(scan.bf);
    panel.querySelector('#perf-inf').textContent = String(scan.inf);
    panel.querySelector('#perf-dom').textContent = String(scan.dom);
}

/** 各 canvas clearRect 计数总和 @returns {number} */
function totalCr() {
    return Object.values(window.__perfCr).reduce((s, n) => s + n, 0);
}

/** 上一轮采样的计数基准 @type {number} */
let lastRafMark = 0;
/** 上一轮采样的 clearRect 基准 @type {number} */
let lastCrMark = 0;

/**
 * 「测 3 秒」：对当前场景采样 3s，汇总平均 FPS / raf/s / clearRect/s / 动画数，追加历史表。
 * @returns {void}
 */
function measure3s() {
    const btn = panel.querySelector('#perf-measure');
    const note = panel.querySelector('#perf-note').value.trim() || '（未备注）';
    btn.disabled = true;
    btn.textContent = '测量中…';

    const sRaf = rafApp;
    const sCr = totalCr();
    const sFrames = diagFrames;
    const sT = performance.now();

    setTimeout(() => {
        const dur = (performance.now() - sT) / 1000;
        const fps = (diagFrames - sFrames) / dur;
        const rafSec = (rafApp - sRaf) / dur;
        const crSec = (totalCr() - sCr) / dur;
        const anims = runningAnims().length;

        const hist = panel.querySelector('#perf-hist');
        const empty = panel.querySelector('#perf-hist-empty');
        if (empty) empty.remove();
        const row = document.createElement('tr');
        const now = new Date();
        const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        row.innerHTML = `<td>${time}</td><td>${note}</td><td>${fps.toFixed(0)}</td><td>${rafSec.toFixed(0)}</td><td>${crSec.toFixed(0)}</td><td>${anims}</td>`;
        hist.appendChild(row);

        btn.disabled = false;
        btn.textContent = '测 3 秒（当前场景）';
    }, 3000);
}

/** 启动：建面板、rAF 测 FPS、定时刷数据 @returns {void} */
export function startDiagnose() {
    ensurePanel();
    // 诊断自身 rAF 循环：测 FPS，且不计入 rafApp（patchCounters 通过 diagCb 引用跳过）
    diagCb = (t) => {
        const now = performance.now();
        diagFrames++;
        frameTimes.push(now);
        if (frameTimes.length > 40) frameTimes.shift();
        requestAnimationFrame(diagCb);
    };
    requestAnimationFrame(diagCb);
    liveTimer = setInterval(updateLive, 300);
}

// 模块加载即启动（main.js 在 ?perf=1 时动态 import 本模块）
startDiagnose();
