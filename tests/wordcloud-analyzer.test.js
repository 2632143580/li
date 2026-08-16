/**
 * 词频分析模块单测（Node ESM，零依赖）。
 * 运行：node tests/wordcloud-analyzer.test.js
 */
import { analyzeWordFreq } from '../src/core/wordcloud-analyzer.js';

let pass = 0;
let fail = 0;

function check(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass++;
        console.log('  PASS  ' + msg);
    } else {
        fail++;
        console.error('  FAIL  ' + msg);
        console.error('     expected: ' + e);
        console.error('     actual  : ' + a);
    }
}

// 1. 异常/空输入安全（不崩、返回空数组）
check(analyzeWordFreq(null), [], 'null → 空数组');
check(analyzeWordFreq(undefined), [], 'undefined → 空数组');
check(analyzeWordFreq([]), [], '空数组 → 空数组');
check(analyzeWordFreq([{ role: 'user', content: 123 }]), [], 'content 非字符串被跳过');
check(analyzeWordFreq([{ role: 'user' }]), [], '缺 content 被跳过');

// 2. 中文分词 + 停用词过滤 + 角色/错误节点排除
const nodes = [
    { role: 'system', content: '系统提示词：你是助手' },           // 应被排除（system）
    { role: 'user', content: '今天天气真好我们去公园散步吧' },
    { role: 'assistant', content: '天气好的时候去公园散步确实很舒服，公园里空气也好。' },
    { role: 'assistant', content: '请求失败', isError: true }        // 应被排除（isError）
];

const r = analyzeWordFreq(nodes);
const words = r.map((x) => x.word);
console.log('  词频示例: ' + JSON.stringify(r.slice(0, 8)));

check(words.includes('系统提示词'), false, 'system 节点被排除');
check(words.includes('请求失败'), false, 'isError 节点被排除');
check(words.includes('的'), false, '停用词「的」被过滤');
check(words.includes('吧'), false, '停用词「吧」被过滤');
check(words.includes('好'), false, '停用词「好」被过滤');

// user 节点含 1 个「公园」，assistant 节点含 2 个（去公园散步 / 公园里空气），共 3 次
const gongyuan = r.find((x) => x.word === '公园');
check(gongyuan ? gongyuan.count : 0, 3, '「公园」在两个有效节点共出现 3 次');

// 3. topN 限制
check(analyzeWordFreq(nodes, { topN: 1 }).length, 1, 'topN=1 只返回 1 条');
check(analyzeWordFreq(nodes, { topN: 0 }).length, r.length, 'topN=0 返回全部');

// 4. includeRoles 过滤
const onlyUser = analyzeWordFreq(nodes, { includeRoles: ['user'] });
check(onlyUser.every((x) => x.word.length >= 1), true, 'includeRoles=user 正常产出');
check(onlyUser.find((x) => x.word === '公园') ? true : false, true, 'includeRoles=user 含 user 节点词「公园」');

// 5. 纯数字跳过
const nums = analyzeWordFreq([{ role: 'user', content: '2024 2024 2025 测试' }]);
check(nums.every((x) => !/^\d+$/.test(x.word)), true, '纯数字词被跳过');
check(nums.some((x) => x.word === '测试'), true, '中文词「测试」保留');

// 6. 英文分词 + 大小写合并
const en = analyzeWordFreq([{ role: 'user', content: 'Hello hello WORLD world test' }]);
const hello = en.find((x) => x.word === 'hello');
check(hello ? hello.count : 0, 2, '英文 hello/Hello 大小写合并计数=2');
check(en.find((x) => x.word === 'world') ? true : false, true, 'world/WORLD 合并');

// 7. byRole 角色分布（词云分色的数据基础）
// 「公园」user 贡献 1 次、assistant 贡献 2 次
check(gongyuan ? gongyuan.byRole : null, { user: 1, assistant: 2 }, 'byRole 记录「公园」的用户/AI 分别贡献次数');

