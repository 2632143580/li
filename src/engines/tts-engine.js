/**
 * 语音引擎（Web Speech API 封装）— 句句发语音条
 *
 * 职责：
 *   1. initTTS()：加载系统音色列表（异步 voiceschanged 兜底）
 *   2. speakSentence(text, { onStart, onEnd })：播放单句（点击语音条时调用），全局互斥播放
 *   3. stopCurrent()：停止当前播放（再次点击同一语音条 / 关闭语音回复时调用）
 *   4. cleanForSpeech(text)：朗读前文本清洗（去 markdown / emoji / URL / 空白压缩）—— 纯函数，可单测
 *   5. getVoices()：当前可选音色（供语音设置模态框填充下拉）
 *
 * 为什么用 Web Speech API（speechSynthesis）：
 *   - 零依赖、离线可用、dist 单文件 file:// 双击场景下可用（不触发 CORS）
 *   - 项目无后端，在线 TTS API 在 file:// 下被跨域限制卡死，故排除
 *
 * 与上一版（自动朗读）的区别（用户 2026-08-14 纠正）：
 *   - 不再「AI 回复完成自动朗读全文」——改为 AI 回复渲染成【语音条】，用户点击语音条才播放（再次点击停止）。
 *   - 因此移除 speak(full)/stopTTS()/isSpeaking() 与 TTS_START/TTS_END 事件总线。
 *   - 自动播放策略不再相关：语音只在用户手势（点击语音条）后触发，Chrome 不会拦截 speechSynthesis。
 *
 * 依赖：core/store（settings.ttsVoice / ttsRate）、core/logger、core/text-split（断句在调用方完成）
 * 注意：模块顶层不访问 speechSynthesis（Node 单测可安全 import 本模块测纯函数），
 *       所有语音调用都发生在函数内部，且带 typeof 守卫（老浏览器 / 非浏览器环境降级为静默）。
 */
import { state } from '../core/store.js';
import { Logger } from '../core/logger.js';
import { showToast } from '../core/toast.js';
// 云端 TTS 音频持久化层（IndexedDB，复刻背景图持久化）：读路径命中磁盘、写路径落盘、容量统计
import { loadMeta, getAudio, putAudio, clearAll as clearVoiceIdb, getVoiceStats } from '../core/voice-cache.js';

/** MiMo-V2.5-TTS 预置音色清单（官方固定，与系统音色无关）。 @type {Array<{id:string,name:string,lang:string,gender:string}>} */
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

/** 系统可用音色列表（voiceschanged 异步填充） @type {Array<SpeechSynthesisVoice>} */
let voices = [];
/** 是否已拿到音色列表（部分浏览器首帧 getVoices 为空，需等 voiceschanged 事件） @type {boolean} */
let voicesReady = false;
/** 当前正在播放的系统 utterance（互斥：新播放先停旧的） @type {SpeechSynthesisUtterance|null} */
let activeUtterance = null;
/** 当前正在播放的云端 audio（互斥：新播放先停旧的） @type {HTMLAudioElement|null} */
let activeCloudAudio = null;
/** 当前播放结束回调（通知对应语音条移除高亮） @type {function|null} */
let activeOnEnd = null;
/** 播放序号令牌：每次 stopCurrent / 新播放自增；在途播放（云端 fetch / 系统 60ms 延迟）完成后比对，
 *  若已被停止或切句则放弃本次播放，避免「点了停止却仍在播 / 旧句抢播」。 @type {number} */
let playSeq = 0;
/** 系统语音是否不可用（运行环境无 window.speechSynthesis）：实时判定，避免「加载时判定一次、运行期才可用」的误杀 @returns {boolean} */
function systemUnsupported() { return typeof window === 'undefined' || typeof window.speechSynthesis === 'undefined'; }

// —— 云端 TTS 音频内存缓存（LRU）——
// 目的：重听同一句不重复请求 MiMo 接口（省延迟 + 省额度）；仅云端源走此缓存，系统源本地合成无请求。
// 存 Blob（非 Audio/objectURL）：每次播放从 Blob 现建 objectURL、播完 revoke，避免缓存的 URL 被提前释放导致二次播放失效。
// 内存缓存（非磁盘）：刷新/关页即失——契合本项目手机 file:// 无存储墙的约束，三端通用、零基建。
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
 * 初始化语音引擎：加载音色列表 + 监听 voiceschanged（Chrome 音色异步加载的已知坑）。
 * main.js init() 调用；无副作用，不支持时仅打一条日志。
 */
