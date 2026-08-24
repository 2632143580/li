import { moderator } from '../engines/moderator-engine.js';
import { bus, EVENTS } from '../core/bus.js';
import { DOM } from '../core/dom.js';
import { inputManager } from './input-manager.js';
import { inputRenderer } from './input-renderer.js';

// 只清理本模块节点，保留原聊天布局与全屏编辑入口。
document.querySelectorAll('#mod-trigger-btn, #mod-prefix-btn, #mod-pop, #mod-style').forEach((node) => node.remove());

const style = document.createElement('style');
style.id = 'mod-style';
style.textContent = `
#mod-trigger-btn,#mod-prefix-btn{position:fixed;bottom:20px;z-index:10;height:32px;border:1px solid var(--white-a10);background:var(--bg-select);color:var(--white-a70);border-radius:8px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);font:12px inherit}
#mod-trigger-btn{right:56px;width:32px;font-size:16px}#mod-prefix-btn{right:96px;padding:0 11px}#mod-trigger-btn:hover,#mod-prefix-btn:hover{color:var(--color-accent);border-color:var(--color-accent)}
#mod-pop{position:fixed;right:12px;bottom:58px;z-index:40;width:276px;padding:13px;background:var(--bg-select);color:var(--white-a90);border:1px solid var(--white-a10);border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.45);display:none;gap:10px;flex-direction:column}#mod-pop.show{display:flex}
.mod-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.mod-title{font-weight:700;font-size:14px}.mod-muted{color:var(--white-a50);font-size:12px;line-height:1.5}.mod-close{flex:0 0 auto;background:transparent;border:0;color:var(--white-a70);font-size:20px;line-height:1;cursor:pointer}.mod-close:hover{color:var(--color-accent)}
.mod-prefix-words{display:flex;flex-wrap:wrap;gap:6px;max-height:72px;overflow:auto}.mod-chip{border:1px solid var(--color-accent-dim);background:var(--color-accent-soft);color:var(--color-accent-bright);border-radius:999px;padding:4px 8px;cursor:pointer;font:11px inherit}.mod-chip[aria-pressed="true"]{background:var(--color-accent);color:var(--color-bg)}.mod-row{display:flex;gap:8px}.mod-btn{flex:1;min-height:32px;background:var(--color-accent);color:var(--color-bg);border:0;border-radius:6px;padding:7px 11px;cursor:pointer;font-size:12px}.mod-btn.secondary{background:var(--white-a10);color:inherit}.mod-btn:focus-visible,.mod-close:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
@media(max-width:680px){#mod-pop{right:10px;bottom:58px;width:min(276px,calc(100vw - 20px))}.mod-row{flex-wrap:wrap}.mod-btn{flex-basis:100%}}
@media(max-width:380px){#mod-prefix-btn{right:96px;padding:0 8px;font-size:11px}#mod-trigger-btn{right:56px}}
`;
document.head.appendChild(style);

const trigger = document.createElement('button');
trigger.id = 'mod-trigger-btn'; trigger.type = 'button'; trigger.setAttribute('aria-label', '打开禁词快捷操作'); trigger.textContent = '⌁'; document.body.appendChild(trigger);
const prefix = document.createElement('button');
prefix.id = 'mod-prefix-btn'; prefix.type = 'button'; prefix.textContent = '应用前缀'; prefix.setAttribute('aria-label', '应用最近命中的前缀'); document.body.appendChild(prefix);
const pop = document.createElement('div');
pop.id = 'mod-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '前缀应用'); pop.innerHTML = '<div class="mod-head"><div class="mod-title">应用前缀</div><button class="mod-close" id="mod-close" type="button" aria-label="关闭前缀弹窗">×</button></div><div id="mod-status" class="mod-muted"></div><div class="mod-muted">可选择命中的词，前缀会写入输入框，不会自动发送</div><div id="mod-hit-list" class="mod-prefix-words"></div><div class="mod-row"><button class="mod-btn" id="mod-apply" type="button">应用前缀</button></div>';
document.body.appendChild(pop);

let lastHits = [];
const $ = (id) => document.getElementById(id);
function updateStatus() { $('mod-status').textContent = lastHits.length ? `最近命中 ${lastHits.length} 条` : '等待 AI 回复命中禁词'; }
function applyHits() {
    if (!lastHits.length) return;
    const selected = [...document.querySelectorAll('#mod-hit-list .mod-chip[aria-pressed="true"]')].map((button) => button.dataset.word);
    const chosen = selected.length ? lastHits.filter((hit) => selected.includes(hit.word)) : lastHits;
    const text = `${moderator.generatePrefix(chosen)}\n${inputManager.text || ''}`;
    DOM.hiddenInput.value = text; inputManager.text = text; inputManager.composing = false; inputManager.compData = ''; inputRenderer.markDirty(); DOM.hiddenInput.focus(); closePopup();
}
function renderHits(hits) {
    $('mod-hit-list').replaceChildren(...hits.map((hit) => { const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'mod-chip'; chip.textContent = hit.word; chip.dataset.word = hit.word; chip.setAttribute('aria-pressed', 'true'); chip.setAttribute('aria-label', `取消选择 ${hit.word}`); chip.onclick = () => { const selected = chip.getAttribute('aria-pressed') === 'true'; chip.setAttribute('aria-pressed', String(!selected)); chip.setAttribute('aria-label', `${selected ? '选择' : '取消选择'} ${hit.word}`); }; return chip; }));
}
function openPopup() { updateStatus(); renderHits(lastHits); pop.classList.add('show'); trigger.setAttribute('aria-expanded', 'true'); $('mod-close').focus(); }
function closePopup() { pop.classList.remove('show'); trigger.setAttribute('aria-expanded', 'false'); }
trigger.setAttribute('aria-expanded', 'false'); trigger.onclick = () => pop.classList.contains('show') ? closePopup() : openPopup();
prefix.onclick = openPopup; $('mod-apply').onclick = applyHits; $('mod-close').onclick = closePopup;
bus.on(EVENTS.MODERATOR_HIT, (hits) => { lastHits = hits; renderHits(hits); updateStatus(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && pop.classList.contains('show')) closePopup(); });
document.addEventListener('click', (event) => { if (pop.classList.contains('show') && !pop.contains(event.target) && event.target !== trigger && event.target !== prefix) closePopup(); });

export { applyHits };
