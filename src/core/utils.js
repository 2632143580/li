/**
 * 无副作用工具函数（stage5 从原 core/state.js 拆出）
 *
 * 职责：本文件是「零依赖基础层」中的**纯函数**部分——所有函数输入决定输出，
 *       不读写全局状态、不碰 DOM、不发请求、不依赖其它模块。
 *       不可变常量见 core/constants.js；可变全局状态见 core/state.js。
 *
 * 导出：clamp, rand, safeParseInt, formatTokens, getProviderByUrl, ensureKeysObject
 * 依赖：无
 */

// ================================================================
//  工具函数（纯函数，无副作用）
// ================================================================

/**
 * 数值限幅
 * @param {number} v - 原始值
 * @param {number} lo - 下界
 * @param {number} hi - 上界
 * @returns {number}
 */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 区间随机数。当前项目代码中无调用方，保留作为插件作者可复用的基础工具。
 * @param {number} a - 下界（含）
 * @param {number} b - 上界（不含）
 * @returns {number}
 */
export const rand = (a, b) => a + Math.random() * (b - a);

/**
 * 安全解析十进制整数
 * @param {string|number} val - 待解析值
 * @param {number} fallback - 解析结果为 NaN 时返回的回退值
 * @returns {number}
 */
export const safeParseInt = (val, fallback) => {
    const n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
};

/**
 * 格式化 token 数为可读字符串
 * @param {number} n - token 数；非数字或 NaN 时返回 '--'
 * @returns {string} 例：1234 → '1.2k'；999 → '999'
 */
export const formatTokens = (n) => {
    if (typeof n !== 'number' || isNaN(n)) return '--';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
};

/**
 * 根据 API URL 推断服务商标识
 * @param {string} url - API 端点 URL
 * @returns {'zhipu'|'deepseek'|'custom'}
 */
export function getProviderByUrl(url) {
    if (!url) return 'custom';
    if (url.includes('bigmodel.cn') || url.includes('zhipuai')) return 'zhipu';
    if (url.includes('deepseek.com')) return 'deepseek';
    return 'custom';
}

/** keys 允许持久化的服务商槽位（custom 不记忆：自定义服务商的 Key 只活在本次运行，不落档） */
export const KEY_PROVIDERS = ['zhipu', 'deepseek'];

/**
 * 就地补全设置对象的 keys 字段，保证已知服务商槽位存在（zhipu/deepseek）。
 * 用于兼容缺少该字段的旧存档与导入文件；历史存档中的 custom 槽位会被剔除（不再序列化）。
 * @param {{keys?:{zhipu?:string, deepseek?:string}}} obj - 设置对象（会被直接修改）
 * @returns {void}
 */
export function ensureKeysObject(obj) {
    if (!obj.keys) {
        obj.keys = { zhipu: '', deepseek: '' };
    } else {
        for (const p of KEY_PROVIDERS) {
            if (obj.keys[p] === undefined) obj.keys[p] = '';
        }
    }
}