// 不变式：byRole 各值之和必须恒等于 count，否则分色占比会算错
const sumOk = r.every((x) => Object.values(x.byRole).reduce((s, n) => s + n, 0) === x.count);
check(sumOk, true, 'byRole 各角色次数之和恒等于 count');

// 单一角色词只出现该角色的键
// 注意：JS 标识符允许中文，`const散步` 会被当成一个合法变量名而非 `const 散步`，
// 结果是运行时 ReferenceError 而非语法错误。故此处统一用 ASCII 变量名。
const sanbu = r.find((x) => x.word === '散步');
check(sanbu ? Object.keys(sanbu.byRole).sort() : [], ['assistant', 'user'], '双方都说过的词含两个角色键');
const onlyUserWord = analyzeWordFreq([{ role: 'user', content: '独有词汇独有词汇' }])[0];
check(onlyUserWord ? onlyUserWord.byRole : null, { user: 2 }, '仅用户说过的词 byRole 只含 user 键');

// 8. minLength 过滤单字噪音
const single = analyzeWordFreq([{ role: 'user', content: '猫狗鸟量子力学' }], { minLength: 2 });
check(single.every((x) => x.word.length >= 2), true, 'minLength=2 过滤掉所有单字词');
check(analyzeWordFreq([{ role: 'user', content: '量子力学' }], { minLength: 1 }).length > 0, true, 'minLength=1 为默认行为，不误杀');

// 9. maxCharsPerNode 超长消息截断保护
const longText = '苹果'.repeat(100) + '香蕉'.repeat(100);   // 前 200 字符全是「苹果」
const capped = analyzeWordFreq([{ role: 'user', content: longText }], { maxCharsPerNode: 200 });
check(capped.some((x) => x.word === '苹果'), true, 'maxCharsPerNode 截断后前半段词仍统计');
check(capped.some((x) => x.word === '香蕉'), false, 'maxCharsPerNode 截断后超出部分不计入');
check(analyzeWordFreq([{ role: 'user', content: longText }], { maxCharsPerNode: 0 }).some((x) => x.word === '香蕉'), true, 'maxCharsPerNode=0 表示不限制');

// 10. 自定义分词器注入（jieba/专业分词走同一统计管线，过滤规则统一在管线内执行）
const injected = analyzeWordFreq(
    [{ role: 'user', content: '我|天安门|天安门|广场' }],
    { segment: (t) => t.split('|').filter(Boolean).map((w) => w.trim().toLowerCase()) }
);
const tianAnMen = injected.find((x) => x.word === '天安门');
check(tianAnMen ? tianAnMen.count : 0, 2, '注入分词器：自定义切分后「天安门」计 2 次');
check(injected.every((x) => Object.values(x.byRole).reduce((s, n) => s + n, 0) === x.count), true, '注入分词器：byRole 之和恒等于 count 不变式仍成立');
check(injected.some((x) => x.word === '我'), false, '注入分词器：停用词「我」被统一过滤');

// 11. 标点过滤（管线级，统一兜住 jieba：其 cut 会把「，。」等当独立词切出）
const withPunct = analyzeWordFreq(
    [{ role: 'user', content: '任意文本' }],
    { segment: () => ['我爱', '天安门', '，', '。', '广场'] }   // 模拟 jieba：词与标点混排
);
check(withPunct.some((x) => x.word === '，'), false, '标点过滤：中文逗号不进词频');
check(withPunct.some((x) => x.word === '。'), false, '标点过滤：中文句号不进词频');
check(withPunct.some((x) => x.word === '天安门'), true, '标点过滤：正文词仍正常统计');
const punctOnly = analyzeWordFreq(
    [{ role: 'user', content: '……。？！' }],
    { segment: (t) => t.split('') }
);
check(punctOnly.length, 0, '标点过滤：纯标点文本统计结果为空');

console.log(`\n词频分析单测: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
