/**
 * 禁止词引擎 UI（轻量气泡版，副作用模块——import 即完成 DOM 创建与事件绑定）
 *
 * 职责：右下角（输入框右侧）极简入口图标 → 轻量气泡配置面板（词库 + 前缀模板）；
 *       AI 回复命中时弹触发提示条，点「应用前缀」直接把前缀预填进输入框供用户编辑。
 *       全程无模态框遮挡、不侵入发送逻辑（前缀只是普通文本进输入框，发什么就是什么）。
 *
 * 导出：无（副作用导入）
 * 依赖：engines/moderator-engine、core/bus、core/dom、ui/input-manager、ui/input-renderer
 */
import { moderator } from '../engines/moderator-engine.js';
import { bus, EVENTS } from '../core/bus.js';
import { DOM } from '../core/dom.js';
import { inputManager } from './input-manager.js';
import { inputRenderer } from './input-renderer.js';

// ============ 样式（就近内联，不拆 style 文件——单文件构建下 style.css 会被整体内联，此处也遵循同样做法） ============
const style = document.createElement('style');
style.textContent = `
    /* 右下角入口图标（紧贴输入框右侧，bottom 与输入框基线对齐附近；与全屏编辑器入口 fs-trigger-btn 水平错开不重叠）
       主题阶：--white-aXX 深色=白 alpha / 浅色=黑 alpha，跟随主题自动翻转（禁硬编码字面量） */
    #mod-trigger-btn {
        position: fixed; bottom: 15px; right: 50px;
        width: 24px; height: 24px; color: var(--white-a60);
        cursor: pointer; z-index: 10; display: flex; align-items: center; justify-content: center;
    }
    #mod-trigger-btn:hover { color: var(--white-a90); }
    /* 轻量气泡配置面板：固定定位浮于输入框上方，非模态不遮全屏（背景/文字全部走主题变量，深浅自动适配） */
    #mod-pop {
        position: fixed; bottom: 45px; right: 10px;
        width: 280px; background: var(--bg-select); color: var(--white-a90);
        border: 1px solid var(--white-a10); border-radius: 8px; padding: 12px;
        z-index: 20; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        display: none; flex-direction: column; gap: 10px;
    }
    #mod-pop.show { display: flex; }
    #mod-pop textarea {
        width: 100%; background: var(--white-a03); color: inherit;
        border: 1px solid var(--white-a10); border-radius: 4px; padding: 6px;
        box-sizing: border-box; font-size: 13px; resize: none; font-family: inherit;
    }
    #mod-pop .mod-label { font-size: 12px; color: var(--white-a50); margin-bottom: 2px; display:block; }
    #mod-pop .mod-actions { display: flex; justify-content: space-between; align-items: center; }
    #mod-pop .mod-save { background: var(--color-accent); color: var(--color-bg); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    /* 触发提示条：命中时浮在气泡上方，含「应用前缀」与「关闭」两个动作 */
    #mod-hint {
        position: fixed; bottom: 65px; right: 10px;
        background: var(--color-user-bright); color: var(--color-bg); border-radius: 8px; padding: 6px 10px;
        font-size: 12px; display: none; align-items: center; gap: 8px;
        z-index: 15; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    #mod-hint.show { display: flex; }
    #mod-hint .mh-apply { background: var(--status-error); color: var(--white-a95); border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-weight: bold; }
    #mod-hint .mh-close { background: transparent; border: none; color: inherit; cursor: pointer; font-size: 14px; padding: 0; line-height: 1; }
`;
document.head.appendChild(style);

