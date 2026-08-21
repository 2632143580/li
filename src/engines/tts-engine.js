/**
 * 语音引擎（云端 MiMo-V2.5-TTS）— 句句发语音条
 *
 * 职责：
 *   1. initTTS()：加载语音缓存元信息（IndexedDB）
 *   2. speakSentence(text, { onStart, onEnd })：播放单句（点击语音条时调用），全局互斥播放
 *   3. stopCurrent()：停止当前播放（再次点击同一语音条 / 关闭语音回复时调用）
 *   4. cleanForSpeech(text)：朗读前文本清洗（去 markdown / emoji / URL / 空白压缩）—— 纯函数，可单测
 *   5. getCloudVoices()：MiMo 预置音色清单（供语音设置模态框填充下拉）
 *   6. 自动朗读队列（enqueueAutoSentence / clearAutoQueue）+ 有限并发预加载
 *
 * 语音源（用户 2026-08-21 决定）：仅云端 MiMo-V2.5-TTS，系统 speechSynthesis 已彻底移除
 * （机械音听感差；Via 等环境本身不可用；语速参数云端 API 不支持，一并去掉）。
 *
 * 依赖：core/store（settings.ttsCloud）、core/logger、core/voice-cache（IndexedDB 持久化）
 */
import { state } from '../core/store.js';
import { Logger } from '../core/logger.js';
import { showToast } from '../core/toast.js';
// 云端 TTS 音频持久化层（IndexedDB，复刻背景图持久化）：读路径命中磁盘、写路径落盘、容量统计
import { loadMeta, getAudio, putAudio, clearAll as clearVoiceIdb, getVoiceStats } from '../core/voice-cache.js';

/** MiMo-V2.5-TTS 预置音色清单（官方固定）。 @type {Array<{id:string,name:string,lang:string,gender:string}>} */
export const MIMO_VOICES = [
    { id: 'mimo_default', name: '默认（中国集群=冰糖）', lang: 'zh', gender: '女' },
    { id: '冰糖', name: '冰糖', lang: 'zh', gender: '女' },
    { id: '茉莉', name: '茉莉', lang: 'zh', gender: '女' },
    { id: '苏打', name: '苏打', lang: 'zh', gender: '男' },
    { id: '白桦', name: '白桦', lang: 'zh', gender: '男' },
    { id: 'Mia', name: 'Mia', lang: 'en', gender: '女' },
    { id: 'Chloe', name: 'Chloe', lang: 'en', gender: '女' },
    { id: 'Milo', name: 'Milo', lang: 'en', gender: '男' },
    { id: 'Dean', name: 'Dean', lang: 'en', gender: '男' }
];
/** MiMo 开放平台默认 base（用户可改，一般不动） @type {string} */
const MIMO_DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';

/** 当前正在播放的云端 audio（互斥：新播放先停旧的） @type {HTMLAudioElement|null} */
let activeCloudAudio = null;
/** 当前播放结束回调（通知对应语音条移除高亮） @type {function|null} */
let activeOnEnd = null;
/** 播放序号令牌：每次 stopCurrent / 新播放自增；在途播放（云端 fetch）完成后比对，
 *  若已被停止或切句则放弃本次播放，避免「点了停止却仍在播 / 旧句抢播」。 @type {number} */
let playSeq = 0;

// —— 云端 TTS 音频内存缓存（LRU）——
// 目的：重听同一句不重复请求 MiMo 接口（省延迟 + 省额度）。
// 存 Blob（非 Audio/objectURL）：每次播放从 Blob 现建 objectURL、播完 revoke，避免缓存的 URL 被提前释放导致二次播放失效。
let cloudCache = new Map();          // key → Blob（Map 插入序即 LRU 序）
let cloudInflight = new Map();       // key → Promise<Blob>（并发同句去重，防快速连点重复请求）
let cloudCacheBytes = 0;
const CLOUD_CACHE_MAX = 200;                    // 最多条数
const CLOUD_CACHE_MAX_BYTES = 30 * 1024 * 1024; // 最多 ~30MB
let onCloudCacheChange = null;         // tts.js 设置，缓存变化时刷新设置面板显示

