/**
 * 对话树纯数据逻辑单测（stage1 抽离的 core/tree-core.js）
 *
 * 运行：node tests/tree-core.test.js
 * 说明：Node ESM 测试（与 tests/waifu-text.test.js 同款极简框架）。
 *       仅覆盖「无 DOM」的纯数据函数；DOM 渲染相关不在本文件。
 */

import { state } from '../src/core/store.js';
import { ERROR_PREFIX } from '../src/core/constants.js';
import {
    createNode, migrateErrorFlags, getCurrentPath, getLastNodeInPath,
    buildApiMessages, findMaxId
} from '../src/core/tree-core.js';

// ── 测试框架 ──
let passed = 0, failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// 每个用例前重置相关 state 字段，避免用例间串味
function resetState() {
    state.msgIdCounter = 0;
    state.chatTree = null;
    state.settings.sysPrompt = 'SYS_PROMPT';
}

// ===== 一、createNode =====
test('createNode 返回结构正确且 id 自增', () => {
    resetState();
    const n = createNode('user', 'hi');
    if (n.id !== 1) throw new Error('首节点 id 应为 1，实际 ' + n.id);
    if (n.role !== 'user') throw new Error('role 应为 user');
    if (n.content !== 'hi') throw new Error('content 应为 hi');
    if (!Array.isArray(n.children) || n.children.length !== 0) throw new Error('children 应为空数组');
    if (n.selectedChildIndex !== 0) throw new Error('selectedChildIndex 应为 0');
    if (n.isError !== false) throw new Error('isError 应为 false');
    const n2 = createNode('assistant', '');
    if (n2.id !== 2) throw new Error('第二个节点 id 应自增到 2，实际 ' + n2.id);
});

// ===== 二、getCurrentPath =====
test('getCurrentPath 沿 selectedChildIndex 遍历根到末端', () => {
    resetState();
    const leaf = { id: 3, role: 'assistant', content: 'hello', children: [] };
    const user = { id: 2, role: 'user', content: 'hi', children: [leaf], selectedChildIndex: 0 };
    state.chatTree = { id: 1, role: 'system', content: 'sys', children: [user], selectedChildIndex: 0 };
    const path = getCurrentPath();
    if (path.length !== 3) throw new Error('路径长度应为 3，实际 ' + path.length);
    if (path[0].id !== 1 || path[1].id !== 2 || path[2].id !== 3) {
        throw new Error('路径节点 id 顺序应为 1,2,3，实际 ' + path.map(n => n.id).join(','));
    }
});

// ===== 三、getLastNodeInPath =====
test('getLastNodeInPath 按 selectedChildIndex 选分支返回叶子', () => {
    const leafA = { id: 3, children: [] };
    const branchA = { id: 2, children: [leafA], selectedChildIndex: 0 };
    const branchB = { id: 4, children: [] };
    const root = { id: 1, children: [branchA, branchB], selectedChildIndex: 1 };
    const last = getLastNodeInPath(root);
    if (last.id !== 4) throw new Error('应选第二分支叶子 id=4，实际 ' + last.id);
});

// ===== 四、buildApiMessages =====
test('buildApiMessages 过滤路径内错误节点 + 同步 sysPrompt', () => {
    resetState();
    // 路径：system -> user -> errAssistant(错误) -> okAssistant(endNode)
    // errAssistant 位于路径中（非 endNode），应被过滤掉
    const okAssistant = { id: 4, role: 'assistant', content: 'ok', children: [], selectedChildIndex: 0 };
    const errAssistant = { id: 3, role: 'assistant', content: 'ERR', isError: true, children: [okAssistant], selectedChildIndex: 0 };
    const user = { id: 2, role: 'user', content: 'hi', children: [errAssistant], selectedChildIndex: 0 };
    state.chatTree = { id: 1, role: 'system', content: 'sys', children: [user], selectedChildIndex: 0 };
    const msgs = buildApiMessages(okAssistant); // endNode = okAssistant，被排除在路径外
    if (msgs.length !== 2) throw new Error('错误节点应被过滤，只剩 system+user，实际 ' + msgs.length);
    if (msgs[0].role !== 'system' || msgs[0].content !== 'SYS_PROMPT') {
        throw new Error('首条应是 system 且同步 sysPrompt，实际 ' + JSON.stringify(msgs[0]));
    }
    if (msgs[1].role !== 'user' || msgs[1].content !== 'hi') throw new Error('次条应是 user hi，实际 ' + JSON.stringify(msgs[1]));
});

test('buildApiMessages 合并连续同角色消息', () => {
    resetState();
    // 路径：system -> user(hi) -> user(more) -> ai(endNode)
    // 两个连续 user 应合并为一条，内容用 \n 连接
    const ai = { id: 4, role: 'assistant', content: '', children: [], selectedChildIndex: 0 };
    const u2 = { id: 3, role: 'user', content: 'more', children: [ai], selectedChildIndex: 0 };
    const u1 = { id: 2, role: 'user', content: 'hi', children: [u2], selectedChildIndex: 0 };
    state.chatTree = { id: 1, role: 'system', content: 'sys', children: [u1], selectedChildIndex: 0 };
    const msgs = buildApiMessages(ai);
    if (msgs.length !== 2) throw new Error('连续同角色应合并，期望 2 条，实际 ' + msgs.length);
    if (msgs[1].content !== 'hi\nmore') throw new Error('合并内容应为 hi\\nmore，实际 ' + JSON.stringify(msgs[1].content));
});

// ===== 五、findMaxId =====
test('findMaxId 嵌套树返回最大 id；空节点返回 0', () => {
    const tree = {
        id: 1, children: [
            { id: 5, children: [{ id: 9, children: [] }] },
            { id: 3, children: [] }
        ]
    };
    if (findMaxId(tree) !== 9) throw new Error('最大 id 应为 9，实际 ' + findMaxId(tree));
    if (findMaxId(null) !== 0) throw new Error('空节点应返回 0');
});

// ===== 六、migrateErrorFlags =====
test('migrateErrorFlags 为旧 assistant 错误节点推导 isError 并递归补全所有节点', () => {
    const child = { role: 'user', content: 'hi', children: [] };
    const node = { role: 'assistant', content: ERROR_PREFIX + 'xx', children: [child] };
    migrateErrorFlags(node);
    if (node.isError !== true) throw new Error('assistant 错误内容应推导 isError=true');
    // migrateErrorFlags 会给所有缺字段节点补一个确定布尔值：user 子节点应为 false（非 undefined）
    if (child.isError !== false) throw new Error('user 子节点应推导为 isError=false，实际 ' + child.isError);
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
