/**
 * state 的集中读取入口（stage5）
 *
 * 拆分后：可变 state 定义在 core/state.js，本文件作为其统一的「读取门面」——
 * 业务层与渲染层一律从这里取 state，不直接 import core/state.js，
 * 这样 state 的读取面只有一处，写入边界也能在此单点说明。
 *
 * 关于「写入」的约定（不强制 setState 订阅）：
 *   - 允许直接修改 state 内部字段的场景：
 *       * storage.loadFromLocal / applySettings 等明确的初始化与配置写入；
 *       * main.js 的 rAF 主循环每帧直读 state（连续动画，订阅反而拖慢重绘）；
 *       * 流式输出时 api/tree 直接写 currentEndNode / waiting / stats。
 *   - 渲染层（theme-engine / bg-engine / tree-render）只读取、不写入 state。
 *   - 不引入全局 setState 包装：本项目 state 是「单一可变单例 + 局部明确写入点」，
 *     强行收口订阅会增加无谓的间接层，与现有流式写入模式冲突。
 *
 * 导出：state（透传自 core/state.js）
 * 依赖：./state.js
 */

import { state } from './state.js';

export { state };