/**
 * 缓存键：接口地址 + 模型 + 音色 + 文本（任一不同都须区分，否则改 baseUrl/音色后会命中错误音频）。
 * 有效值归一：缺省项按 fetchCloudAudio 的实际兜底补齐，保证「同一请求 → 同一键」。
 * @param {string} text @param {object} cfg
 */
function cloudCacheKey(text, cfg) {
    const voice = cfg.voice || 'mimo_default';
    const model = cfg.model || 'mimo-v2.5-tts';
    const base = (cfg.baseUrl || MIMO_DEFAULT_BASE).replace(/\/+$/, '');
    return base + '|' + model + '|' + voice + '|' + text;
}
/** 写入缓存并触发 LRU 淘汰（超条数/字节丢最旧） @param {string} key @param {Blob} blob */
function cachePut(key, blob) {
    cloudCache.set(key, blob);
    cloudCacheBytes += blob.size;
    while (cloudCache.size > CLOUD_CACHE_MAX || cloudCacheBytes > CLOUD_CACHE_MAX_BYTES) {
        const oldest = cloudCache.keys().next().value;
        const old = cloudCache.get(oldest);
        cloudCache.delete(oldest);
        cloudCacheBytes -= old ? old.size : 0;
    }
    onCloudCacheChange?.();
}
/**
 * 取云端音频（缓存优先；并发同键去重；三级回退：内存 → 磁盘 IDB → 网络）。
 * 网络取到后落盘 IndexedDB（异步、失败降级为内存，绝不阻塞播放）。
 * @param {string} text @param {object} cfg @returns {Promise<Blob>}
 */
async function fetchCloudAudioCached(text, cfg) {
    const key = cloudCacheKey(text, cfg);
    const hit = cloudCache.get(key);
    if (hit) { cloudCache.delete(key); cloudCache.set(key, hit); return hit; } // 内存命中 → 提到最新（刷新 LRU）
    const inf = cloudInflight.get(key);
    if (inf) return inf;                                            // 并发同句：复用进行中的请求，不重复抓
    // 磁盘命中：读 IDB，命中则进内存工作集直接返回（免网络请求，刷新/重开页面仍在）
    const idbBlob = await getAudio(key).catch(() => null);
    if (idbBlob) {
        cachePut(key, idbBlob);
        return idbBlob;
    }
    // 并发锁二次复核：上面 await getAudio 让出执行权期间，可能已有同 key 请求抢先发起网络，此处复用之，避免重复请求 MiMo
    const inf2 = cloudInflight.get(key);
    if (inf2) return inf2;
    // 三级：网络请求（fetchCloudAudioCached 的并发去重由上方 inflight 保证）
    const p = fetchCloudAudio(text, cfg).then(blob => {
        cloudInflight.delete(key);
        cachePut(key, blob); // 进内存工作集
        // 落盘（异步，失败降级为内存缓存，不阻塞播放）；落盘成功后刷新面板统计
        putAudio({
            key, blob,
            bytes: blob.size,
            voice: cfg.voice || 'mimo_default',
            model: cfg.model || 'mimo-v2.5-tts',
            text,
            savedAt: Date.now()
        }).then(() => onCloudCacheChange?.()).catch(() => {});
        return blob;
    }).catch(err => { cloudInflight.delete(key); throw err; });
    cloudInflight.set(key, p);
    return p;
}
/**
 * 缓存统计（设置面板显示用）。返回「磁盘持久化」容量（已落盘条数 / 字节），
 * 复刻背景图的「已用 X / 上限约 Y」语义——这才是跨刷新真实占用的量。
 * @returns {{count:number, bytes:number}}
 */
export function getCloudCacheStats() { return getVoiceStats(); }
/**
 * 清空云端音频缓存：内存 + 磁盘 IDB 一并清（含容量统计复位）。
 * 异步清 IDB 不阻塞 UI；统计在 clearAll 内同步复位，面板立即归零。
 * @returns {void}
 */
export function clearCloudCache() {
    cloudCache.clear();
    cloudInflight.clear();
    cloudCacheBytes = 0;
    clearVoiceIdb().catch(() => {});
    onCloudCacheChange?.();
}
/** 注册缓存变化回调（tts.js 用于刷新设置面板显示） @param {function} cb */
export function setCloudCacheChangeListener(cb) { onCloudCacheChange = cb; }

