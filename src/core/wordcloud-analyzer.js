/**
 * 词云「分析」阶段：把消息节点数组转成词频列表。
 *
 * 定位：纯函数、零依赖（与 text-split.js / utils.js 同层），可在 Node 下单测。
 *      渲染层（ui/event-bindings/wordcloud-panel.js）直接消费本模块输出，不重复做分词统计。
 *      其中 byRole 字段是「用户 vs AI 分色」的唯一数据来源——渲染层据此决定每个词的着色。
 *
 * 关键认知（中文分词）：
 *   英文靠空格切词，中文没有空格。若直接按空格切，整句会被当成一个词，词云失去意义。
 *   因此用 Intl.Segmenter(granularity:'word') 做中文分词——它是浏览器/Node 内置 API，零依赖、不破坏单文件打包。
 *   但部分移动端 / WebView 的 ICU 未内置中文分词词典，'word' 粒度会把每个汉字当成独立词
 *   （手机端词云「全是单字」的根因）。故初始化时探测词典可用性：无词典时中文改走相邻 2 字组合（bi-gram）
 *   降级切分，至少比逐字切更有意义；老环境（连 Intl.Segmenter 都没有）同样走这条正则 + bi-gram 回退。
 */

/** 默认停用词：高频但无信息量的词（中文虚词/代词/连词/助词 + 英文常见词），统计时剔除。 @type {Set<string>} */
const DEFAULT_STOPWORDS = new Set([
    // —— 中文：语法功能词与极泛 filler ——
    '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们', '它们',
    '这', '那', '这个', '那个', '这些', '那些', '有', '和', '与', '及', '或', '也', '都',
    '就', '还', '很', '不', '没', '没有', '吗', '呢', '吧', '啊', '呀', '哦', '嘛',
    '把', '被', '让', '给', '对', '从', '向', '到', '于', '以', '为', '之', '其', '此',
    '该', '各', '些', '个', '又', '再', '更', '最', '大', '小', '多', '少', '上', '下',
    '中', '里', '内', '外', '前', '后', '会', '能', '要', '想', '说', '看', '做', '去',
    '来', '出', '进', '回', '过', '得', '着', '怎么', '什么', '怎样', '如何', '为什么',
    '谁', '哪', '多少', '自己', '因为', '所以', '如果', '但是', '然后', '时候', '一个',
    '一种', '可以', '这样', '那样', '已经', '正在', '还是', '可能', '应该', '现在', '今天',
    '昨天', '明天', '的话', '感觉', '觉得', '其实', '真的', '有点', '比较', '非常', '特别',
    '十分', '一样', '一直', '直接', '进行', '通过', '由于', '以及', '并且', '而且', '虽然',
    '然而', '对于', '关于', '按照', '根据', '比如', '例如', '东西', '事情', '问题', '方面',
    '情况', '状态', '系统', '用户', '的话',
    // —— 英文 ——
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'to', 'of', 'in', 'on', 'at', 'for',
    'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these',
    'those', 'it', 'its', 'he', 'she', 'they', 'we', 'you', 'i', 'my', 'your', 'our', 'their',
    'from', 'by', 'about', 'into', 'over', 'under', 'again', 'can', 'will', 'do', 'does',
    'did', 'has', 'have', 'had', 'not', 'no', 'yes', 'so', 'just', 'like', 'get', 'got',
    'would', 'could', 'should', 'what', 'when', 'where', 'why', 'how', 'who', 'which',
    'there', 'here', 'than', 'too', 'very', 'also', 'out', 'up', 'down', 'use', 'using',
    'used', 'one', 'two', 'new', 'via'
]);

/**
 * 全局复用的中文分词器。环境不支持（极老浏览器）时置 null，analyze 走正则 + bi-gram 回退。
 * @type {Intl.Segmenter|null}
 */
