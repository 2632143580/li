# Li Wiki

> 项目协作主文档。面向人。**先于代码写**——任何结构性改动（新增模块 / 重命名 / 拆文件 / 新面板）必须先更新本文件对应小节，再动代码。
> 插件契约请看 `PLUGIN_CONTRACT.md`（人读）+ `hooks.json`（机器读），本文件不复制。

---

## 0. 一句话

**沉浸式 AI 对话界面**。Vite 多文件 ES Module（构建回落为单文件 HTML）。核心差异点：**背景动画插件 + 主题插件 + 词频 + 禁词**，与聊天流深度耦合。

---

## 1. 快速上手

### 1.1 启动

```bash
python3 -m http.server        # 源码即用（浏览器解析 src/style.css 的 @import 链）
npm install
npm run dev                   # Vite dev server
npm run build                 # lint 全部 + 单文件产物 dist/index.html
npm run preview               # 预览构建产物
```

### 1.2 目录速览

```
li/
├── index.html                # 入口 + 全部静态模态框 HTML（上帝文件）
├── src/
│   ├── main.js               # 应用入口：导入+生命周期（resize/init/bindEvents）
│   ├── style.css             # 顶层样式聚合（@import 各 styles/*.css）
│   ├── core/                 # 核心层（无 UI 依赖）
│   ├── chat/                 # 聊天树/会话/API
│   ├── engines/              # 引擎层：bg / theme / tts / moderator
│   ├── plugins/              # 内置插件源（love-icon / quick-themes）
│   ├── ui/                   # UI 层：render / event-bindings / 单文件 UI
│   └── styles/               # CSS 子模块
├── tests/                    # skin / import / modal-theme / token-contract + 单元测试
├── hooks.json                # 插件契约 · 机器可读
├── PLUGIN_CONTRACT.md        # 插件契约 · 人读
└── vite.config.js
```

### 1.3 命名规约

| 前缀 | 含义 | 例 |
|------|------|----|
| `mn-` | 消息导航 `msg-nav-panel` | `mn-search`、`mn-tabs` |
| `wc-` | 词云 `wordcloud-panel` | `wc-query-input` |
| `cs-` | 自定义配色 `custom-scheme` | `cs-textarea` |
| `tb-` | topbar 左栏 | `tb-body` |
| `ctx-` | 上下文编辑气泡 | `ctx-edit-input` |

> ⚠️ 历史遗留：部分面板仍用全名前缀（`plugin-` / `theme-` / `crop-` / `mn-`），新增元素遵守上表。

---

## 2. 架构

### 2.1 分层

```
┌────────────────────────────────────────────────┐
│  index.html (静态模态框 + 入口)                │
│  src/main.js (编排：导入 + 生命周期)           │
├────────────────────────────────────────────────┤
│  UI 层     ui/render  ui/event-bindings/*      │
│            ui/*.js (bg-image / voice-tiles)    │
├────────────────────────────────────────────────┤
│  业务层   chat/tree  chat/api  chat/session-*  │
├────────────────────────────────────────────────┤
│  引擎层   engines/bg  theme  tts  moderator    │
├────────────────────────────────────────────────┤
│  核心层   core/store  core/dom  core/bus       │
│  (无 UI)  core/registry  core/modal ...        │
└────────────────────────────────────────────────┘
```

依赖方向**严格自上而下**。`core/` 不允许 import 任何上层；其他层只允许 import `core/` 与同层。`import-lint` 强制检查。

### 2.2 关键设计决策

| 决策 | 原因 | 落点 |
|------|------|------|
| 树与 API 用事件总线解耦 | 两文件互相 import 大量函数，循环依赖 | `core/bus.js` + `EVENTS.STREAM_REQUEST` |
| `core/dom` 集中 DOM 引用 | 散落 `getElementById` 难维护 | `core/dom.js` 单一 `DOM` 对象 |
| `core/registry` 自注册 UI | `bindEvents` 散落 | `ui/event-bindings/*.js` 末尾 `registerUI(...)` |
| 引擎单例 + 只读 state Proxy | 防插件污染全局 | `engines/bg-engine.js`、`theme-engine.js` |
| `core/store` 透传 `core/state` | state 写入点显式收口 | `core/store.js` 单一读取门面 |
| Vite 单文件构建 | 部署即用免服务器 | `vite-plugin-singlefile` |
| 插件契约 `hooks.json` 单一事实源 | 模板/校验/自检同源，避免漂移 | `PLUGIN_CONTRACT.md` + `token-contract-lint` |