/**
 * 初始化语音引擎：加载云端音频磁盘缓存元信息。
 * main.js init() 调用；无副作用，失败仅日志。
 */
export function initTTS() {
    loadMeta().catch(e => Logger.warn('[TTS] 语音缓存元信息加载失败', e?.message || String(e)));
}

/** 云端 TTS 预置音色（MiMo 固定清单，供云端模式音色下拉填充） @returns {Array<{id:string,name:string,lang:string,gender:string}>} */
export function getCloudVoices() {
    return MIMO_VOICES;
}

/**
 * 朗读前文本清洗：去掉会让语音"念出来很难听"的内容。
 * 处理顺序固定：代码块 → 行内代码 → markdown 链接（保留显示文本）→ URL →
 * 符号/列表符 → 空行压缩 → emoji 移除 → 空白压缩。
 * 注意两点（踩过坑，单测锁定）：
 *   - markdown 链接必须先于 URL 处理：URL 正则若先跑会把 [标题](https://x.com) 里的
 *     https://x.com 移除、残留 "("，链接正则随后匹配不到完整结构。
 *   - ~ 是中文语气词（"你好呀~"，断句契约明确 ~ 非句尾）不是删除线符号，必须保留。
 * 纯函数，无 DOM / 无语音依赖，Node 可单测。
 * @param {string} text 原始文本 @returns {string} 清洗后文本（空串返回 ''）
 */