export function initTTS() {
    // 加载云端音频磁盘缓存元信息（独立于系统语音能力，故置于最前；失败仅日志，不阻塞音色加载）
    loadMeta().catch(e => Logger.warn('[TTS] 语音缓存元信息加载失败', e?.message || String(e)));
    if (systemUnsupported()) {
        Logger.warn('[TTS] 当前环境不支持 speechSynthesis，语音播报不可用');
        return;
    }
    loadVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

/** 刷新音色列表（voiceschanged 触发时调用） @returns {void}
 * 注意：必须判空——Via 等环境无 window.speechSynthesis（systemUnsupported 为真），
 *       若直接调 getVoices() 会抛 TypeError，连锁导致 openVoiceModal 的 try 块中断，
 *       populateCloudVoices（云端音色下拉）与 setCloudKey 回填被跳过（2026-08-16 实测踩坑）。 */
function loadVoices() {
    if (systemUnsupported()) { voices = []; voicesReady = true; return; }
    voices = window.speechSynthesis.getVoices() || [];
    voicesReady = true;
}

/** 当前可选音色（供语音设置模态框填充下拉；未就绪时兜底触发一次加载） @returns {Array<SpeechSynthesisVoice>} */
export function getVoices() {
    if (!voicesReady) loadVoices();
    return voices;
}

/** 云端 TTS 预置音色（MiMo 固定清单，供云端模式音色下拉填充） @returns {Array<{id:string,name:string,lang:string,gender:string}>} */
export function getCloudVoices() {
    return MIMO_VOICES;
}

/**
 * 挑选朗读音色：settings.ttsVoice 指定具体音色名时优先命中；'auto' 时自动挑中文女声。
 * 中文语音缺失时朗读会变英文腔——这是系统音色边界，不在此处强造。
 * @returns {SpeechSynthesisVoice|null}
 */
function pickVoice() {
    const wanted = state.settings.ttsVoice;
    if (wanted && wanted !== 'auto' && voices.length) {
        const hit = voices.find(v => v.name === wanted);
        if (hit) return hit;
    }
    if (!voices.length) return null;
    const zhVoices = voices.filter(v => /zh/i.test(v.lang || ''));
    if (!zhVoices.length) return voices[0] || null;
    return zhVoices.find(v => /(female|xiaoxiao|huihui|yaoyao|xiaoyi|tingting)/i.test(v.name || '')) || zhVoices[0];
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
 * 播放单句（点击语音条触发，必须在用户手势链上）。
 * 按 settings.ttsSource 分发：'cloud' → 云端 MiMo TTS（fetch 音频后 <audio> 播放）；其余 → 浏览器系统音色。
 * 互斥：先停掉上一个（触发其 onEnd 移除高亮），再播新的。
 * 不支持 / 空文本：明确 toast 提示 + feedbackTile 给视觉反馈（不再静默早退）。
 * @param {string} text 单句文本（清洗后）
 * @param {{onStart?:function, onEnd?:function}} [cb] 播放开始 / 结束回调（结束含自然播完与被打断）
 * @returns {void}
 */
export function speakSentence(text, cb = {}) {
    if (state.settings.ttsSource === 'cloud') {
        speakCloud(text, cb);
        return;
    }
    speakSystem(text, cb);
}

/**
 * 系统音色播放（Web Speech API）— speakSentence 的 system 分支。
 * @param {string} text 单句文本（清洗后） @param {{onStart?:function, onEnd?:function}} cb
 */
function speakSystem(text, cb = {}) {
    if (systemUnsupported()) {
        showToast('当前环境不支持系统语音合成，请在「语音设置」中切换为「云端」并配置 API Key', 'warn', 4000);
        feedbackTile(cb); // 早退也给「已点击」视觉反馈（闪一下），避免死寂
        return;
    }
    const cleaned = cleanForSpeech(text);
    if (!cleaned) {
        showToast('该消息没有可朗读的文本', 'warn', 3000);
        feedbackTile(cb);
        return;
    }

    // 互斥：仅当确有内容在播时才 cancel（避免「cancel 紧接 speak」竞态把新句静默丢弃）
    const hadPlaying = !!(window.speechSynthesis.speaking || window.speechSynthesis.pending);
    stopCurrent();
    const mySeq = playSeq; // 抓取序号；下方 speakNow 在 60ms 延迟窗口内若被停止，playSeq 自增 → 放弃本次

    const speakNow = () => {
        if (mySeq !== playSeq) { cb.onEnd?.(false); return; } // 60ms 窗口 / 异步等待中被停止 → 放弃本次并通知队列续播（修⑤：防 autoPlaying 卡死）
        const u = new SpeechSynthesisUtterance(cleaned);
        const voice = pickVoice();
        // 防御：个别浏览器/环境返回的 voice 对象不合规，赋值会抛 TypeError 直接中断播放；
        // 包一层 try，失败则交给浏览器默认音色（voice 不设置仍能发声）。
        try { if (voice) u.voice = voice; } catch (_) { Logger.warn('[TTS] 音色对象不合规，改用默认音色'); }
        u.lang = voice ? voice.lang : 'zh-CN';
        u.rate = state.settings.ttsRate || 1;

        activeUtterance = u;
        activeOnEnd = cb.onEnd || null;
        // finish：仅当本 utterance 仍是当前活动项时才回调（旧句被 cancel 后的异步 onend 一律忽略，避免二次回调）
        const finish = (natural) => {
            if (activeUtterance !== u) return;
            activeUtterance = null;
            const end = activeOnEnd; activeOnEnd = null;
            end?.(natural);
        };
        u.onend = () => finish(true);   // 自然播完 → natural=true（用于回写真实秒数）
        u.onboundary = (e) => {
            // 系统语音无 duration 接口：用 onboundary 的字符进度驱动进度条（真实跟踪朗读位置，非预估动画）
            const p = (e.charIndex || 0) / Math.max(1, cleaned.length);
            cb.onProgress?.(Math.min(1, Math.max(0, p)));
        };
        u.onerror = (e) => {
            // canceled/interrupted 是主动打断（stopCurrent 已通过 activeOnEnd 通知），不在此续播
            if (e.error === 'canceled' || e.error === 'interrupted') return;
            Logger.warn('[TTS] 系统朗读失败', e.error);
            showToast('系统语音朗读失败（' + (e.error || '未知') + '），可检查系统是否安装中文语音', 'error');
            finish(false);              // 异常中断非自然播完 → natural=false（不回写秒数）
        };
        cb.onStart?.();
        // 关键修复①：Chrome 后台标签/失焦后会自动 pause speechSynthesis，此后 speak 静默失效 → 先 resume
        try { if (window.speechSynthesis.paused) window.speechSynthesis.resume(); } catch (_) { /* 老浏览器无 resume */ }
        window.speechSynthesis.speak(u);
        // 关键修复②：部分 Chrome 偶发「speak 后未进入 speaking」（尤其首句），~250ms 内未播则重试一次
        setTimeout(() => {
            if (activeUtterance === u && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
                try { window.speechSynthesis.speak(u); } catch (_) { /* 忽略 */ }
            }
        }, 250);
    };

    // 关键修复③：首次交互时 getVoices() 常为空（Chrome 异步加载音色），pickVoice 返回 null →
    // speechSynthesis 拿不到匹配音色 → 静默不发声。改为：音色未到位则等 voiceschanged 到位后再播
    // （最多等 3s，超时直接播，交给浏览器兜底默认音色）。
    if (typeof window !== 'undefined' && window.speechSynthesis && voices.length === 0) {
        loadVoices();
        if (voices.length === 0) {
            let waited = 0;
            let done = false;
            const fire = () => { if (done) return; done = true; clearInterval(iv); safeRemove(); speakNow(); };
            const onReady = () => { if (voices.length > 0) fire(); };
            const safeRemove = () => { try { window.speechSynthesis.removeEventListener('voiceschanged', onReady); } catch (_) { /* 忽略 */ } };
            const iv = setInterval(() => {
                loadVoices();
                waited += 120;
                if (voices.length > 0) fire();
                else if (waited >= 3000) fire();
            }, 120);
            window.speechSynthesis.addEventListener('voiceschanged', onReady);
            return;
        }
    }
    // 若无上一句在播，立即播；有上一句在播则让出一帧（~60ms）避开 cancel-then-speak 竞态
    if (hadPlaying) setTimeout(speakNow, 60);
    else speakNow();
}

/**
 * 云端音色播放（MiMo-V2.5-TTS）— speakSentence 的 cloud 分支。
 * 流程：stopCurrent 互斥 → onStart（进播放态）→ fetch 合成音频 → <audio> 播放。
 * 失败（未配 Key / 网络 / HTTP 非 2xx / 播放被拦截）一律回退系统音色，保证用户永远能听到。
 * @param {string} text 单句文本（清洗后） @param {{onStart?:function, onEnd?:function}} cb
 */
async function speakCloud(text, cb = {}) {
    const cfg = state.settings.ttsCloud || {};
    if (!cfg.apiKey) {
        // 系统语音也不可用：回退无意义，直接报错提示填 Key（而非「回退系统语音」的误导文案）
        if (systemUnsupported()) {
            showToast('云端 TTS 未配置 API Key，且当前环境不支持系统语音，请在「语音设置」中填写 API Key', 'error', 4500);
            feedbackTile(cb);
            return;
        }
        showToast('云端 TTS 未配置 API Key，已回退系统语音', 'warn');
        Logger.warn('[TTS] 云端未配置 API Key，回退系统语音');
        speakSystem(text, cb);
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
        showToast('云端合成失败（' + (err?.message || '未知错误') + '），已回退系统语音', 'error');
        Logger.warn('[TTS] 云端合成失败，回退系统语音', err?.message || String(err));
        // 修③：失败回退只推进一次队列——先清 activeOnEnd，否则下方 speakSystem 内部 stopCurrent
        // 会触发云端句的 wrapper onEnd（autoPlaying=false + processAutoQueue），与回退本句重叠串台。
        // 回退本句由 speakSystem 播完后再经 wrapper onEnd 续播下一句，全程仅一次推进。
        activeOnEnd = null;
        speakSystem(text, cb);
        return;
    }
    if (mySeq !== playSeq) return; // 播放前已被停止 / 切句 → 放弃本次，避免「停止后仍在播」
    activeCloudAudio = new Audio(URL.createObjectURL(blob)); // 每次播放从缓存 Blob 现建 URL，播完 revoke
    const audio = activeCloudAudio;
    // 真实进度：云端 audio 有 duration，timeupdate 实时回传播放位置（0~1），驱动进度条
    // （系统语音无 duration，无此回调，进度条保留预估动画）
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
        showToast('云端音频播放被拦截，已回退系统语音', 'warn');
        Logger.warn('[TTS] 云端音频播放被拦截，回退系统语音', e?.message || String(e));
        if (activeCloudAudio === audio) activeCloudAudio = null;
        // 修③：同上，仅推进一次队列（先清 activeOnEnd 再回退系统音）
        activeOnEnd = null;
        speakSystem(text, cb);
    }
}

/**
 * 连接测试：用一句话验证 MiMo 配置（Key / 音色 / 网络）是否可用。供语音设置「连接测试」按钮调用。
 * 不播放、不回退、不抛异常——返回结构化结果交给 UI 呈现。
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
    playSeq++; // 使在途播放失效（云端 fetch / 系统 60ms 延迟窗口内点停止即放弃本次）
    // 云端 audio：先暂停并释放 blob URL，再回调上一句 onEnd 移除高亮。
    // 注意：此段不依赖 speechSynthesis——Via 等无系统语音环境用云端 TTS 时，
    // 停止/重播也必须生效（原 systemUnsupported 早退会把云端停止也挡掉，致播放态卡死）。
    if (activeCloudAudio) {
        const a = activeCloudAudio;
        activeCloudAudio = null;
        try { a.pause(); a.onended = null; } catch (_) { /* 已结束 */ }
        if (a.src && a.src.startsWith('blob:')) { try { URL.revokeObjectURL(a.src); } catch (_) { /* 已释放 */ } }
    }
    const end = activeOnEnd; activeOnEnd = null;
    activeUtterance = null;
    // 系统语音部分仅在环境支持时操作（Via 等无 speechSynthesis 环境跳过，不影响云端停止）
    if (!systemUnsupported()) {
        try {
            if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
                window.speechSynthesis.cancel();
            }
        } catch (_) { /* 老环境无 cancel */ }
    }
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
// —— 有限并发预加载（按需：播当前句时预加载下一句 + 悬停预加载），减小自动朗读/点击延迟 ——
const PRELOAD_CONCURRENCY = 2;
let preloadRunning = 0;
const preloadQueue = [];