### 2.3 模态框

**两种形态**：
1. **静态**——HTML 在 `index.html` 里写，`<div class="modal-overlay sheet"><div class="modal-content">…</div></div>`
2. **动态**——JS 创建 `panel.className='modal-overlay sheet'`，内容包 `<div class="sheet-body">`

`.sheet` = 底部抽屉修饰类（贴底 + 90vh），统一在 `src/styles/modal.css` 定义。**所有现存面板均已 sheet 化**。

| 面板 | 类型 | index.html 行 | JS |
|------|------|----|----|
| 自定义配色 `#custom-scheme-modal` | 静态 sheet | 241 | `ui/event-bindings/quick-theme.js` |
| 插件管理 `#bg-modal` | 静态 sheet | 273 | `ui/event-bindings/plugin-panel.js` |
| 裁剪背景 `#crop-modal` | 静态 sheet | 314 | `ui/bg-image.js` |
| 通用 `#modal` | 静态 sheet | 355 | `core/modal.js` |
| 语音设置 `#voice-modal` | 静态 sheet | 478 | `ui/event-bindings/tts.js` |
| 消息导航 | 动态 sheet | — | `ui/event-bindings/msg-nav-panel.js` |
| 词云 | 动态 sheet | — | `ui/event-bindings/wordcloud-panel.js` |

### 2.4 气泡弹窗（小弹层，与 sheet 互斥独立）

**「气泡弹窗」**——项目专门术语。区别于 sheet 模态抽屉：体积小、非全屏、贴触发源定位。共 3 个，**同一时刻只允许一个可见**（`ui/bubbles.js` 统一互斥）。

| 气泡弹窗 | 触发源 | 打开/关闭 |
|----------|--------|-----------|
| 上下文占用编辑气泡 `#ctx-edit-pop` | 点 `#ctx-ring` 圆环 | `ui/event-bindings/monitor.js` `openCtxEdit` |
| 顶栏主体 `#tb-body`（即 `top-bar-left.collapsed` 类） | 点 `#monitor-bar` 监控区 | `ui/event-bindings/topbar.js` `setCollapsed(false)` |
| 提示词面板 `#prompt-panel` | 点 `#prompt-toggle` 胶囊 | `ui/event-bindings/prompt-bar.js` `openPanel` |

> 互斥函数 `closeBubbles(except)`：每个 opener 调用前传自己的 id 保留自己、关其他。与 `core/modal.js` 的 `closeAllModals` 互不替代——后者管 sheet 模态，本文件管气泡弹窗。

---

## 3. 模块手册

### 3.1 core/

| 文件 | 职责 | 关键导出 |
|------|------|----------|
| `state.js` | 可变 state 实体（单例） | `state` |
| `store.js` | state 读取门面（透传 state.js） | `state` |
| `dom.js` | DOM 引用集中点 + 视口 W/H | `DOM`、`setViewport` |
| `registry.js` | UI 模块自注册表 | `registerUI`、`initUI` |
| `modal.js` | 模态框开关 | `openModal`、`closeAllModals` |
| `bus.js` | 应用事件总线（EventTarget） | `bus`、`EVENTS` |
| `storage.js` | localStorage 持久化（白名单） | `loadFromLocal`、`saveSession` |
| `idb.js` | IndexedDB 封装 | — |
| `session-data.js` | 会话元数据 / 系统提示词 | `getEffectiveSysPrompt` |
| `tree-core.js` | 纯函数树操作 | `createNode` 等 |
| `wordcloud-analyzer.js` | 词频 + 分词 | `analyzeWordFreq` |
| `moderator.js` | 禁词库 CRUD | — |
| `config.js` | 常量（API 端点 / Token） | `TTS_CLOUD` |
| `constants.js` | 业务常量 | `DEFAULT_PROVIDER`、`WELCOME`、`STORAGE_KEY` |
| `models-cache.js` | LLM 模型清单拉取 + 缓存 | `syncAvailableModels` |
| `thinking-presets.js` | 按模型匹配 thinking 参数预设（`reasoning_effort` 等） | `matchThinkingPreset`、`buildThinkingBody` |
| `toast.js` | 顶部 Toast | `showToast` |
| `logger.js` | 带模块名 logger | `Logger` |
| `text-split.js` | 文本切片（语音用） | — |
| `voice-cache.js` | 语音缓存 | — |
| `utils.js` | 通用工具 | — |

