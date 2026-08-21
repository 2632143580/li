/**
 * 集中配置层（用户 2026-08-22 要求：配置集中、不与业务挤在一起）
 *
 * 原则：
 *   - 这里只放「死」的常量：端点 URL / 中文名 / 默认音色。它们不随用户走、不进序列化存档、不进构建产物。
 *   - 服务商 url 是死的 → 硬编码；模型不写死于此，由设置页「拉取模型」实时从 /models 拉取、按服务商存 localStorage（state.modelCache）；
 *     key 是敏感的 → 只存 localStorage（见 core/constants.js 的 keys / apiKey / ttsCloud.apiKey）。
 *   - 改一处即全局生效，避免散落在 UI / 引擎文件里。
 *
 * 依赖：无（被 engines/tts-engine、ui/event-bindings/msg-nav-panel、chat/api 引用）
 */

// 内置 LLM 服务商：仅死常量（端点 URL + 中文名）。模型不在此硬编码——
// 模型由设置页「拉取模型」实时请求 /models 拉取，存 localStorage（state.modelCache），不进构建产物、不进导出备份。
export const LLM_PROVIDERS = {
    zhipu:    { name: '智谱',     url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
    deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions' }
};

/** 云端 TTS（MiMo-V2.5-TTS）固定端点 / 模型 / 默认音色（url 硬编码，不入序列化；key 仅存 local）。 */
export const TTS_CLOUD = {
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts',
    voice: 'mimo_default'
};
