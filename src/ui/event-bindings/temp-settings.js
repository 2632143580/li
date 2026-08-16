/**
 * tempSettings 的唯一拥有者（Stage 3 解耦产出）。
 *
 * 原 index.js 顶部的 `export let tempSettings` 已外置到本模块。
 * 聚合层 index.js 通过 `export { tempSettings } from './temp-settings.js'` 做
 * **间接绑定转发**，保证 chat/tree.js 经 index.js 读取到的始终是实时值（活绑定语义不变）。
 *
 * 红线：整体重赋值只允许在本模块内发生（见 setTempSettings）。
 * 子模块 import 进来的绑定是只读的，直接赋值会抛 TypeError。
 * 各设置面板逻辑通过 setTempSettings() 替换对象；对 tempSettings 的逐属性赋值是合法的，无需 setter。
 */

/** 设置面板暂存对象 —— 确认前不污染主状态；供 tree.js 的 checkProviderMatch / populateModelSelect 读取 @type {object} */
export let tempSettings = {};

/**
 * 整体替换暂存对象（仅设置面板打开时调用一次）。
 * 必须在 owner 模块内重赋值；子模块拿到的 import 绑定不可直接改写。
 * @param {object} next - 深拷贝自 state.settings 的暂存对象
 */
export function setTempSettings(next) {
    tempSettings = next;
}
