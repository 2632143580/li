/**
 * 云端 TTS 音频持久化缓存（IndexedDB）
 *
 * 为什么落盘：原云端 TTS 音频只做「内存 LRU 缓存」，刷新/重开页面即失，重听同一句要重新请求 MiMo 接口
 *   （耗延迟 + 耗额度）。背景图已用 IndexedDB 持久化（li-bg-db），这里复刻同一范式，让云端音频也存磁盘、
 *   刷新仍在、重听免请求。
 *
 * 两个 store：
 *  - voiceAudio：每条缓存 = { key, blob(Blob mp3), bytes, voice, model, text, savedAt }
 *  - voiceMeta ：单条 = { key:'meta', bytes, count }（容量统计，避免每次开面板全表扫）
 *
 * 边界处理（用户要求的重点）：
 *  - 无 indexedDB 的环境（Node 单测 / 极老浏览器）→ 所有方法降级为 no-op，调用方退化为「内存 + 网络」（原行为）。
 *  - IDB 写满（QuotaExceededError）→ 先激进淘汰最旧一半再重试一次；仍失败则放弃落盘（内存缓存仍在，播放不受影响），仅打日志。
 *  - 并发同 key：由调用方 tts-engine 的 cloudInflight 去重，本层只负责幂等写入（覆盖同 key 不重复计字节）。
 *  - 容量上限 VOICE_CACHE_MAX_BYTES：写入后若超，按 savedAt 升序淘汰最旧直至回到上限内。
 *
 * 依赖：core/logger（仅失败日志，无 DOM 依赖，保持 core 层零外部依赖约束）。
 */
import { Logger } from './logger.js';

const DB_NAME = 'li-voice-db';
const DB_VERSION = 1;
const STORE_AUDIO = 'voiceAudio';
const STORE_META = 'voiceMeta';
const META_KEY = 'meta';

/** 磁盘容量上限（类比背景图 372MB；语音为短句 mp3，300MB 可存数千句） @type {number} */
export const VOICE_CACHE_MAX_BYTES = 300 * 1024 * 1024;

let dbPromise = null;
/** 内存中的容量统计（由 voiceMeta 初始化，避免每次开面板全表扫） @type {{bytes:number,count:number}} */
let stats = { bytes: 0, count: 0 };

/** 运行环境是否支持 IndexedDB（Node 单测 / 老浏览器降级） @returns {boolean} */
function idbOk() { return typeof indexedDB !== 'undefined'; }

/** 打开（或升级）数据库，结果缓存避免重复 open @returns {Promise<IDBDatabase>} */
function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_AUDIO)) {
                const os = db.createObjectStore(STORE_AUDIO, { keyPath: 'key' });
                os.createIndex('savedAt', 'savedAt', { unique: false }); // 供按时间升序淘汰
            }
            if (!db.objectStoreNames.contains(STORE_META)) {
                db.createObjectStore(STORE_META, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { Logger.error('[VoiceCache] 数据库打开失败', req.error); reject(req.error); };
    });
    return dbPromise;
}

/** 取某个 store 的事务对象（每次调用独立事务，避免跨 await 的事务自动提交陷阱） */
function tx(store, mode) {
    return openDB().then(db => db.transaction(store, mode).objectStore(store));
}

