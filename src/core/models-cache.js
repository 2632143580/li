/**
 * 模型清单拉取与缓存（单一事实源：会话芯片快切 + 设置页「拉取模型」共用，零重复 fetch）
 *
 * 职责：给定服务商，向该服务商的 /models 端点拉取模型清单，写入 state.modelCache[provider]
 *      并随全局键持久化（saveToLocal → writeGlobalKey）。URL 变换 / 超时 / 解析 / 缓存口径
 *      全部收敛在本文件；另提供 availableModels 的唯一派生入口 syncAvailableModels，
 *      消除「多处直接赋值 state.availableModels」造成的双源漂移。
 *
 * 依赖：core/state、core/config、core/storage、core/logger、core/constants
 */

import { state } from './state.js';
import { LLM_PROVIDERS } from './config.js';
import { saveToLocal } from './storage.js';
import { Logger } from './logger.js';
import { MODELS_TIMEOUT_MS } from './constants.js';

/**
 * 由 chat/completions 端点推导 /models 端点（URL 变换唯一实现，两处调用方共用）。
 * @param {string} apiUrl chat/completions 完整 URL @returns {string}
 */
function buildModelsUrl(apiUrl) {
    let u = String(apiUrl || '').replace(/\/chat\/completions/, '/models');
    if (!u.endsWith('/models')) u = u.replace(/\/$/, '') + '/models';
    return u;
}

/**
 * 拉取并缓存某服务商的模型清单（治本核心：让会话级 LLM 配置也能自动配套合法 model，
 * 杜绝在清单为空时落 model:'' 而把空串送进 API → DeepSeek 报 "passed ."）。
 *
 * URL / key 解析口径与请求层 api.js 对齐：显式覆盖（设置页未保存的暂存值）>
 * settings 持久配置 > LLM_PROVIDERS 死常量兜底。此前用死常量 URL——用户改过服务商端点后，
 * 清单拉取仍打到旧地址（潜在 404/超时），已修。
 * AbortController + MODELS_TIMEOUT_MS 超时兜底：网络挂死不会拖死调用方（异步纪律：必须设超时）。
 *
 * @param {'zhipu'|'deepseek'} provider 服务商标识
 * @param {{apiKey?: string, apiUrl?: string}} [overrides] 覆盖项（设置页暂存态传 tempSettings 的 url/key）
 * @returns {Promise<string[]>} 模型 id 数组（已写入 state.modelCache[provider] 并持久化）
 * @throws 拉取 / 超时 / 解析 / 无模型时抛出（调用方负责 UI 提示，本函数不吞错）
 */
export async function fetchModelsForProvider(provider, overrides = {}) {
    const conf = LLM_PROVIDERS[provider];
    if (!conf) throw new Error('未知服务商: ' + provider);

    // key/url 来源：显式覆盖（设置页暂存）> settings 持久配置（与 api.js 请求层同源）> 死常量兜底
    const key = (overrides.apiKey != null && overrides.apiKey !== '')
        ? overrides.apiKey
        : (state.settings.keys?.[provider] || '');
    const apiUrl = (overrides.apiUrl != null && overrides.apiUrl !== '')
        ? overrides.apiUrl
        : (state.settings.providers?.[provider]?.url || conf.url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    let resp;
    try {
        resp = await fetch(buildModelsUrl(apiUrl), {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + key },
            signal: controller.signal
        });
    } catch (e) {
        throw new Error('模型清单请求失败（' + (e?.name === 'AbortError' ? '超时 ' + (MODELS_TIMEOUT_MS / 1000) + 's 中止' : '网络/CORS') + '）：' + (e?.message || e?.name || e));
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) throw new Error('模型清单拉取失败 HTTP ' + resp.status);

    let data;
    try { data = await resp.json(); } catch (_) { throw new Error('模型清单响应解析失败'); }

    const models = data?.data || data?.models || [];
    if (!models.length) throw new Error('未获取到模型');

    const modelIds = models.map(m => m?.id || m?.name).filter(Boolean);
    if (!modelIds.length) throw new Error('未获取到模型');

    state.modelCache[provider] = modelIds;
    saveToLocal(null, true); // 随全局键落 localStorage（刷新由 loadFromLocal 读回）
    Logger.info('[Models] 已拉取并缓存 ' + provider + ' 模型清单：' + modelIds.length + ' 个');
    return modelIds;
}

/**
 * 读取某服务商的已缓存清单（空缓存返回 []，不拉取）。
 * @param {'zhipu'|'deepseek'} provider @returns {string[]}
 */
export function getProviderModels(provider) {
    return state.modelCache[provider] || [];
}

/**
 * 同步「设置页当前查看服务商」的可用模型列表到 state.availableModels。
 * availableModels 的唯一写入口（main.js 启动恢复 / settings.js 切标签 / 拉取成功后调用），
 * 其余模块一律只读——消灭散落赋值造成的「列表时有时无」双源漂移。
 * @param {'zhipu'|'deepseek'} provider
 */
export function syncAvailableModels(provider) {
    state.availableModels = getProviderModels(provider).slice();
}
