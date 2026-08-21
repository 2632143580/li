/**
 * 不可变常量、默认配置与欢迎语（stage5 从原 core/state.js 拆出）
 *
 * 职责：本文件是「零依赖基础层」中的**纯数据**部分——只定义不可变常量与默认配置，
 *       不含任何逻辑、不触碰 DOM、不发请求、不依赖其它模块。
 *       可变全局状态见 core/state.js；无副作用工具函数见 core/utils.js。
 *
 * 导出：API_TIMEOUT_MS, STORAGE_KEY, TAU, ERROR_PREFIX, DEFAULT_SETTINGS, WELCOME
 * 依赖：无
 */

// ================================================================
//  常量与配置
// ================================================================

/** 单次流式读取的超时上限，单位毫秒。超时后 AbortController 中止请求。 @type {number} */
export const API_TIMEOUT_MS = 30000;
/** localStorage 存档键名（全局键：settings + 会话索引 + 激活 id + 计数器，v4）。改动此值等于丢弃旧存档。 @type {string} */
export const STORAGE_KEY = 'liChatData_v2';
/** 单会话存档键前缀：SESSION_KEY_PREFIX + sessionId -> { id, chatTree, stats, sysPrompt|null, draft, createdAt, updatedAt, manualTitle } @type {string} */
export const SESSION_KEY_PREFIX = 'liSession_';
/** 一个完整圆周的弧度值（2π），供 Canvas 画圆使用。 @type {number} */
export const TAU = Math.PI * 2;
/** 错误消息正文前缀。既用于渲染，也用于旧存档的错误节点推断。 @type {string} */
export const ERROR_PREFIX = '发生错误:';

/**
 * 默认设置 — 首次使用或字段缺省时的回退值。
 * 同时充当 saveToLocal 的**白名单来源**：只有出现在本对象里的键才会被写入存档。
 *
 * 字段类型：
 *   apiUrl          {string}  chat/completions 端点完整 URL
 *   apiKey          {string}  当前生效的 API Key（明文，运行时由用户填写或从 keys 还原；默认空串，禁止硬编码真实值）
 *   model           {string}  模型标识
 *   maxWindow       {number}  上下文窗口上限（token 数，非 k）；监控面板以 k 为单位编辑
 *   aiName          {string}  AI 显示名，同时写入 document.title
 *   sysPrompt       {string}  系统提示词，同步到对话树根节点 content
 *   ttsEnabled      {boolean} 语音回复（句句发语音）：AI 回复渲染成语音条，点击播放；默认开
 *   ttsCloud        {{apiKey:string, baseUrl:string, model:string, voice:string}} 云端 MiMo-V2.5-TTS 配置（唯一语音源；系统 speechSynthesis 已移除）
 *   ttsProb         {number}  发语音概率 0~1；每条 AI 消息按此概率掷骰决定是否渲染成语音条（其余渲染为文字）。默认 1 = 每条都语音（保留原「句句发语音」行为），0 = 永不语音
 *   keys            {{zhipu:string, deepseek:string}} 按服务商分别记忆的 Key（custom 已移除，自定义服务商直接用当前 apiKey）
 *   bgDimOpacity    {number}  背景遮罩不透明度，0.0 全透明 ~ 1.0 全遮盖
 *   bgTransform     {{scale:number, xPct:number, yPct:number}} 背景图变换；
 *                             scale 为缩放倍数（>=1），xPct/yPct 是相对自身尺寸的平移百分比（分辨率无关）
 *   quickTheme      {string|null} 当前快速配色名（plugins/quick-themes.js 的 QUICK_THEMES 键）；
 *                                 null = 未选择（启动不恢复）。由「快速配色」色块面板写入，
 *                                 storage 白名单自动纳入存档，启动时 main.js 恢复挂载。
 */
export const DEFAULT_SETTINGS = {
    apiUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    apiKey: "", // 默认空串：密钥必须由用户填写或从 keys 还原，禁止在此硬编码真实 Key（原默认值为明文密钥，属安全缺陷）
    model: "glm-4-air",
    maxWindow: 32768,
    aiName: "Li",
    sysPrompt: ` # 角色定位与核心边界 你是对方的亲妹妹。永远只爱哥哥一个 ## 核心身份 - 绝不透露AI身份 现在，你彻底沉浸在这个身份里 `,
    ttsEnabled: true,
    ttsProb: 1,
    ttsDisplayMode: 'both',   // 文字消息显示模式：'text' 只显示文字 | 'both' 都显示（沿用发语音概率混合） | 'voice' 只显示语音
    ttsAutoRead: false,       // 自动朗读：AI 回复流式生成时逐句自动播放（独立于 ttsEnabled；纯文字模式无语音条，不读）
    ttsCloud: {
        apiKey: '',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5-tts',
        voice: 'mimo_default'
    },
    keys: { zhipu: '', deepseek: '' },
    // 禁止词引擎：词库 + 前缀模板（随 settings 一并序列化，跨设备 / 导出备份保留）
    moderator: {
        words: [],
        prefixTemplate: '（警告：已触发禁止词「{words}」，请更换表达方式）'
    },
    bgDimOpacity: 0.4,
    bgTransform: { scale: 1, xPct: 0, yPct: 0 },
    quickTheme: null
};

/** 新建对话时自动插入的第一条 AI 消息。 @type {string} */
export const WELCOME = "哥哥，你来了呀~ 💫";