/** 后台预加载单句云端音频（限制并发，失败静默）。供「播当前句时预加载下一句」与「悬停预加载」调用。 */
export function preloadSentence(text) {
    if (state.settings.ttsSource !== 'cloud') { Logger.debug('[Preload] 跳过：非云端TTS源（本地合成无需预加载）'); return; }
    const cfg = state.settings.ttsCloud || {};
    if (!cfg.apiKey) { Logger.debug('[Preload] 跳过：未配置云端Key'); return; }
    const cleaned = cleanForSpeech(text);
    if (!cleaned) return;
    const key = cloudCacheKey(cleaned, cfg);
    if (cloudCache.has(key) || cloudInflight.has(key)) { Logger.debug('[Preload] 命中缓存/在途，跳过：' + cleaned.slice(0, 16)); return; }
    Logger.info('[Preload] 预加载：' + cleaned.slice(0, 16));
    preloadQueue.push({ text: cleaned, cfg });
    drainPreloadQueue();
}
function drainPreloadQueue() {
    if (preloadRunning >= PRELOAD_CONCURRENCY) return;
    if (preloadQueue.length === 0) return;
    preloadRunning++;
    const { text, cfg } = preloadQueue.shift();
    // 复用播放同款缓存/落盘路径；失败静默——播放时再重试或回退系统音
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
    // 队列看门狗（修⑨）：speechSynthesis.onend / audio.onended 在后台标签页 / 失焦 pause 后
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
        onProgress: (p) => cb.onProgress?.(p),                       // 真实进度条（云端 timeupdate / 系统 onboundary）
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
