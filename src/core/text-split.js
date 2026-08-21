/**
 * 把一段文本按【句子结尾标点 + 段落换行】拆成数组，供 AI 消息的分句气泡渲染
 * （2026-08-21 起分句是 AI 纯文字消息的唯一渲染方式，不再有开关；"waifu 模式"为其历史名）。
 *
 * 渲染契约（与 bug 强相关，务必理解）：
 *   返回的每段会作为一条语音条（.vt）/ 一句都显示文字，或一个分句气泡块（.waifu-bubble）。
 *   因此「返回几段 = 视觉几行」。多拆一段就多一行——必须只在该断的地方断。
 *
 * 断句触发（两层）：
 *   1. 真句尾标点：中文 。！？。
 *      - 语气词 ~ ～ 与省略号 … 不是句子结尾，绝不可在此断句：
 *        否则"哥哥，你来了呀~"这种单行问候会被拆成多行气泡，表现成
 *        "开启 waifu 后文本莫名换行"（本仓库已修复的真实 bug）。
 *      - 半角 ! ? 有意不纳入：本界面以中文全角标点为准，避免英文碎片被过度拆分；
 *        如后续需要再按需扩展，但不要为"语气词"开特例。
 *   2. 段落换行符 \n（仅当 buf 非空时触发）：
 *      - 解决"小说体/口语体"AI 输出无句号场景——模型常用 "逗号+换行" 排版（角色扮演尤其常见），
 *        整段无 。！？ 时旧版本会塌缩成【一个气泡】，宽度被 fit-content 到容器上限并触发 pre-wrap 折行，
 *        表现成"宽度固定 + 不该有的换行"（本会话修复的真实 bug）。
 *      - buf 非空时遇到 \n → 把当前 buf 作为一段 push（段落分隔），buf 清零。
 *      - buf 为空时遇到 \n → continue 丢弃（"段间裸换行"，避免空气泡与幽灵空行）。
 *
 * 关于"用户有意内换行"的取舍：
 *   旧版本把 buf 非空时的 \n 保留进 buf，让 pre-wrap 在气泡内显示换行。
 *   新版本把 \n 当作段落分隔断句——这是为了把 AI 排版段落拆成多个气泡。
 *   副作用：用户粘贴的多行单段内容也会被拆成多泡。如需旧行为，未来可加配置开关；
 *   当前默认以"AI 输出分段体验"为优先。
 *
 * @param {string} text 原始文本 @returns {Array<string>} 句子数组；空串返回 ['']（调用方据此跳过空气泡）
 */
export function splitSentences(text) {
    if (!text) return [''];
    const arr = [];
    let buf = '';
    for (const ch of text) {
        if (ch === '\n') {
            // 段间裸换行：buf 为空时直接丢弃（空白分隔符），避免空气泡与幽灵空行。
            if (buf === '') continue;
            // buf 非空：把当前 buf 作为一段 push，\n 作为段落分隔（解决"小说体"无句号整段塌缩 bug）。
            arr.push(buf);
            buf = '';
            continue;
        }
        buf += ch;
        // 仅真正的句子结尾标点触发断句（语气词/省略号已排除）。
        if ('。！？'.includes(ch)) {
            arr.push(buf);
            buf = '';
        }
    }
    if (buf) arr.push(buf);
    // 全换行输入（如 "\n\n\n"）：buf 始终为空、arr 为空，切不可返回原串（会让调用方渲染出带裸换行的气泡）。
    // 与空串契约一致，返回 ['']，调用方据此跳过空气泡。
    if (!arr.length) return [''];
    return arr;
}

/**
 * 把文本拆成交替的 text / action 段（AI 消息的动作分离渲染）。
 *
 * 语义（与产品决策对齐，2026-08-21）：
 *   - action = 被 () 或 （） 包裹的内容（角色扮演里的动作/神态，如"(轻笑)"）。
 *     AI 纯文字消息中，action 段不再进入气泡，改以 .waifu-action 轻提示展示在气泡之间；
 *     语音条/都显示模式在更上游用 stripActions() 整段剔除（语音不读动作）。
 *   - 嵌套括号只取最外层一对（"(a(b)c)" → action "a(b)c"）；同类括号配对计数
 *     （半角配半角、全角配全角），异类括号 "(a（b）c)" 同样取到最外层。
 *   - 未闭合括号（流式生成中括号还没出现，或模型输出笔误）：从开括号到结尾整体视为普通 text，
 *     不报错；闭合瞬间（下一帧流式渲染）自然切出 action 段。
 *   - 空括号 / 纯空白内容括号：跳过，不生成段。
 *
 * @param {string} text 原始文本
 * @returns {Array<{type:'text'|'action', text:string}>} 交替段数组；
 *          空串返回 [{type:'text', text:''}]（调用方据此跳过空气泡）；
 *          纯 action 输入仅返回 action 段（无空文本段混入）
 */
export function splitWaifuSegments(text) {
    if (!text) return [{ type: 'text', text: '' }];
    const segs = [];
    let buf = '';
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '(' || ch === '（') {
            // 找同类型闭括号：同类计数取最外层（嵌套 "(a(b)c)" 的 depth 会先 2 后归 0）
            const close = ch === '(' ? ')' : '）';
            let depth = 0;
            let end = -1;
            for (let j = i; j < text.length; j++) {
                if (text[j] === ch) depth++;
                else if (text[j] === close) {
                    depth--;
                    if (depth === 0) { end = j; break; }
                }
            }
            if (end === -1) {
                // 未闭合：剩余全部归 text（流式期间括号未闭合的中间态也走这里）
                buf += text.slice(i);
                break;
            }
            const inner = text.slice(i + 1, end).trim();
            // 空括号/纯空白内容：跳过且不 flush buf——前后文本无缝连接（否则一对空括号会把一句话切成两个气泡）
            if (inner) {
                if (buf) { segs.push({ type: 'text', text: buf }); buf = ''; }
                segs.push({ type: 'action', text: inner });
            }
            i = end + 1;
        } else {
            buf += ch;
            i++;
        }
    }
    if (buf) segs.push({ type: 'text', text: buf });
    if (!segs.length) return [{ type: 'text', text: '' }];
    return segs;
}

/**
 * 剔除文本中的 action 段（括号+内容整体移除），供语音条 / 都显示模式过滤：
 * 动作描写不进语音朗读队列、不生成语音条（cleanForSpeech 只删括号符号、保留内容，拦不住——
 * 必须在断句之前整段剔除，这也是 action 过滤选在 voice-tiles 层而非 tts-engine 层的原因）。
 * @param {string} text 原始文本 @returns {string} 移除 action 段后的文本
 */
export function stripActions(text) {
    if (!text) return '';
    return splitWaifuSegments(text)
        .filter(s => s.type === 'text')
        .map(s => s.text)
        .join('');
}
