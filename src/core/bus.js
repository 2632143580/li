/**
 * 应用级事件总线（EventTarget 单例，零依赖）。
 *
 * 为什么存在：LI 的 chat/tree 与 chat/api 之间有循环依赖（两文件互相 import 对方大量函数，
 *   像两栋楼共用承重墙）。最危险的一刀是 tree.js「发消息」直接调用 api.js 的 executeStreamRequest
 *   —— 这是跨边界的硬编码函数引用。改成「tree 发布事件 / api 订阅事件」后，tree 不再 import
 *   executeStreamRequest，循环依赖被削掉一条边（stage2 解耦）。
 *
 * 用法：
 *   - bus.emit(event, detail)：发布事件；detail 是任何载荷对象。
 *   - bus.on(event, handler)：订阅；handler 收到 detail；返回取消订阅函数（调用即移除监听，幂等安全）。
 *   - EVENTS：事件名常量，集中定义避免拼错字符串。
 *
 * 依赖：无（core 层零外部依赖的硬性约束）。
 * 环境：浏览器与 Node 均原生支持 EventTarget / Event，故无需任何 polyfill。
 */
const target = new EventTarget();

/** 事件名常量（冻结，防止被意外改写） @type {Readonly<object<string,string>>} */
export const EVENTS = Object.freeze({
    /** 树 → API：请求发送一条流式消息。载荷 = { apiMessages:Array, aiNode:object } */
    STREAM_REQUEST: 'stream:request',
    /** 渲染层 → 树：错误气泡内联重试（tree-render 不 import tree.js，避免循环依赖）。载荷 = { node:object, parent:object } */
    RETRY_REQUEST: 'retry:request'
});

/**
 * 事件总线单例
 * @property {(event:string, detail:*) => void} emit 发布事件
 * @property {(event:string, handler:(detail:*)=>void) => (() => void)} on 订阅事件，返回取消订阅函数
 */
export const bus = {
    /**
     * 发布事件
     * @param {string} event 事件名（推荐用 EVENTS 常量，避免拼错）
     * @param {*} detail 任意载荷对象
     */
    emit(event, detail) {
        const ev = new Event(event); // 原生 Event，浏览器/Node 均支持；不依赖 CustomEvent
        ev.detail = detail;          // 附加载荷（Event 实例可扩展属性）
        target.dispatchEvent(ev);
    },

    /**
     * 订阅事件
     * @param {string} event 事件名
     * @param {(detail:*) => void} handler 收到载荷 detail 时调用
     * @returns {() => void} 取消订阅函数（调用即移除该监听；多次调用安全）
     */
    on(event, handler) {
        const wrapped = (e) => handler(e.detail);
        target.addEventListener(event, wrapped);
        return () => target.removeEventListener(event, wrapped);
    }
};
