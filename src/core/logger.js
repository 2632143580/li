/**
 * Logger — 统一日志出口
 *
 * 职责：分级输出日志，并提供 safe / safeAsync 包装，替代散落各处的空 catch 块，
 *       使插件/引擎里的异常「被记录但不中断调用方流程」。
 *
 * 导出：Logger（单例对象）
 * 依赖：无（本项目依赖链的最底层，不 import 任何模块）
 */
export const Logger = {
    /**
     * 级别名 → 数值映射。数值越大越严重；silent(4) 高于所有输出级别，等于全部静音。
     * @type {{debug:number, info:number, warn:number, error:number, silent:number}}
     */
    _levels: { debug: 0, info: 1, warn: 2, error: 3, silent: 4 },
    /** 当前生效的级别阈值（数值形式），低于该值的日志不输出到 console。默认 2 = warn。 @type {number} */
    _level: 2,
    /** 内存日志环：始终记录全部级别（不受 _level 限制），供日志页订阅展示。 @type {Array<{ts:string,level:string,args:any[]}>} */
    _buf: [],
    /** 内存缓冲上限（条）。 @type {number} */
    _maxBuf: 300,
    /** 日志页订阅者回调列表。 @type {Array<function>} */
    _subs: [],
    /** @returns {string} 24 小时制本地时间戳 */
    _ts() {
        return new Date().toLocaleTimeString('zh-CN', { hour12: false });
    },
    /** 统一落盘到内存环并通知订阅者（不受 _level 限制，保证日志页能看到全部级别）。 */
    _push(level, args) {
        this._buf.push({ ts: this._ts(), level, args });
        if (this._buf.length > this._maxBuf) this._buf.shift();
        for (const cb of this._subs) { try { cb({ ts: this._ts(), level, args }); } catch (_) {} }
    },
    /**
     * 设置日志级别（仅影响 console 输出，不影响内存缓冲）。
     * @param {'debug'|'info'|'warn'|'error'|'silent'} l - 级别名；传入未知值时不做任何改动
     */
    setLevel(l) {
        if (this._levels[l] !== undefined) this._level = this._levels[l];
    },
    debug(...args) { if (this._level <= 0) console.debug(`[${this._ts()}] [DBG]`, ...args); this._push('debug', args); },
    info(...args)  { if (this._level <= 1) console.info(`[${this._ts()}] [INF]`, ...args); this._push('info', args); },
    warn(...args)  { if (this._level <= 2) console.warn(`[${this._ts()}] [WRN]`, ...args); this._push('warn', args); },
    error(...args) { if (this._level <= 3) console.error(`[${this._ts()}] [ERR]`, ...args); this._push('error', args); },
    /**
     * 订阅内存日志环：每次新日志触发 cb(entry)；cb(null) 表示缓冲被清空。返回取消订阅函数。
     * @param {function} cb - 回调，接收 { ts, level, args } 或 null（清空）
     * @returns {function} 取消订阅函数
     */
    subscribe(cb) {
        if (typeof cb === 'function') this._subs.push(cb);
        return () => { const i = this._subs.indexOf(cb); if (i >= 0) this._subs.splice(i, 1); };
    },
    /** @returns {Array} 当前内存日志环副本（按时间顺序） */
    getBuffer() { return this._buf.slice(); },
    /** 清空内存日志环并通知订阅者（cb(null)） */
    clear() { this._buf.length = 0; for (const cb of this._subs) { try { cb(null); } catch (_) {} } },
    /**
     * 安全执行同步函数，自动捕获异常并记录，不中断调用方流程
     * @param {string} tag - 出错时打印的定位标签
     * @param {Function} fn - 待执行函数
     * @returns {*} fn 的返回值；抛错时返回 undefined
     */
    safe(tag, fn) {
        try { return fn(); }
        catch (e) { this.warn(`[${tag}]`, e); return undefined; }
    },
    /**
     * 安全执行异步函数
     * @param {string} tag - 出错时打印的定位标签
     * @param {Function} fn - 待执行的 async 函数
     * @returns {Promise<*>} fn 的返回值；抛错时 resolve 为 undefined
     */
    async safeAsync(tag, fn) {
        try { return await fn(); }
        catch (e) { this.warn(`[${tag}]`, e); return undefined; }
    }
};
