/**
 * registry 注册表单元测试（Node 直跑，零依赖 acorn/vite）
 *
 * 验证：
 *  1) registerUI 注册后可被 getRegisteredUI 查到；
 *  2) initUI 遍历执行所有已注册 setup；
 *  3) 单个 setup 抛错被 Logger.safe 隔离，不阻止其余 setup 执行。
 *
 * 运行：node tests/registry.test.js
 * 注：registry 是模块级单例，用 unregisterUI 复位，保证用例间隔离。
 */

import { Logger } from '../src/core/logger.js';
import { registerUI, initUI, unregisterUI, getRegisteredUI } from '../src/core/registry.js';

// 静音：单个 setup 抛错会经 Logger.safe 打印 WARN，测试输出保持干净。
Logger.setLevel('silent');

let pass = 0;
let fail = 0;
function ok(name, cond) {
    if (cond) { pass++; }
    else { fail++; console.error('  FAIL:', name); }
}

// 复位：清除此前可能残留的注册（模块单例跨用例存活）
['a', 'b', 'c', 'd'].forEach(unregisterUI);

// —— 1) 注册可见 ——
let aRan = false, bRan = false;
registerUI('a', () => { aRan = true; });
registerUI('b', () => { bRan = true; });
ok('注册表含 a、b', getRegisteredUI().includes('a') && getRegisteredUI().includes('b'));

// —— 2) initUI 执行全部 setup ——
initUI();
ok('initUI 执行了 a', aRan);
ok('initUI 执行了 b', bRan);

// —— 3) 单个抛错被隔离，不阻止其余 ——
let dRan = false;
registerUI('c', () => { throw new Error('boom'); });
registerUI('d', () => { dRan = true; });
initUI();
ok('抛错的 setup(c) 被隔离，d 仍执行', dRan);

console.log(`registry.test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