// ============ DOM 结构 ============
// 入口图标：圆圈 + 斜杠（禁止语义），线条最少
const btn = document.createElement('div');
btn.id = 'mod-trigger-btn';
btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="6" y1="18" x2="18" y2="6"></line></svg>`;
document.body.appendChild(btn);

// 气泡配置面板：两个 textarea（词库批量粘贴 / 前缀模板）+ 保存按钮 + 词数统计
const pop = document.createElement('div');
pop.id = 'mod-pop';
pop.innerHTML = `
    <div>
        <label class="mod-label">禁止词/句 (逗号或换行分隔)</label>
        <textarea id="mod-words-input" rows="4" placeholder="输入词句，换行或逗号分隔"></textarea>
    </div>
    <div>
        <label class="mod-label">前缀模板 (可用 {words} 代指命中的词)</label>
        <textarea id="mod-prefix-input" rows="3"></textarea>
    </div>
    <div class="mod-actions">
        <span style="font-size: 10px; opacity: 0.5;">已记录 <span id="mod-count"></span> 个词</span>
        <button class="mod-save" id="mod-save-btn">保存</button>
    </div>
`;
document.body.appendChild(pop);

// 触发提示条：展示命中词 + 应用/关闭按钮
const hint = document.createElement('div');
hint.id = 'mod-hint';
hint.innerHTML = `
    <span>触发: <span id="mod-hit-words" style="color:#d20; font-weight:bold;"></span></span>
    <button class="mh-apply">应用前缀</button>
    <button class="mh-close">&times;</button>
`;
document.body.appendChild(hint);

// ============ 逻辑绑定 ============
/** 最近一次命中的词条（「应用前缀」按钮读取用） @type {Array<{word:string, count:number}>} */
let lastHits = [];

// 打开气泡：同步词库与模板到输入框，然后切换显示
btn.onclick = () => {
    document.getElementById('mod-words-input').value = moderator.getWordsString();
    document.getElementById('mod-prefix-input').value = moderator.prefixTemplate;
    document.getElementById('mod-count').textContent = moderator.words.length;
    pop.classList.toggle('show');
};

// 保存：批量解析词库 → 存模板 → 刷新计数并关闭气泡
document.getElementById('mod-save-btn').onclick = () => {
    const wordsText = document.getElementById('mod-words-input').value;
    moderator.syncWordsByText(wordsText);
    moderator.prefixTemplate = document.getElementById('mod-prefix-input').value || '（警告：触发禁止词）';
    moderator.save();
    document.getElementById('mod-count').textContent = moderator.words.length;
    pop.classList.remove('show');
};

// 引擎命中事件：展示命中词并弹出提示条
bus.on(EVENTS.MODERATOR_HIT, (hits) => {
    lastHits = hits;
    document.getElementById('mod-hit-words').textContent = hits.map(h => h.word).join(', ');
    hint.classList.add('show');
});

// 应用前缀：非破坏式注入——前缀 + 换行拼到输入框当前文本前，用户可自由编辑，发送时自然带着走
hint.querySelector('.mh-apply').onclick = () => {
    if (lastHits.length === 0) return;             // 无命中词不生成（理论上提示条可见必有命中，防御性兜底）
    const prefix = moderator.generatePrefix(lastHits);
    const currentText = inputManager.text;         // 取当前输入文本（渲染器的文本来源）
    DOM.hiddenInput.value = prefix + '\n' + currentText; // 同步写回隐藏输入框（其 value 才是真实输入值）
    inputManager.text = DOM.hiddenInput.value;     // 同步 text，供渲染器读取显示
    inputManager.composing = false;                // 若正处 IME 组合，重置组合态，防止组合文本叠加到新前缀上
    inputManager.compData = '';                    // 清残留组合文本（composing=false 后不再被渲染，但保持状态干净）
    inputRenderer.markDirty();                     // 置脏触发 Canvas 重绘，立即显示新文本
    DOM.hiddenInput.focus();                       // 聚焦让用户立刻修改或继续写正文
    hint.classList.remove('show');                 // 关闭提示条，避免重复应用
};

// 关闭提示条
hint.querySelector('.mh-close').onclick = () => {
    hint.classList.remove('show');
};

// 点击气泡外任意处关闭气泡（不挡其它 UI 的点击）
document.addEventListener('click', (e) => {
    if (pop.classList.contains('show') && !pop.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        pop.classList.remove('show');
    }
});
