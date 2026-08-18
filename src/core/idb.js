/**
 * IndexedDB 持久化（背景图库专用）
 *
 * 为什么用 IndexedDB 而非 localStorage：需求要求至少 372MB（62 张 × 6MB）图片数据，
 * 而 localStorage 仅约 5MB 上限，装不下。IndexedDB 无此上限，且可按 Blob 存储原图、按需取用。
 *
 * 两个 store：
 *  - bgImages：每张上传图 = { id, name, type, size, uploadedAt, triggerWords(string), thumb(dataURL 小缩略图), blob(Blob 原图) }
 *  - bgSettings：单条 = { key:'main', globalMode, pinnedId, currentId }
 *
 * 设计要点：列表只取「元信息 + 缩略图」(getAllImagesMeta 用游标，丢弃 blob，避免列表期常驻 372MB)；
 *   真正切换背景时才按 id 取 blob 建 objectURL。缩略图在上传时由调用方生成后一并存入。
 *
 * 依赖：core/logger（仅作失败日志，不依赖 DOM，保持 core 层零外部依赖约束）。
 */
import { Logger } from './logger.js';

const DB_NAME = 'li-bg-db';
const DB_VERSION = 1;
const STORE_IMG = 'bgImages';
const STORE_SET = 'bgSettings';
const SETTINGS_KEY = 'main';

/** 打开（或升级）数据库，返回 Promise<IDBDatabase>；结果缓存避免重复 open。 @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_IMG)) {
                db.createObjectStore(STORE_IMG, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_SET)) {
                db.createObjectStore(STORE_SET, { keyPath: 'key' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            Logger.error('[IDB] 数据库打开失败', req.error);
            reject(req.error);
        };
    });
    return dbPromise;
}

/**
 * 取某个 store 的事务对象。
 * @param {string} store - store 名
 * @param {'readonly'|'readwrite'} mode
 * @returns {Promise<IDBObjectStore>}
 */
function getStore(store, mode) {
    return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

/** 把 IDBRequest 包成 Promise @param {IDBRequest} r @returns {Promise<any>} */
function reqToPromise(r) {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

/**
 * 写入一张图片记录（新增或覆盖同 id）。
 * @param {object} rec - 完整图片记录（含 blob）
 * @returns {Promise<void>}
 */
export async function putImage(rec) {
    const s = await getStore(STORE_IMG, 'readwrite');
    await reqToPromise(s.put(rec));
}

/** 删除一张图片（其触发词随记录一起消失，满足"删图即清词"）。 @param {string} id @returns {Promise<void>} */
export async function deleteImage(id) {
    const s = await getStore(STORE_IMG, 'readwrite');
    await reqToPromise(s.delete(id));
}

/**
 * 取全部图片「元信息 + 缩略图」列表（游标遍历，丢弃 blob，避免列表期把 372MB 原图全部读进内存）。
 * 返回顺序按上传时间升序。 @returns {Promise<Array<object>>}
 */
export async function getAllImagesMeta() {
    const s = await getStore(STORE_IMG, 'readonly');
    return await new Promise((resolve, reject) => {
        const out = [];
        const cur = s.openCursor();
        cur.onsuccess = () => {
            const c = cur.result;
            if (c) {
                const { blob, ...meta } = c.value; // 丢弃 blob，仅保留元信息 + 缩略图
                out.push(meta);
                c.continue();
            } else {
                out.sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
                resolve(out);
            }
        };
        cur.onerror = () => reject(cur.error);
    });
}

/** 按 id 取完整记录（含原图 blob），用于切换背景。 @param {string} id @returns {Promise<object|null>} */
export async function getImage(id) {
    const s = await getStore(STORE_IMG, 'readonly');
    return (await reqToPromise(s.get(id))) || null;
}

/** 写设置（覆盖同 key）。 @param {object} rec - 含 key 字段 @returns {Promise<void>} */
export async function putSetting(rec) {
    const s = await getStore(STORE_SET, 'readwrite');
    await reqToPromise(s.put(rec));
}

/**
 * 读设置。无记录时返回 null（调用方用默认值兜底）。
 * @param {string} [key=SETTINGS_KEY]
 * @returns {Promise<object|null>}
 */
export async function getSetting(key = SETTINGS_KEY) {
    const s = await getStore(STORE_SET, 'readonly');
    const all = (await reqToPromise(s.getAll())) || [];
    return all.find((r) => r.key === key) || null;
}

/** 默认设置对象 @returns {object} */
export function defaultSettings() {
    return { key: SETTINGS_KEY, globalMode: 'exact', pinnedId: null, currentId: null };
}
