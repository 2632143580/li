/**
 * 事件总线回归测试（Node ESM 直接运行：node tests/bus.test.js）
 * 验证：发布/订阅闭环、载荷透传、取消订阅生效、EVENTS 常量可用。
 * 与 tree-core.test.js 同款轻量框架（无外部依赖）。
 */
import { bus, EVENTS } from '../src/core/bus.js';
import assert from 'node:assert/strict';

let failed = 0;
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  PASS ' + name); }
    catch (e) { failed++; console.error('  FAIL ' + name + '\n    ' + e.message); }
}

test('emit/on 闭环：handler 收到载荷', () => {
    const received = [];
    const off = bus.on('demo:event', (detail) => received.push(detail));
    bus.emit('demo:event', { a: 1 });
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { a: 1 });
    off(); // 取消订阅，避免污染后续测试
    bus.emit('demo:event', { a: 2 });
    assert.equal(received.length, 1, '取消订阅后不应再收到事件');
});

test('EVENTS.STREAM_REQUEST 常量存在且为字符串', () => {
    assert.equal(typeof EVENTS.STREAM_REQUEST, 'string');
    assert.ok(EVENTS.STREAM_REQUEST.length > 0);
});

test('STREAM_REQUEST 事件可驱动订阅者（模拟 tree → api 发消息）', () => {
    let captured = null;
    const off = bus.on(EVENTS.STREAM_REQUEST, (detail) => { captured = detail; });
    const payload = { apiMessages: [{ role: 'user', content: 'hi' }], aiNode: { id: 1 } };
    bus.emit(EVENTS.STREAM_REQUEST, payload);
    assert.ok(captured, '订阅者应收到事件');
    assert.equal(captured.aiNode.id, 1);
    assert.equal(captured.apiMessages.length, 1);
    off();
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）`);
process.exit(failed === 0 ? 0 : 1);
