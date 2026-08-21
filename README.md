# LI 项目模块索引

> 用途：按模块快速定位到源代码位置，帮助理解项目结构与排查问题。

## 目录结构

```
LI/
├─ index.html                  # 唯一 HTML 宿主，所有 DOM id 在此定义
├─ hooks.json                  # 插件契约机器可读单一事实源（api.js 运行时 import）
├─ PLUGIN_CONTRACT.md          # 插件契约人读版（与 hooks.json 同源需同步）
├─ vite.config.js              # 单文件打包配置
├─ vite-plugin-deps.js         # 依赖可视化插件（仅 dev）
├─ package.json                # 包定义 + 脚本（dev/build/lint:skin/imports/modal-theme）
├─ 启动LI.bat / 启动LI-构建.bat / 启动LI-deps.bat
├─ src/
│  ├─ main.js                  # 应用入口 / 全局编排
│  ├─ style.css                # 样式聚合入口（仅 @import 19 个 styles）
│  ├─ diagnose.js              # 性能诊断 overlay（?perf=1 动态 import）
│  ├─ core/                    # 基座
│  ├─ engines/                 # 引擎
│  ├─ chat/                    # 对话核心
│  ├─ ui/                      # 交互 / 渲染 / 绑定
│  ├─ plugins/                 # 插件
│  └─ styles/                  # 样式（20 个 CSS）
├─ dist/                       # 构建产物（单文件，输出非源码）
├─ public/ tests/ preview/ 文档/ 问题/
```

## 模块清单

### 根目录关键文件
| 路径 | 作用 |
|---|---|
| `index.html` | 唯一 HTML 宿主，所有 DOM id 在此定义 |
| `hooks.json` | 插件契约机器可读单一事实源（`api.js` 运行时 import） |
| `PLUGIN_CONTRACT.md` | 插件契约人读版（与 `hooks.json` 同源，改一处需同步） |
| `vite.config.js` | 单文件打包配置（`viteSingleFile` + `inlineDynamicImports` + `cssCodeSplit:false`） |
| `vite-plugin-deps.js` | 依赖可视化插件（仅 dev，构建零侵入） |
| `package.json` | 包定义（`type:module`）+ 脚本（dev/build/lint:skin/imports/modal-theme） |

### `src/core/` — 基座（最底层，改动影响最大）
| 文件 | 作用 | 关键锚点 |
|---|---|---|
| `dom.js` | DOM id 清单 + 视口（`DOM`/`W`/`H`/`uiCtx`/`setViewport`） | 几乎全模块引用 |
| `logger.js` | 统一日志；`Logger.safe`（静默吞错）/ `Logger.error` / `Logger.info` | |
| `constants.js` | 不可变常量 + `DEFAULT_SETTINGS` 默认配置 | 零依赖；密钥字段留空占位 |
| `state.js` | 仅可变 `state` 单例 | |
| `store.js` | `state` 读取门面（业务层经它取 state） | |
| `utils.js` | 纯工具（`clamp`/`rand`/`safeParseInt`/`formatTokens` 等） | |
| `storage.js` | 存档持久化（localStorage 读写 + 迁移） | `storage.js:58` 配额满→`showToast`；`storage.js:106` 坏档→重置 |
| `tree-core.js` | 对话树纯逻辑（节点操作/路径/migrate） | |
| `bus.js` | 事件总线（`bus` + `EVENTS`） | `bus.js:38` 用 `CustomEvent` 的 `detail` 字段 |
| `modal.js` | 模态框统一开关 | |
| `toast.js` | 轻提示 toast | |
| `text-split.js` | 断句纯函数（`splitSentences` 分句 + `splitWaifuSegments`/`stripActions` 动作分离） | |
| `registry.js` | UI 注册表（`registerUI`/`initUI`，事件绑定层调度核心） | |

### `src/engines/` — 引擎（注册/挂载/运行）
| 文件 | 作用 | 关键锚点 |
|---|---|---|
| `bg-engine.js` | 背景引擎：注册/挂载/卸载背景插件；`init`/`canvas`/`ctx`/`activePlugins`/`triggerMessage` | `mount` 失败 `return false` 触发上层回滚 |
| `theme-engine.js` | 主题引擎：token 注入 + 导出模板；`mount`/`init` | `mount` 失败 `return false` + 回滚 |
| `tts-engine.js` | 语音引擎：系统语音 + 云端 MiMo TTS + 缓存；`initTTS` | |

### `src/chat/` — 对话核心
| 文件 | 作用 | 关键锚点 |
|---|---|---|
| `tree.js` | 对话数据中枢：`sendMessage`/`regenerate`/`applySettings`/`buildApiMessages`/`ensureCurrentEndNode`/`updateMonitorUI` 等 | `tree.js:261` 模型下拉框搬到 `body`；`tree.js:275` RETRY 双兜底复位 `waiting` |
| `api.js` | 流式 API 请求 + **插件代码解析分发（`applyPluginCode` 唯一入口）** | `api.js:196` STREAM_REQUEST 双兜底复位；`api.js:286-347` `applyPluginCode` 回滚分支；直接 import `hooks.json` |