const ZH_SEGMENTER = (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function')
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null;

/**
 * 探测 Intl.Segmenter 是否带中文分词词典。
 * 部分移动端 / WebView 的 ICU 未内置 CJK 词典，'word' 粒度会把每个汉字当成一个独立词
 * （手机端词云「全是单字」的根因）。用「今天天气真好」试探：若仍能切出长度 ≥ 2 的中文词，
 * 说明词典可用；否则标记无词典，segmentWords 改走 bi-gram 降级切分。
 * @type {boolean}
 */
const ZH_SEGMENTER_HAS_DICT = ZH_SEGMENTER ? (() => {
    let maxCjkLen = 0;
    for (const { segment } of ZH_SEGMENTER.segment('今天天气真好')) {
        if (/[一-鿿]/.test(segment)) maxCjkLen = Math.max(maxCjkLen, segment.length);
    }
    return maxCjkLen >= 2;
})() : false;

/** 连续中文段 → 相邻 2 字组合（bi-gram）。词典缺失环境下的降级分词，至少比逐字切更有意义。 */
function cjkBigrams(run) {
    const out = [];
    if (run.length <= 1) { if (run) out.push(run); return out; }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    return out;
}

/**
 * 清洗单条消息文本：去掉 markdown 代码块/行内代码/链接/HTML 标签等噪音，只留可读正文。
 * 不改动原文语义，仅剥离会污染词频的结构符号。
 * @param {string} text 原始消息文本
 * @returns {string} 清洗后文本
 */
function cleanText(text) {
    if (typeof text !== 'string') return '';
    return text
        .replace(/```[\s\S]*?```/g, ' ')        // 代码块
        .replace(/`[^`]*`/g, ' ')               // 行内代码
        .replace(/<[^>]+>/g, ' ')              // HTML/XML 标签（如 <thinking>）
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // 图片
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
        .replace(/https?:\/\/\S+/g, ' ')         // 裸链接
        .replace(/www\.\S+/g, ' ');
}

/**
 * 把一段文本切成候选词（已是 wordLike 的词，不含标点/空白）。
 * 优先用 Intl.Segmenter 做中文分词；回退方案按「连续中文段 / 连续英文 / 数字」粗切。
 * @param {string} text
 * @returns {string[]}
 */
function segmentWords(text) {
    const out = [];
    // 有 Segmenter 且带中文词典：直接用其分词结果（桌面端走这条）
    if (ZH_SEGMENTER && ZH_SEGMENTER_HAS_DICT) {
        for (const { segment, isWordLike } of ZH_SEGMENTER.segment(text)) {
            if (!isWordLike) continue;
            const w = segment.trim().toLowerCase();
            if (w) out.push(w);
        }
        return out;
    }
    // 无 Segmenter 或无中文词典（手机端 / 老浏览器）：中文走 bi-gram，英文 / 数字按连续段切
    const m = text.match(/[一-鿿]+|[a-zA-Z]+|\d+/g) || [];
    for (const w of m) {
        if (/[一-鿿]/.test(w)) out.push(...cjkBigrams(w));
        else out.push(w.toLowerCase());
    }
    return out;
}

/**
 * 当前生效的分词器（渲染层共享）：词云切换「轻量 ↔ 专业 jieba」后回写，消息导航等其它消费方直接读取，
 * 保证两者高频词分词口径一致（否则导航高频词不会随词云专业分词切换）。默认内置轻量分词。
 * @type {(text:string)=>string[]}
 */
let activeSegmenter = segmentWords;
/** 回写当前分词器（传非函数则复位为默认轻量分词）。 @param {(text:string)=>string[]} [fn] */
export function setActiveSegmenter(fn) { activeSegmenter = (typeof fn === 'function') ? fn : segmentWords; }
/** 读取当前分词器（供词云 / 消息导航共用）。 @returns {(text:string)=>string[]} */
export function getActiveSegmenter() { return activeSegmenter; }

/**
 * 统计当前路径消息的词频。
 *
 * 入参是「当前对话路径」的节点数组（通常来自 getCurrentPath(state.chatTree)，其首项为 system 根）。
 * 本函数内部按 includeRoles 过滤，默认排除 system 根与 isError 错误节点，因此调用方无需预筛。
 *
 * @param {Array<{role:string, content:string, isError?:boolean}>} nodes 消息节点数组
 * @param {object} [options]
 * @param {string[]} [options.includeRoles=['user','assistant']] 只统计这些角色
 * @param {number}  [options.topN=50] 返回前 N 个（按词频降序）；传 0 或负数表示全部
 * @param {Iterable<string>} [options.stopwords] 自定义停用词（覆盖默认）
 * @param {boolean} [options.skipNumbers=true] 是否跳过纯数字词（如年份/ID）
 * @param {number}  [options.minLength=1] 词的最小字符数，短于此值的词丢弃（用于滤掉单字噪音）
 * @param {number}  [options.maxCharsPerNode=50000] 单条消息参与分词的最大字符数，超出部分截断不计入统计。
 *   目的：防御异常超长消息（如整本文档粘贴）导致分词耗时过长卡住 UI。传 0 或负数表示不限制。
 * @param {(text:string)=>string[]} [options.segment] 自定义分词函数（入参为已清洗文本，返回值需已小写、不含空白）。
 *   默认用内置轻量分词（Intl.Segmenter，无词典回退 bi-gram）。专业分词（jieba-wasm）由渲染层注入，走同一统计管线，
 *   停用词/纯数字/minLength 过滤在管线内统一执行，两个分词器行为一致。
 * @returns {Array<{word:string, count:number, byRole:Object<string,number>}>} 降序词频列表。
 *   byRole 的键是角色名（'user' / 'assistant' 等，取自节点 role），值是该角色贡献的出现次数；
 *   各值之和恒等于 count。渲染层用它算「用户占比」来决定分色。
 */
export function analyzeWordFreq(nodes, options = {}) {
    const {
        includeRoles = ['user', 'assistant'],
        topN = 50,
        stopwords,
        skipNumbers = true,
        minLength = 1,
        maxCharsPerNode = 50000,
        segment
    } = options;

    const roleSet = new Set(includeRoles);
    const stop = stopwords ? new Set(stopwords) : DEFAULT_STOPWORDS;
    const seg = segment || segmentWords;

    /** 词 → 总次数。 @type {Map<string, number>} */
    const freq = new Map();
    /** 词 → (角色 → 该角色贡献次数)。 @type {Map<string, Map<string, number>>} */
    const roleFreq = new Map();

    if (Array.isArray(nodes)) {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            if (node.isError) continue;
            if (!roleSet.has(node.role)) continue;

            let text = typeof node.content === 'string' ? node.content : '';
            if (maxCharsPerNode > 0 && text.length > maxCharsPerNode) {
                text = text.slice(0, maxCharsPerNode);
            }
            const raw = cleanText(text);

            for (const word of seg(raw)) {
                // 标点/符号过滤：词必须纯由字母或数字构成（中文汉字属 \p{L}），含任何标点（含 CJK 标点）即丢弃。
                // 轻量分词两条路本就不产出标点，此规则主要兜住 jieba（cut 会把「，。」等当独立词切出）。
                if (!/^[\p{L}\p{N}]+$/u.test(word)) continue;
                if (skipNumbers && /^\d+$/.test(word)) continue;
                if (stop.has(word)) continue;
                if (word.length < Math.max(1, minLength)) continue;

                freq.set(word, (freq.get(word) || 0) + 1);

                let perRole = roleFreq.get(word);
                if (!perRole) {
                    perRole = new Map();
                    roleFreq.set(word, perRole);
                }
                perRole.set(node.role, (perRole.get(node.role) || 0) + 1);
            }
        }
    }

    const list = [...freq.entries()].map(([word, count]) => ({
        word,
        count,
        byRole: Object.fromEntries(roleFreq.get(word) || [])
    }));
    list.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

    return (topN && topN > 0) ? list.slice(0, topN) : list;
}
