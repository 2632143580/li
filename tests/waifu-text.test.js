/**
 * waifu 文本渲染 + 插件加载 边界测试
 *
 * 运行：node tests/waifu-text.test.js
 * 说明：本文件是 Node ESM 测试（.js），不是插件；插件才是 .txt 非模块格式。
 *
 * 覆盖：
 *   1) splitSentences 边界（核心 bug 修复：~ ～ … 不再断句，仅 。！？ 断句）
 *   2) 插件场景：模拟应用内插件加载器（new Function 求值），
 *      - 合法 .txt 插件（非模块，return 对象）→ 正常加载并按特征嗅探分发
 *      - 非法 .txt 插件（含 import/export）→ 抛出清晰中文引导，不再裸报
 *        "Cannot use import statement outside a module"
 */
import { splitSentences, splitWaifuSegments, stripActions } from '../src/core/text-split.js';

// ── 模拟应用内插件加载器（与 src/chat/api.js 的 import 分支一致）──
function loadPlugin(codeString) {
    let pluginObj;
    try {
        const func = new Function(codeString);
        pluginObj = func();
    } catch (evalErr) {
        // 插件必须是「非模块」.txt：靠文件末尾 return {...} 返回对象，不能含 import/export
        if (/\b(import|export)\b/.test(codeString)) {
            throw new Error('插件必须是非模块 .txt 文件，不能包含 import/export 语句；请删除 import/export，用文件末尾 return 返回对象（参照导出的主题模板）');
        }
        throw evalErr;
    }
    if (!pluginObj || typeof pluginObj !== 'object') throw new Error('格式错误：未返回有效对象');
    const hasCanvasBg = typeof pluginObj.init === 'function' && typeof pluginObj.animate === 'function';
    const hasDomBg = pluginObj.type === 'dom' && typeof pluginObj.onMount === 'function';
    const hasBg = hasCanvasBg || hasDomBg;
    const hasTheme = !!(pluginObj.meta && (typeof pluginObj.meta.cssText === 'string' || (pluginObj.meta.tokens && typeof pluginObj.meta.tokens === 'object')));
    return { pluginObj, hasCanvasBg, hasDomBg, hasBg, hasTheme };
}

// ── 测试框架 ──
let passed = 0, failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ===== 一、splitSentences 边界 =====
test('WELCOME 问候(含~与emoji) 不换行 → 单段', () => {
    const r = splitSentences('哥哥，你来了呀~ 💫');
    if (r.length !== 1) throw new Error('应为单段，实际 ' + JSON.stringify(r));
});
test('~ 语气词不再断句', () => {
    const r = splitSentences('好呀~我们走吧');
    if (r.length !== 1) throw new Error('应为单段，实际 ' + JSON.stringify(r));
});
test('～ 全角语气词不再断句', () => {
    const r = splitSentences('来嘛～陪我聊天');
    if (r.length !== 1) throw new Error('应为单段，实际 ' + JSON.stringify(r));
});
test('… 省略号不再断句', () => {
    const r = splitSentences('在想你…真的');
    if (r.length !== 1) throw new Error('应为单段，实际 ' + JSON.stringify(r));
});
test('真实句尾 。！？ 正常断句', () => {
    const r = splitSentences('今天天气不错。你想去哪里？他来了！');
    if (r.length !== 3) throw new Error('应为 3 段，实际 ' + JSON.stringify(r));
});
test('空串返回单元素空串（调用方据此外层跳过空气泡）', () => {
    const r = splitSentences('');
    if (!(r.length === 1 && r[0] === '')) throw new Error('实际 ' + JSON.stringify(r));
});
test('段间裸换行丢弃（不追加到上一段，避免幽灵空行）', () => {
    const r = splitSentences('\n\n第二句。第三句！');
    if (r[0] !== '第二句。') throw new Error('首段不应含前导换行，实际 ' + JSON.stringify(r));
});
test('换行作为段落分隔断句（buf 非空时 \n 触发 push，不再保留内换行）', () => {
    const r = splitSentences('第一行\n第二行。');
    // 新语义：AI 排版用 \n 当段落分隔，拆成两段而不是一个气泡内 pre-wrap 折行
    if (r.length !== 2 || r[0] !== '第一行' || r[1] !== '第二行。') {
        throw new Error('应拆成 ["第一行","第二行。"]，实际 ' + JSON.stringify(r));
    }
    // 同时验证：拆分后段内不含 \n
    if (r.some(s => s.includes('\n'))) throw new Error('拆段后段内不应残留 \\n，实际 ' + JSON.stringify(r));
});
test('小说体无句号场景：逗号+换行必须断句（修复"塌缩一个气泡"bug）', () => {
    const r = splitSentences('哥哥，你来了呀~\n我刚才在阳台看到一只小猫\n你今天过得怎么样呀');
    if (r.length < 2) throw new Error('应至少断成 2 段（解决用户报告的"宽度固定"根因），实际 ' + JSON.stringify(r));
});
test('无标点长文本不误拆', () => {
    const r = splitSentences('这是一段没有标点符号的很长的聊天内容用来验证不会被错误拆分');
    if (r.length !== 1) throw new Error('应为单段，实际 ' + JSON.stringify(r));
});
test('混合：单句问候 + 真实多句 各自正确', () => {
    if (splitSentences('哥哥，你来了呀~').length !== 1) throw new Error('问候应单段');
    if (splitSentences('吃了吗？没吃的话我陪你。').length !== 2) throw new Error('多句应 2 段');
});

