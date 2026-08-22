/**
 * 模型清单拉取与缓存（治本修复：会话芯片快切时保证目标服务商有合法 model）
 *
 * 职责：给定服务商，向该服务商的 /models 端点拉取模型清单，写入 state.modelCache[provider]
 *      并随全局键持久化（saveToLocal）。供「会话芯片快切」与「设置页拉取模型」复用，
 *      消除两处重复 fetch、保证 URL 变换 / 解析 / 缓存口径单一事实源。
 *
 * 依赖：core/state、core/config、core/storage、core/logger、core/utils
 */

import { state } from './state.js';
import { LLM_PROVIDERS } from './config.js';
import { saveToLocal } from './storage.js';
import { Logger } from './logger.js';

/**
 * 由 chat/completions 端点推导 /models 端点（与设置页 btnFetchModels 规则的 URL 变换一致）。
 * @param {string} apiUrl chat/completions 完整 URL @returns {string}
 */
function buildModelsUrl(apiUrl) {
    let u = String(apiUrl || '').replace(/\/chat\/completions/, '/models');
    if (!u.endsWith('/models')) u = u.replace(/\/$/, '') + '/models';
    return u;
}

/**
 * 拉取并缓存某服务商的模型清单（治本核心：让「会话芯片快切」也能自动配套合法 model，
 * 杜绝 handleQuickLlmSwitch 在清单为空时落 model:'' 而把空串送进 API → DeepSeek 报 "passed ."）。
 *
 * @param {'zhipu'|'deepseek'} provider 服务商标识
 * @param {string} [apiKey] 覆盖用 key：设置页暂存态可传 tempSettings.keys[provider]；未传则取
 *        settings.keys[provider]（与 api.js 请求层同源）。
 * @returns {Promise<string[]>} 模型 id 数组（已写入 state.modelCache[provider] 并持久化）
 * @throws 拉取 / 解析 / 无模型时抛出（调用方负责 UI 提示，本函数不吞错）
 */
export async function fetchModelsForProvider(provider, apiKey) {
    const conf = LLM_PROVIDERS[provider];
    if (!conf) throw new Error('未知服务商: ' + provider);

    // key 来源：显式覆盖（设置页暂存）> settings.keys[provider]（按服务商分桶记忆，无顶层兜底）
    const key = (apiKey != null && apiKey !== '')
        ? apiKey
        : (state.settings.keys?.[provider] || '');

    let resp;
    try {
        resp = await fetch(buildModelsUrl(conf.url), {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + key }
        });
    } catch (e) {
        throw new Error('模型清单请求失败（网络/CORS）：' + (e.message || e.name));
    }
    if (!resp.ok) throw new Error('模型清单拉取失败 HTTP ' + resp.status);

    let data;
    try { data = await resp.json(); } catch (_) { throw new Error('模型清单响应解析失败'); }

    const models = data?.data || data?.models || [];
    if (!models.length) throw new Error('未获取到模型');

    const modelIds = models.map(m => m?.id || m?.name).filter(Boolean);
    if (!modelIds.length) throw new Error('未获取到模型');

    state.modelCache[provider] = modelIds;
    saveToLocal(null, true); // 随全局键落 localStorage（刷新不丢）
    Logger.info('[Models] 已拉取并缓存 ' + provider + ' 模型清单：' + modelIds.length + ' 个');
    return modelIds;
}