/** 把 IDBRequest 包成 Promise @param {IDBRequest} r @returns {Promise<any>} */
function reqToPromise(r) {
    return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

/**
 * 读一条音频（命中返回 Blob，未命中 / 出错返回 null）。出错降级为 null，由调用方走网络。
 * @param {string} key @returns {Promise<Blob|null>}
 */
export async function getAudio(key) {
    if (!idbOk() || !key) return null;
    try {
        const s = await tx(STORE_AUDIO, 'readonly');
        const rec = await reqToPromise(s.get(key));
        return (rec && rec.blob instanceof Blob) ? rec.blob : null;
    } catch (e) {
        Logger.warn('[VoiceCache] 读取失败（降级为网络请求）', e?.message || String(e));
        return null;
    }
}

/**
 * 写入一条音频并维护容量统计 + 磁盘 LRU 淘汰。幂等：覆盖同 key 不重复计字节。
 * 读写分两个独立事务，规避「同一事务跨 await 被自动提交」的经典坑。
 * @param {{key:string, blob:Blob, bytes:number, voice:string, model:string, text:string, savedAt:number}} rec
 */
export async function putAudio(rec) {
    if (!idbOk() || !rec || !rec.key || !(rec.blob instanceof Blob)) return;
    const size = rec.bytes || rec.blob.size || 0;
    try {
        // 1) 只读事务读旧值（同 key 覆盖时不重复计字节）
        const rStore = await tx(STORE_AUDIO, 'readonly');
        const old = await reqToPromise(rStore.get(rec.key));
        const oldBytes = (old && typeof old.bytes === 'number') ? old.bytes : 0;
        // 2) 写事务：put + 维护统计 + 持久化元信息 + 淘汰
        const wStore = await tx(STORE_AUDIO, 'readwrite');
        await reqToPromise(wStore.put(rec));
        stats.bytes = stats.bytes - oldBytes + size;
        stats.count = old ? stats.count : stats.count + 1;
        await persistMeta();
        await evictToCap();
    } catch (e) {
        // 写满（QuotaExceededError）等：先激进淘汰最旧一半再重试一次；仍失败则放弃落盘（内存缓存仍在，播放不受影响）
        if (e && e.name === 'QuotaExceededError') {
            try {
                await aggressiveEvict();
                const w2 = await tx(STORE_AUDIO, 'readwrite');
                await reqToPromise(w2.put(rec));
                // 已 evict 释放大量空间，统计按近似新增计入（下次 loadMeta 全表扫自愈）
                stats.bytes += size;
                stats.count += 1;
                await persistMeta();
                return;
            } catch (e2) {
                Logger.warn('[VoiceCache] 落盘失败（已降级为内存缓存，不阻塞播放）', e2?.message || String(e2));
                return;
            }
        }
        Logger.warn('[VoiceCache] 写入失败（降级为内存缓存）', e?.message || String(e));
    }
}

/** 按 savedAt 升序淘汰最旧音频，直到回到容量上限内（保活 meta 统计同步）。 */
async function evictToCap() {
    if (stats.bytes <= VOICE_CACHE_MAX_BYTES) return;
    const store = await tx(STORE_AUDIO, 'readwrite');
    const idx = store.index('savedAt');
    await new Promise((resolve) => {
        const cur = idx.openCursor(); // 升序 = 最旧在前
        cur.onsuccess = () => {
            const c = cur.result;
            if (!c) { resolve(); return; }
            if (stats.bytes <= VOICE_CACHE_MAX_BYTES) { resolve(); return; }
            const rec = c.value;
            stats.bytes -= (rec.bytes || 0);
            stats.count = Math.max(0, (stats.count || 1) - 1);
            c.delete();      // 同步删除 + 继续，同为一次事件回调内，事务保持活跃
            c.continue();
        };
        cur.onerror = () => resolve();
    });
    await persistMeta();
}

/** 激进淘汰：删最旧一半（用于 QuotaExceededError 后的抢救，仅游标取元信息，不加载 blob）。 */
async function aggressiveEvict() {
    const all = await getAllMetaCursor();
    if (all.length === 0) return;
    all.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    const drop = all.slice(0, Math.ceil(all.length / 2));
    const store = await tx(STORE_AUDIO, 'readwrite');
    for (const rec of drop) {
        await reqToPromise(store.delete(rec.key));
        stats.bytes -= (rec.bytes || 0);
        stats.count = Math.max(0, (stats.count || 1) - 1);
    }
    await persistMeta();
}

/** 游标取全部元信息（key/bytes/savedAt），不加载 blob，供 evict/重建使用 @returns {Promise<Array<object>>} */
function getAllMetaCursor() {
    return tx(STORE_AUDIO, 'readonly').then(s => new Promise((resolve) => {
        const out = [];
        const cur = s.openCursor();
        cur.onsuccess = () => {
            const c = cur.result;
            if (!c) { resolve(out); return; }
            out.push({ key: c.value.key, bytes: c.value.bytes || 0, savedAt: c.value.savedAt || 0 });
            c.continue();
        };
        cur.onerror = () => resolve(out);
    }));
}

/** 游标汇总字节 / 条数（不加载 blob），供首跑重建统计 @returns {Promise<{bytes:number,count:number}>} */
function sumBytesCursor() {
    return tx(STORE_AUDIO, 'readonly').then(s => new Promise((resolve) => {
        let bytes = 0, count = 0;
        const cur = s.openCursor();
        cur.onsuccess = () => {
            const c = cur.result;
            if (!c) { resolve({ bytes, count }); return; }
            bytes += (c.value.bytes || 0);
            count += 1;
            c.continue();
        };
        cur.onerror = () => resolve({ bytes, count });
    }));
}

/** 持久化元信息（失败不影响主流程） */
async function persistMeta() {
    try {
        const s = await tx(STORE_META, 'readwrite');
        await reqToPromise(s.put({ key: META_KEY, bytes: stats.bytes, count: stats.count }));
    } catch (_) { /* meta 失败不影响主流程 */ }
}

/**
 * 初始化容量统计：读 voiceMeta；首跑（无 meta）则全表扫一次重建。
 * 须在浏览器环境调用（initTTS 内触发），Node 下直接置 0。
 * @returns {Promise<void>}
 */
export async function loadMeta() {
    if (!idbOk()) return;
    try {
        const s = await tx(STORE_META, 'readonly');
        const m = await reqToPromise(s.get(META_KEY));
        if (m && typeof m.bytes === 'number') {
            stats = { bytes: m.bytes, count: m.count || 0 };
        } else {
            const { bytes, count } = await sumBytesCursor(); // 仅首跑一次
            stats = { bytes, count };
            await persistMeta();
        }
    } catch (e) {
        Logger.warn('[VoiceCache] 元信息加载失败，统计暂为 0', e?.message || String(e));
        stats = { bytes: 0, count: 0 };
    }
}

/** 取当前容量统计（已用字节 / 条数） @returns {{bytes:number,count:number}} */
export function getVoiceStats() { return { bytes: stats.bytes || 0, count: stats.count || 0 }; }

/** 清空全部持久化音频 + 复位统计（同步复位，面板立即归零）。 @returns {Promise<void>} */
export async function clearAll() {
    stats = { bytes: 0, count: 0 }; // 同步复位统计，面板立即归零
    if (!idbOk()) return;
    try {
        const s = await tx(STORE_AUDIO, 'readwrite');
        await reqToPromise(s.clear());
        await persistMeta();
    } catch (e) {
        Logger.warn('[VoiceCache] 清空失败', e?.message || String(e));
    }
}