**事件总线 EVENTS**（`core/bus.js`）：

| 事件 | 载荷 | 方向 |
|------|------|------|
| `STREAM_REQUEST` | `{ apiMessages, aiNode }` | tree → api |
| `RETRY_REQUEST` | `{ node, parent }` | render → tree |
| `ASSISTANT_DONE` | `string`（AI 完整文本） | api → bg-trigger |
| `MODERATOR_HIT` | `Array<{word, count}>` | moderator → UI |
| `SYS_PROMPT_CHANGE` | `string` | prompt-bar → 全链路 |

### 3.2 chat/

| 文件 | 职责 |
|------|------|
| `chat/tree.js` | 聊天树核心：增删改、发送、监控 UI 更新 |
| `chat/api.js` | 流式 LLM 请求 `streamChat` + **插件加载器** `importCodeString` |
| `chat/session-manager.js` | 会话 CRUD：`switchTo` / `createNew` / `removeSession` / `renameSession` / `listSessions` |

### 3.3 engines/

| 文件 | 插件接口 | 备注 |
|------|----------|------|
| `bg-engine.js` | `init` / `animate` / `onMount` / `onUnmount` / `onMessage` / `onKeydown`；`type:'dom'` 挂 `#bg-dom-layer` | Canvas rAF 循环 |
| `theme-engine.js` | `meta.cssText` / `meta.tokens` / `onMount` / `onUnmount` | 注入 style + Design Token |
| `tts-engine.js` | 云端 MiMo-V2.5-TTS | `initTTS` / `speakSentence` |
| `moderator-engine.js` | 禁词扫描 | 发 `MODERATOR_HIT` |

### 3.4 ui/event-bindings/（末尾 `registerUI` 自动接入）

| 文件 | 绑定对象 |
|------|----------|
| `index.js` | `bindEvents` 入口（遍历注册表） |
| `global.js` | 全局快捷键 / Escape 关模态 |
| `topbar.js` | 左栏折叠（`li.topbarLeftCollapsed`） |
| `monitor.js` | 监控圆环 / 上下文上限编辑 |
| `prompt-bar.js` | 系统提示词编辑（发 `SYS_PROMPT_CHANGE`） |
| `msg-nav-panel.js` | 消息 / 会话 / 词频 三 tab 面板 |
| `wordcloud-panel.js` | 词云 |
| `tts.js` | 语音设置 |
| `plugin-panel.js` | `#bg-modal` 插件管理 |
| `quick-theme.js` | 自定义配色 |
| `data-exchange.js` | 导入 / 导出存档 |
| `click-confirm.js` | 长按 / 双击确认 |
| `settings.js` | 设置面板 |
| `temp-settings.js` | 临时设置 |
| `context-menu.js` | 右键菜单 |
| `bg-trigger.js` | 背景触发器（监听 `ASSISTANT_DONE`） |

### 3.5 ui/render/ 与 ui/ 单文件

| 文件 | 职责 |
|------|------|
| `ui/render/tree-render.js` | 消息树渲染 + 监控 UI 刷新 |
| `ui/input-manager.js` | 输入框管理 + 布局刷新 |
| `ui/voice-tiles.js` | 语音条渲染 |
| `ui/bg-image.js` | 背景图片上传 / 管理 / 裁剪 |
| `ui/moderator-ui.js` | 禁词命中提示条 |
| `ui/bg-trigger.js` | 背景触发器（事件订阅） |
| `ui/context-menu.js` | 右键菜单 |

### 3.6 styles/

| 文件 | 负责 |
|------|------|
| `tokens.css` | Design Token（颜色 / 圆角 / 间距） |
| `base.css` | reset + 基础元素 |
| `chat.css` | 聊天气泡 / 消息树 |
| `topbar.css` | 左栏 + 折叠 |
| `prompt-bar.css` | 提示词输入 |
| `modal.css` | 模态框 + **统一 sheet** |
| `plugin-manager.css` | `#bg-modal` |
| `settings-panel.css` | 设置面板 |
| `quick-theme.css` | 自定义配色 |
| `dropdown.css` | 下拉菜单 |
| `context-menu.css` | 右键菜单 |
| `background.css` | 背景层（Canvas / DOM） |
| `monitor.css` | 监控圆环 |
| `msg-footer.css` | 消息底部操作栏 |
| `tts.css` | 语音条 |
| `waifu.css` | 角色形象 |
| `form-controls.css` | 按钮 / 输入框 / 滑块 |
| `fs-editor.css` | 全屏编辑器 `#fs-editor` |
| `responsive.css` | 响应式断点 |

