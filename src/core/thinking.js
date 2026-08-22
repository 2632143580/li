/**
 * 思考强度预设（用户 2026-08-22 要求：设置页可按模型选择思考强度）。
 *
 * 预设与参数口径（官方文档核实）：
 *   - DeepSeek V4-Pro / V4-Flash：OpenAI 格式 `reasoning_effort: low|high|max`（默认 high）
 *     + `thinking: {type:'enabled'}` 开思考（api.js 原有行为，保留）。
 *     来源：api-docs.deepseek.com/zh-cn/updates「V4-Pro 和 V4-Flash 思考模式现支持 low/high/max」。
 *   - GLM-4.5 Air：`thinking: {type:'enabled'|'disabled'}`，enabled=动态思考（默认）。
 *     来源：docs.bigmodel.cn GLM-4.5 文档「thinking.type 参数 enabled（动态）/ disabled（禁用）」。
 *   - GLM-4.6V：`reasoning_effort: low|high|max`（低/增强/深度推理）。GLM-4.5+ 服务端默认
 *     开启动态思考，无需重复传 thinking.type。
 *     来源：docs.bigmodel.cn 核心参数「reasoning_effort：max high low 控制模型的推理程度，
 *     low 轻量思考 / high 增强思考 / max 深度思考（默认值）」。
 *
 * 非预设模型：维持 api.js 原有兜底（/v4|reasoner|r1|thinking/ 命中则 thinking enabled，
 * 其余不传参走服务端默认），见 buildThinkingBody。
 */

/**
 * @typedef {Object} ThinkingPreset
 * @property {string} id 预设标识
 * @property {string} title 展示名（设置页小字提示用）
 * @property {function(string):boolean} match 模型名匹配（不区分大小写，兼容 -/_/空格分隔）
 * @property {{value:string, label:string}[]} options 选项（value=API 参数值，label=界面文案）
 * @property {string} default 默认档位（用户未选/存档值不合法时回落）
 */

/** 匹配分隔符差异：glm-4.5-air / glm_4_5_air / GLM-4.5 Air / glm.4.5.air 统一成小写无分隔形式再比较
 *  （注意「.」也是分隔符——GLM 官方模型名带点版本号，漏掉会导致 glm-4.5-air 归一成 glm4.5air 匹配失败，实测抓到过） */
const normalize = (m) => String(m || '').toLowerCase().replace(/[-_.\s]+/g, '');

export const THINKING_PRESETS = [
    {
        id: 'deepseek-v4',
        title: 'DeepSeek V4-Pro / V4-Flash',
        match: (m) => {
            const n = normalize(m);
            return n.includes('deepseekv4pro') || n.includes('deepseekv4flash')
                || (/^deepseekv4/.test(n) && /pro|flash/.test(n));
        },
        options: [
            { value: 'low', label: 'low' },
            { value: 'high', label: 'high' },
            { value: 'max', label: 'max' },
        ],
        default: 'high',
    },
    {
        id: 'glm-4.5-air',
        title: 'GLM-4.5 Air',
        match: (m) => {
            const n = normalize(m);
            return n.startsWith('glm45air') || /glm45.*air/.test(n) || /glm45air/.test(n);
        },
        options: [
            { value: 'enabled', label: '开启动态思考（默认）' },
            { value: 'disabled', label: '关闭思考' },
        ],
        default: 'enabled',
    },
    {
        id: 'glm-4.6v',
        title: 'GLM-4.6V',
        match: (m) => /glm46v/.test(normalize(m)),
        options: [
            { value: 'low', label: '轻量推理' },
            { value: 'high', label: '增强推理' },
            { value: 'max', label: '深度推理' },
        ],
        default: 'max',
    },
];

/** 按模型名取预设；无匹配返回 null @returns {ThinkingPreset|null} */
export function matchThinkingPreset(model) {
    return THINKING_PRESETS.find((p) => p.match(model)) || null;
}

/**
 * 归一用户的思考档位选择：预设内合法值直用，否则回落预设默认档。
 * @param {ThinkingPreset|null} preset @param {string} effortSetting @returns {string}
 */
export function resolveEffort(preset, effortSetting) {
    if (!preset) return '';
    return preset.options.some((o) => o.value === effortSetting) ? effortSetting : preset.default;
}

/**
 * 构建请求思考参数片段（api.js 消费）。
 * @param {string} model 生效模型名（会话级覆盖优先后的值）
 * @param {string} effortSetting state.settings.reasoningEffort（用户选择，可能为空/过期）
 * @returns {{thinking?:{type:string}, reasoning_effort?:string}} 合并进 reqBody 的对象
 */
export function buildThinkingBody(model, effortSetting) {
    const preset = matchThinkingPreset(model);
    if (preset) {
        const effort = resolveEffort(preset, effortSetting);
        if (preset.id === 'glm-4.5-air') {
            return { thinking: { type: effort } }; // enabled/disabled
        }
        if (preset.id === 'glm-4.6v') {
            return { reasoning_effort: effort }; // 服务端默认已开思考，仅控强度
        }
        return { thinking: { type: 'enabled' }, reasoning_effort: effort }; // deepseek-v4
    }
    // 非预设模型：保留原有兜底（v4/reasoner/r1/thinking 系显式开思考，确保返回思维链）
    return /v4|reasoner|r1|thinking/i.test(model) ? { thinking: { type: 'enabled' } } : {};
}
