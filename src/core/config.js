/**
 * 集中配置层（用户 2026-08-22 要求：配置集中、不与业务挤在一起）
 *
 * 原则：
 *   - 这里只放「死」的常量：端点 URL / 默认模型 / 默认音色。它们不随用户走、不进序列化存档。
 *   - url 是死的 → 硬编码；model 是现拉的（用户在设置里从 /models 拉取覆盖）/ 固定的 → 常量；
 *     key 是敏感的 → 只存 localStorage（见 core/constants.js 的 keys / apiKey / ttsCloud.apiKey）。
 *   - 改一处即全局生效，避免散落在 UI / 引擎文件里。
 *
 * 依赖：无（被 engines/tts-engine、ui/event-bindings/msg-nav-panel、chat/api 引用）
 */

/** 内置 LLM 服务商：端点 URL + 默认模型（url 硬编码，不入序列化；model 为官方默认，用户可在设置里现拉覆盖）。 */
export const LLM_PROVIDERS = {
    zhipu:    { name: '智谱',     url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-air' },
    deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions',         model: 'deepseek-v4-flash' }
};

/** 云端 TTS（MiMo-V2.5-TTS）固定端点 / 模型 / 默认音色（url 硬编码，不入序列化；key 仅存 local）。 */
export const TTS_CLOUD = {
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default'
};
