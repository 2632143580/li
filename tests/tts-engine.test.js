/**
 * tts-engine 纯函数单测（Node 环境：无 DOM / 无 speechSynthesis，仅测可隔离逻辑）
 *
 * 覆盖范围：
 *   1. cleanForSpeech 文本清洗（代码块 / 行内码 / URL / markdown 链接 / 符号 / 列表 / 小数 / emoji / 空白）
 *   2. splitSentences 断句与 speak 分段共用同一管线（只验证断句本身，speechSynthesis 调用不在 Node 覆盖）
 *
 * 运行：node tests/tts-engine.test.js
 */
import { cleanForSpeech } from '../src/engines/tts-engine.js';
import { splitSentences } from '../src/core/text-split.js';

let pass = 0;
let fail = 0;

function assertEq(name, got, want) {
    if (got === want) {
        pass++;
        console.log(`  ok  ${name}`);
    } else {
        fail++;
        console.error(`FAIL  ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
    }
}

console.log('== cleanForSpeech ==');

// 1. 空输入
assertEq('空串', cleanForSpeech(''), '');

// 2. 代码块整段移除
assertEq('代码块移除', cleanForSpeech('```js\nlet a = 1\n```\n你好'), '你好');

// 3. 行内代码保留内容
assertEq('行内代码保留', cleanForSpeech('用 `code` 试试'), '用 code 试试');

// 4. URL 移除（尾部空白被统一压缩）
assertEq('URL 移除', cleanForSpeech('访问 https://example.com/abc 看看'), '访问 看看');

// 5. markdown 链接保留显示文本
assertEq('链接保留文本', cleanForSpeech('[标题](https://x.com) 结束'), '标题 结束');

// 6. markdown 强调符号移除
assertEq('强调符号移除', cleanForSpeech('**重要** 和 *斜体*'), '重要 和 斜体');

// 7. 无序列表（行首 - / +）
assertEq('无序列表', cleanForSpeech('- 第一项\n- 第二项'), '第一项 第二项');

// 8. 有序列表（仅行首编号）
assertEq('有序列表', cleanForSpeech('1. 第一步\n2. 第二步'), '第一步 第二步');

// 9. 小数不被误伤（编号匹配限制在行首）
assertEq('小数不误伤', cleanForSpeech('圆周率是 3.14'), '圆周率是 3.14');

// 10. emoji 移除（语气词 ~ 保留，符合断句契约：~ 不是句尾）
assertEq('emoji 移除', cleanForSpeech('你好呀~ 💫 哥哥'), '你好呀~ 哥哥');

// 11. 连续空白压缩为单空格
assertEq('空白压缩', cleanForSpeech('多  个    空格'), '多 个 空格');

// 12. 换行压为单空格（句子间由断句/标点承担停顿）
assertEq('换行压缩', cleanForSpeech('第一行\n第二行'), '第一行 第二行');

console.log('== splitSentences（speak 分段管线） ==');
const seg = splitSentences('第一句。第二句！第三句？没有句号的一段');
assertEq('断句数量', String(seg.length), '4');
assertEq('首段', seg[0], '第一句。');
assertEq('末段（无句号兜底）', seg[seg.length - 1], '没有句号的一段');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