### `src/ui/` — 交互 / 渲染 / 绑定
| 文件 | 作用 | 关键锚点 |
|---|---|---|
| `input-renderer.js` | 输入框 canvas 渲染：`drawInputArea`/`updateInputColors`/`updateInputLayout`/`markDirty`/`shouldRedraw` | `textCache.update` 二分定长替代 O(n²) 截断 |
| `input-manager.js` | 输入交互：发送/暂停/文件上传 | |
| `render/tree-render.js` | 对话渲染层：`renderChat`/`buildMsgDom` 等 12 视图函数 | 长对话 O(n) 重渲染已修 |
| `voice-tiles.js` | 语音条渲染（tree-render 硬依赖） | `voice-tiles.js:141` Set 序列化兜底 |
| `context-menu.js` | 右键菜单（tree.js/tree-render 硬依赖） | |
| `plugin-sandbox.js` | 速测沙盒（开发调试，`main.js` 的 `initPluginSandbox` 调用） | |
| `event-bindings/index.js` | **事件绑定聚合**：遍历 UI 注册表执行，副作用导入全部子模块 | 删档 2/3 文件必须同步移除此处 import 行 |
| `event-bindings/settings.js` | 设置面板（API 配置/模型管理） | |
| `event-bindings/plugin-panel.js` | 插件管理面板（列表/导入/删除/裁剪） | 调 `BgEngine/ThemeEngine.mount` |
| `event-bindings/wordcloud-panel.js` | 词云面板；`analyzeWordFreqChunked`（异步分片 + setTimeout(0)） | 同步分词卡顿已修 |
| `event-bindings/quick-theme.js` | 快速配色交互（顶栏色块条 + 自定义配色）；`buildSchemeFromCode` clamp | |
| `event-bindings/monitor.js` | 监控面板（用量/状态灯） | |
| `event-bindings/topbar.js` | 左顶栏折叠 | |
| `event-bindings/tts.js` | 语音设置模态框交互 | |
| `event-bindings/data-exchange.js` | 导入/导出对话存档 | `data-exchange.js:34` 导出脱敏；`:64-72` 导入白名单排除密钥 |
| `event-bindings/global.js` | 全局事件（窗口缩放/快捷键/ESC 链） | ESC 链以 `MODAL_IDS` 单一清单遍历 |
| `event-bindings/click-confirm.js` | 危险操作二次确认（被 settings/data-exchange 引用） | |
| `event-bindings/temp-settings.js` | 临时设置活绑定（tree.js 经 index.js 读取） | |

### `src/plugins/` — 插件
| 文件 | 作用 | 关键锚点 |
|---|---|---|
| `default-theme.js` | 内置默认主题（仅作导出模板，`exportOnly` 不挂载） | |
| `quick-themes.js` | 11 组快速配色数据表 | 随 `quick-theme.js` 一起删 |

### `src/styles/` — 样式（20 个 CSS）
| 文件 | 作用 |
|---|---|
| `style.css` | 样式聚合入口，仅 `@import` 下面 19 个，本身无规则 |
| `tokens.css` | 全部设计 token（`:root` 变量），配色的唯一数据源 |
| `base.css` | 基础元素样式 |
| `background.css` | 背景层样式 |
| `chat.css` | 对话区样式（含 `.chat-bubble--ai/--user` 契约钩子） |
| `waifu.css` | AI 分句气泡样式（`.waifu-bubble` 契约钩子 + `.waifu-action` 动作轻提示） |
| `tts.css` | 语音条/语音模态框样式 |
| `topbar.css` | 顶栏样式 |
| `monitor.css` | 监控面板样式 |
| `msg-footer.css` | 消息 footer（分支导航）样式 |
| `responsive.css` | 响应式/移动端断点 |
| `modal.css` | 模态框统一样式（`modal.css:32` 冻结规则，见下方注） |
| `settings-panel.css` | 设置面板样式 |
| `sandbox.css` | 速测沙盒样式 |
| `form-controls.css` | 表单控件样式 |
| `dropdown.css` | 下拉样式 |
| `fs-editor.css` | 文件编辑器样式 |
| `context-menu.css` | 右键菜单样式 |
| `plugin-manager.css` | 插件面板样式 |
| `quick-theme.css` | 快速配色样式 |

> 注：`modal.css:32` 的全局冻结选择器 `body.modal-open *:not(.modal-overlay):not(.modal-overlay *){animation-play-state:paused!important}` 会冻死「打开时存在 + 落在 overlay 外 + 带入场动画」的元素（全屏编辑器 `#fs-editor`、模型下拉框 `#set-model-options` 曾是被炸出的受害者，已加豁免）。新增浮层前务必确认它在 overlay 内或已被 `:not()` 豁免。