export function cleanForSpeech(text) {
    if (!text) return '';
    return text
        .replace(/```[\s\S]*?```/g, ' ')                 // 代码块整段移除
        .replace(/`([^`]*)`/g, '$1')                     // 行内代码保留内容
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')         // markdown 链接 → 保留显示文本（先于 URL 处理）
        .replace(/https?:\/\/\S+/g, ' ')                 // URL 移除
        .replace(/[*_>#|[\]()]/g, ' ')                   // markdown 强调/标题/引用/残留括号符号（~ 语气词保留）
        .replace(/^\s*[-+]\s+/gm, ' ')                   // 无序列表项符号（仅行首）
        .replace(/^\d+\.\s*/gm, ' ')                     // 有序列表编号（仅行首，防误伤小数 3.14）
        .replace(/\n{3,}/g, '\n\n')                      // 多余空行压缩
        // eslint-disable-next-line no-misleading-character-class
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, '') // emoji/符号移除
        .replace(/\s+/g, ' ')                            // 全部空白（含换行）压成单空格
        .trim();
}

/**
 * 早退 / 失败路径的视觉兜底：先触发 onStart（语音条进播放态、波形跳动）给用户「点击已生效」的反馈，
 * 0.5s 后再 onEnd(false) 退出——避免「点了没动效」的死寂感（GLM 复盘结论：静默早退 = 用户以为没点到）。
 * @param {{onStart?:function, onEnd?:function}} [cb] @returns {void}
 */
function feedbackTile(cb = {}) {
    cb.onStart?.();
    setTimeout(() => cb.onEnd?.(false), 500);
}

/**
 * 播放单句（点击语音条触发，必须在用户手势链上）：云端 MiMo TTS（fetch 音频后 <audio> 播放）。
 * 互斥：先停掉上一个（触发其 onEnd 移除高亮），再播新的。
 * 未配 Key / 空文本：明确 toast 提示 + feedbackTile 给视觉反馈（不再静默早退）。
 * @param {string} text 单句文本（清洗后）
 * @param {{onStart?:function, onEnd?:function}} [cb] 播放开始 / 结束回调（结束含自然播完与被打断）
 * @returns {void}
 */
export function speakSentence(text, cb = {}) {
    const cleaned = cleanForSpeech(text);
    if (!cleaned) {
        showToast('该消息没有可朗读的文本', 'warn', 3000);
        feedbackTile(cb);
        return;
    }
    speakCloud(cleaned, cb);
}

/**
 * 云端音色播放（MiMo-V2.5-TTS）。
 * 流程：stopCurrent 互斥 → onStart（进播放态）→ fetch 合成音频 → <audio> 播放。
 * @param {string} text 单句文本（已清洗） @param {{onStart?:function, onEnd?:function}} cb
 */
async function speakCloud(text, cb = {}) {
    const cfg = state.settings.ttsCloud || {};
    if (!cfg.apiKey) {
        showToast('云端 TTS 未配置 API Key，请在「语音设置」中填写', 'error', 4500);
        feedbackTile(cb);
        return;
    }
    stopCurrent();
    activeOnEnd = cb.onEnd || null; // 必须登记：否则 stopCurrent 无法通知本句退播放态（playingTile 卡死→再点不能重播）
    const mySeq = playSeq; // 抓取序号；fetch 期间若点停止，playSeq 自增，完成后比对即放弃本次播放
    cb.onStart?.();
    let blob;
    try {
        blob = await fetchCloudAudioCached(text, cfg); // 缓存优先；并发同句去重
    } catch (err) {
        showToast('云端合成失败（' + (err?.message || '未知错误') + '）', 'error');
        Logger.warn('[TTS] 云端合成失败', err?.message || String(err));
        // 失败即止：先清 activeOnEnd（避免与 feedbackTile 的 onEnd 二次回调串台），再退出播放态
        activeOnEnd = null;
        cb.onEnd?.(false);
        return;
    }
    if (mySeq !== playSeq) return; // 播放前已被停止 / 切句 → 放弃本次，避免「停止后仍在播」
    activeCloudAudio = new Audio(URL.createObjectURL(blob)); // 每次播放从缓存 Blob 现建 URL，播完 revoke
    const audio = activeCloudAudio;
    // 真实进度：云端 audio 有 duration，timeupdate 实时回传播放位置（0~1），驱动进度条
    audio.ontimeupdate = () => {
        const d = audio.duration || 1;
        cb.onProgress?.(Math.min(1, Math.max(0, (audio.currentTime || 0) / d)));
    };
    // 音频自然播完 / 被 stopCurrent 暂停：仅当本 audio 仍是当前活动项才回调（避免二次回调）
    audio.onended = () => {
        if (activeCloudAudio !== audio) return;
        activeCloudAudio = null;
        try { URL.revokeObjectURL(audio.src); } catch (_) { /* 已释放 */ }
        cb.onEnd?.(true); // 自然播完 → natural=true
    };
    try {
        await audio.play();
    } catch (e) {
        showToast('云端音频播放被拦截（浏览器自动播放策略）', 'warn');
        Logger.warn('[TTS] 云端音频播放被拦截', e?.message || String(e));
        if (activeCloudAudio === audio) activeCloudAudio = null;
        // 释放 Blob URL：play() 失败时 onended 不会触发，此处不 revoke 会泄漏 Blob URL
        if (audio.src && audio.src.startsWith('blob:')) { try { URL.revokeObjectURL(audio.src); } catch (_) { /* 已释放 */ } }
        activeOnEnd = null;
        cb.onEnd?.(false);
    }
}

/**
 * 连接测试：用一句话验证 MiMo 配置（Key / 音色 / 网络）是否可用。供语音设置「连接测试」按钮调用。
 * 不播放、不抛异常——返回结构化结果交给 UI 呈现。
 * @param {string} [text='你好，这是语音测试。'] 测试文本 @returns {Promise<{ok:boolean, msg:string}>}
 */
export async function testCloudTTS(text = '你好，这是语音测试。') {
    const cfg = state.settings.ttsCloud || {};
    if (!cfg.apiKey) return { ok: false, msg: '未填写 API Key' };
    const cleaned = cleanForSpeech(text);
    if (!cleaned) return { ok: false, msg: '测试文本为空' };
    try {
        const blob = await fetchCloudAudio(cleaned, cfg);
        if (!(blob instanceof Blob) || blob.size === 0) {
            return { ok: false, msg: '返回音频为空，音色/模型可能不支持' };
        }
        return { ok: true, msg: '连接成功 · 音色『' + (cfg.voice || 'mimo_default') + '』可用' };
    } catch (e) {
        return { ok: false, msg: '测试失败：' + (e?.message || String(e)) };
    }
}

/**
 * 调用 MiMo-V2.5-TTS 合成单句音频，返回 mp3 的 Blob（供缓存 + <audio> 播放复用）。
 * 采用 OpenAI 兼容 /v1/chat/completions：目标文本放 assistant 消息，audio.format=mp3，voice=预置音色。
 * 鉴权：Authorization: Bearer（官方同时支持 api-key 自定义头，Bearer 为通用标准）。
 * 注：该 API 无语速参数（官方未开放），语速调节不可用。
 * @param {string} text 清洗后文本 @param {{apiKey:string, baseUrl?:string, model?:string, voice?:string}} cfg
 * @returns {Promise<Blob>} mp3 二进制（调用方自行 URL.createObjectURL 播放）
 * @throws {Error} 网络 / HTTP 非 2xx / 响应缺 audio.data
 */
async function fetchCloudAudio(text, cfg) {
    const apiKey = (cfg.apiKey || '').trim();
    if (!apiKey) throw new Error('缺少 API Key');
    if (!text) throw new Error('合成文本为空');
    const base = (cfg.baseUrl || MIMO_DEFAULT_BASE).replace(/\/+$/, '');
    const url = base + '/chat/completions';
    const body = {
        model: cfg.model || 'mimo-v2.5-tts',
        messages: [
            { role: 'user', content: '' },           // 风格可选（暂空）
            { role: 'assistant', content: text }       // 目标合成文本必须放 assistant
        ],
        audio: { format: 'mp3', voice: cfg.voice || 'mimo_default' },
        stream: false
    };
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
    } catch (e) {
        clearTimeout(to);
        if (e && e.name === 'AbortError') throw new Error('请求超时（30s）');
        throw new Error('网络错误：' + (e?.message || String(e)));
    }
    clearTimeout(to);
    if (!res.ok) {
        let detail = '';
        try {
            const j = await res.json();
            detail = (j && (j.error?.message || (typeof j.error === 'string' && j.error))) || JSON.stringify(j).slice(0, 140);
        } catch (_) { /* 响应体非 JSON */ }
        throw new Error('HTTP ' + res.status + (detail ? ' · ' + detail : ''));
    }
    const data = await res.json();
    const b64 = data?.choices?.[0]?.message?.audio?.data;
    if (!b64) throw new Error('响应缺少 audio.data（模型/音色不支持？）');
    // base64 → 二进制 → Blob（mp3），交给调用方缓存 / <audio> 播放
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'audio/mpeg' });
}

/**
 * 停止当前播放（再次点击正在播放的语音条 / 关闭语音回复时调用）。幂等。
 * 通过 activeOnEnd 通知上一句语音条移除高亮（若其仍在播放）。
 * @returns {void}
 */
export function stopCurrent() {
    playSeq++; // 使在途播放失效（云端 fetch 窗口内点停止即放弃本次）
    // 云端 audio：先暂停并释放 blob URL，再回调上一句 onEnd 移除高亮。
    if (activeCloudAudio) {
        const a = activeCloudAudio;
        activeCloudAudio = null;
        try { a.pause(); a.onended = null; } catch (_) { /* 已结束 */ }
        if (a.src && a.src.startsWith('blob:')) { try { URL.revokeObjectURL(a.src); } catch (_) { /* 已释放 */ } }
    }
    const end = activeOnEnd; activeOnEnd = null;
    end?.(false); // 主动打断（再次点击 / 关闭语音）→ natural=false（不回写秒数、进度条复位）
}

/**
 * 自动朗读队列（用户 2026-08-15 新增「自动朗读」开关）：AI 回复流式生成时，
 * 语音条渲染器（voice-tiles）逐句 enqueue 已完成的句子，本模块按序自动播放。
 * - 全局互斥：复用 speakSentence 的 stopCurrent（同时只播一句），与手动点击共用同一互斥锁。
 * - 手动点击语音条会调 clearAutoQueue() 抢回控制权（用户直达铁律：用户一碰就停自动）。
 * - 顺序播放：上一句 onEnd（自然播完或被打断）后才播下一句；打断时本句不回写秒数。
 * @type {string[]}
 */
// —— 有限并发预加载（自动朗读：播当前句时预加载队列下一句），减小自动朗读句间延迟 ——
const PRELOAD_CONCURRENCY = 2;
let preloadRunning = 0;
const preloadQueue = [];

/** 后台预加载单句云端音频（限制并发，失败静默）。供自动朗读「播当前句时预加载队列下一句」调用。 */
export function preloadSentence(text) {
    const cfg = state.settings.ttsCloud || {};
    if (!cfg.apiKey) return;                                 // 未配 Key 不预加载
    const cleaned = cleanForSpeech(text);
    if (!cleaned) return;
    const key = cloudCacheKey(cleaned, cfg);
    if (cloudCache.has(key) || cloudInflight.has(key)) return; // 已在缓存/请求中则跳过（fetchCloudAudioCached 内部亦有去重）
    preloadQueue.push({ text: cleaned, cfg });
    drainPreloadQueue();
}
function drainPreloadQueue() {
    if (preloadRunning >= PRELOAD_CONCURRENCY) return;
    if (preloadQueue.length === 0) return;
    preloadRunning++;
    const { text, cfg } = preloadQueue.shift();
    // 复用播放同款缓存/落盘路径；失败静默——播放时再重试
    fetchCloudAudioCached(text, cfg).catch(() => {}).finally(() => { preloadRunning--; drainPreloadQueue(); });
}

let autoQueue = [];
/** 当前是否正在自动播（防并发重复播同一句） @type {boolean} */
let autoPlaying = false;

/**
 * 入队一句待自动朗读的文本 + 视觉回调（流式渲染器调用）。已做去空 + 开关双重守卫（渲染器也守一遍）。
 * 回调由调用方（voice-tiles）传入，负责驱动语音条视觉（高亮 / 进度条 / 回写实测评测秒数），
 * 使「自动读」与「手动点击读」视觉完全一致。
 * @param {string} text 单句文本（已清洗）
 * @param {{onStart?:function,onProgress?:function,onEnd?:function}} [cb] 视觉回调（手动点击的同款）
 */
export function enqueueAutoSentence(item) {
    const cleaned = cleanForSpeech(item.text);
    if (!cleaned) return null;
    item.text = cleaned;
    if (!state.settings.ttsAutoRead || !state.settings.ttsEnabled) return null;
    autoQueue.push(item);
    processAutoQueue();
    return item;
}

/** 顺次播放队列（互斥：上句在播则等待其 onEnd） @returns {void} */
function processAutoQueue() {
    if (autoPlaying) return;
    if (autoQueue.length === 0) return;
    autoPlaying = true;
    const { text, cb } = autoQueue.shift();
    // 播当前句时预加载队列下一句：下一句播放时 fetchCloudAudioCached 直接命中内存/磁盘缓存，免网络等待。
    if (autoQueue.length > 0) preloadSentence(autoQueue[0].text);
    // 队列看门狗（修⑨）：audio.onended 在后台标签页 / 失焦 pause 后
    // 是已知不触发的坑，一旦不响 autoPlaying 卡死、队列停滞。按句长估算最大时长，
    // 超时强制续播下一句，保证自动朗读不会整条卡死。
    // settled 防「看门狗」与「真实 onEnd」重复推进：两者只会有一个真正推进队列。
    const estMs = Math.min(60000, Math.max(4000, text.length * 350));
    let settled = false;
    const advance = (natural) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        cb.onEnd?.(natural);                 // 退播放态 + 进度条复位 + 自然播完回写真实秒数
        autoPlaying = false;
        processAutoQueue();                  // 自然播完 / 打断 / 超时都继续下一句
    };
    const watchdog = setTimeout(() => {
        Logger.warn('[TTS] 自动朗读单句超时未收到 onEnd，强制续播下一句', text.slice(0, 16));
        stopCurrent();                       // 掐掉卡死的音频（stopCurrent 会触发 advance，settled 防重复）
        advance(false);                      // 兜底：若 stopCurrent 未触发 advance，仍强制续播
    }, estMs);
    speakSentence(text, {
        onStart: () => cb.onStart?.(),                              // 进播放态（高亮 + 波形跳动）
        onProgress: (p) => cb.onProgress?.(p),                       // 真实进度条（云端 timeupdate）
        onEnd: (natural) => advance(natural)
    });
}

/**
 * 清空自动朗读队列并停止当前播放（关闭自动朗读 / 关闭语音回复 / 切换显示模式 / 手动点击语音条时调用）。
 * @returns {void}
 */
export function clearAutoQueue() {
    autoQueue = [];
    autoPlaying = false;
    stopCurrent();
}