---

## 4. 持久化键清单

| 键 | 类型 | 用途 | 模块 |
|----|------|------|------|
| `li.topbarLeftCollapsed` | `'1'` / `'0'` | 左栏折叠态 | `ui/event-bindings/topbar.js` |
| `liNavTab` | `'sessions'` / `'messages'` / `'words'` | 消息导航 tab 记忆 | `ui/event-bindings/msg-nav-panel.js` |
| `STORAGE_KEY` = `liChatData_v2` | object | 聊天树 + 设置（白名单过滤） | `core/storage.js` |
| `SESSION_KEY_PREFIX` | string | IndexedDB 会话存档 | `core/storage.js` |

---

## 5. 插件契约速查

完整版看 `PLUGIN_CONTRACT.md`。机器可读 `hooks.json` 是单一事实源。

- **插件是 `.txt`**，用 `new Function(code)()` 加载；禁止 `import` / `export`；末尾必须 `return`。
- **类型嗅探**（见 `chat/api.js` `importCodeString`）：
  - 主题：`meta.cssText` 或 `meta.tokens`
  - 背景·Canvas：`init` + `animate`
  - 背景·DOM：`type:'dom'` + `onMount`
  - 混合：自动拆分（bg 取 `init/animate/onMount/onUnmount`，theme 取 `meta.cssText/tokens`）
- **气泡上色必须用** `.chat-bubble--ai` / `.chat-bubble--user`（`.waifu-bubble` 已被 `--ai` 覆盖，不要单独瞄）。
- **宿主没有默认主题**——启动基础色来自 `styles/tokens.css` 的 `:root`。
- **DOM 层挂载点** `#bg-dom-layer`；圆角 token `--radius-md`。

---

## 6. 任务定位速查（grep 锚点）

| 找什么 | 锚点 |
|--------|------|
| 消息 / 会话 / 词频 tab | `mn-tabs`、`data-tab="(sessions\|messages\|words)"` |
| 词频搜索框 | `wc-query-input`、`wordcloudQuery` |
| 消息搜索框 | `mn-search` |
| 左栏折叠 | `topBarLeft`、`li.topbarLeftCollapsed`、`tb-body` |
| 插件面板 | `#bg-modal`、`plugin-list-container`、`theme-list-container` |
| 裁剪背景 | `#crop-modal`、`crop-preview` |
| 模态框 | `modal-overlay`、`sheet` |
| 事件总线 | `EVENTS.`、`bus.emit` |
| 自注册 UI | `registerUI(` |
| 引擎单例 | `BgEngine`、`ThemeEngine` |
| 状态读取 | `state.xxx`（渲染层只读，写入走 `core/state.js`） |
| 插件契约 | `hooks.json`、`PLUGIN_CONTRACT.md` |

---

## 7. 编码约定

- **Linting**：`npm run lint:skin`（无硬编码 RGB）、`lint:imports`（依赖方向）、`lint:modal-theme`（模态框主题）、`tests/token-contract-lint.js`（token 契约）
- **注释**：JSDoc 函数级 + 关键决策 "为什么"（不写 "做了什么"）
- **状态**：渲染层只读 `state`；写入限定在 `core/state.js` + storage/main rAF/stream 几个明确点
- **DOM 引用**：先在 `core/dom.js` 注册，再到模块用
- **新增面板**：HTML 加 `<!-- 区域: 面板名 -->` 注释锚点 + `class="modal-overlay sheet"` + 在 `2.3` 表格登记

---

## 8. 变更记录（追加式，不删旧记录）

- 2026-08-28 首次建 wiki。会话梳理产生本文件；清空历史「撞色强度 / bg-modal 非 sheet / crop-modal 非 sheet / tab 白名单」等技术债（已在前序 commit 修掉，本文件不列为待办）。