// ===== 一·五、splitWaifuSegments / stripActions（动作分离）边界 =====
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
test('动作分离：半角括号 → text/action 交替', () => {
    const r = splitWaifuSegments('你好呀(轻笑)今天天气不错。');
    const want = [{ type: 'text', text: '你好呀' }, { type: 'action', text: '轻笑' }, { type: 'text', text: '今天天气不错。' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：全角括号同样识别', () => {
    const r = splitWaifuSegments('来了呀（跑过来）哥哥！');
    const want = [{ type: 'text', text: '来了呀' }, { type: 'action', text: '跑过来' }, { type: 'text', text: '哥哥！' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：同类嵌套只取最外层', () => {
    const r = splitWaifuSegments('a(b(c)b)d');
    const want = [{ type: 'text', text: 'a' }, { type: 'action', text: 'b(c)b' }, { type: 'text', text: 'd' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：异类括号不配对 → 整体归 text（不误切）', () => {
    const r = splitWaifuSegments('a(b）c');
    const want = [{ type: 'text', text: 'a(b）c' }];
    if (!deepEq(r, want)) throw new Error('半角开+全角闭未配对应整体归 text，实际 ' + JSON.stringify(r));
});
test('动作分离：未闭合括号整体归 text（流式中间态，不报错）', () => {
    const r = splitWaifuSegments('你好(轻笑');
    const want = [{ type: 'text', text: '你好(轻笑' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：空括号跳过（不生成段）', () => {
    const r = splitWaifuSegments('你好()今天()很好。');
    const want = [{ type: 'text', text: '你好今天很好。' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：纯空白内容括号跳过', () => {
    const r = splitWaifuSegments('你好(   )呀');
    const want = [{ type: 'text', text: '你好呀' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：纯 action 输入 → 仅 action 段（无空文本段混入）', () => {
    const r = splitWaifuSegments('(轻笑)');
    const want = [{ type: 'action', text: '轻笑' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：空串契约', () => {
    const r = splitWaifuSegments('');
    const want = [{ type: 'text', text: '' }];
    if (!deepEq(r, want)) throw new Error('实际 ' + JSON.stringify(r));
});
test('动作分离：action 内容 trim（括号内空白不入段）', () => {
    const r = splitWaifuSegments('嗯( 偷偷看你 )嗯。');
    if (r[1].text !== '偷偷看你') throw new Error('实际 ' + JSON.stringify(r));
});
test('stripActions：括号+内容整体剔除（语音不读动作）', () => {
    const r = stripActions('你好(轻笑)今天天气不错。真的。');
    if (r !== '你好今天天气不错。真的。') throw new Error('实际 ' + JSON.stringify(r));
});
test('stripActions：全角/嵌套/未闭合一致性', () => {
    if (stripActions('（跑过来）哥哥！') !== '哥哥！') throw new Error('全角剔除失败');
    if (stripActions('a(b(c)b)d') !== 'ad') throw new Error('嵌套剔除失败');
    if (stripActions('你好(轻笑') !== '你好(轻笑') throw new Error('未闭合应原样保留');
    if (stripActions('') !== '') throw new Error('空串契约失败');
});
test('stripActions：全 action 输入返回空串（语音模式无语音条）', () => {
    if (stripActions('(轻笑)(低头)') !== '') throw new Error('实际 ' + stripActions('(轻笑)(低头)'));
});

// ===== 二、插件场景（.txt 非模块加载器）=====
const VALID_THEME = `
return {
    meta: {
        name: '测试青绿主题',
        tokens: { '--color-accent': 'rgba(150,220,130,0.9)' }
    }
};`;
test('插件场景：合法 .txt 主题插件 → 加载并嗅探为主题', () => {
    const { hasTheme, hasBg } = loadPlugin(VALID_THEME);
    if (!hasTheme) throw new Error('应包含 meta.tokens，被识别为主题');
    if (hasBg) throw new Error('不应被误识别为背景');
});
test('插件场景：合法 .txt Canvas 背景插件 → 嗅探为背景', () => {
    const code = `
return {
    init: function(){},
    animate: function(){}
};`;
    const { hasCanvasBg } = loadPlugin(code);
    if (!hasCanvasBg) throw new Error('init+animate 应被识别为 Canvas 背景');
});
test('插件场景：合法 .txt DOM 背景插件 → 嗅探为背景', () => {
    const code = `
return {
    type: 'dom',
    onMount: function(){}
};`;
    const { hasDomBg } = loadPlugin(code);
    if (!hasDomBg) throw new Error('type:dom+onMount 应被识别为 DOM 背景');
});
test('插件场景：非法 .txt 插件含 import → 清晰报错而非裸异常', () => {
    const code = `import { x } from './y.js';\nreturn { meta: { name: 'bad' } };`;
    let msg = '';
    try { loadPlugin(code); } catch (e) { msg = e.message; }
    if (!msg.includes('不能包含 import/export')) throw new Error('应给出 import/export 引导，实际：' + msg);
});
test('插件场景：非法 .txt 插件含 export → 清晰报错', () => {
    const code = `export const p = { meta: { name: 'bad' } };`;
    let msg = '';
    try { loadPlugin(code); } catch (e) { msg = e.message; }
    if (!msg.includes('不能包含 import/export')) throw new Error('应给出 import/export 引导，实际：' + msg);
});
test('插件场景：插件未 return 对象 → 格式错误', () => {
    let msg = '';
    try { loadPlugin(`2 + 2;`); } catch (e) { msg = e.message; }
    if (!msg.includes('未返回有效对象')) throw new Error('应报格式错误，实际：' + msg);
});

// ── 执行 ──
for (const c of cases) {
    try {
        c.fn();
        passed++;
        console.log('  PASS  ' + c.name);
    } catch (e) {
        failed++;
        console.log('  FAIL  ' + c.name + '  ->  ' + e.message);
    }
}
console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${cases.length}）`);
process.exit(failed === 0 ? 0 : 1);
