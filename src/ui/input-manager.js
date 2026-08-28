/**
 * 输入管理器 — 薄壳(2026-08-28 重构)
 *
 * 历史职责(已全部迁出):
 *   - hiddenInput 焦点 / IME / 文本同步 → composer.js #cpText
 *   - 全屏编辑器 openFSEditor / bindFsEditorEvents → composer.js openComposerEditor
 *   - 对齐切换 alignIcons / currentAlign / liFsAlign → 已删除(模拟稿不居中对齐)
 *
 * 本文件仅做两件事,保持 5 处调用方零改动:
 *   1) re-export composer.js 的 inputManager 单例(同对象,直接透传)
 *   2) re-export updateInputLayout 占位(resize 链路签名兼容)
 *
 * 副作用:本文件无 registerUI,所有事件绑定迁到 composer.js,ui/event-bindings/index.js
 *        改为 `import '../composer.js'` 触发 composer 自注册。
 */
export { inputManager, updateInputLayout } from './composer.js';
