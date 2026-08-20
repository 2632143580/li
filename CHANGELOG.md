# 更新日志

基准提交：`08e5ee0`（Merge PR #3，词云 jieba 词典缓存）
本次提交分支：`feat/session-config-moderation`

---

## 新增

### 1. 禁止词引擎（moderator）
事件总线加 `MODERATOR_HIT` 事件，新增引擎 + 气泡 UI 两件套，不破坏式注入（直接拼进 `inputManager.text` + `DOM.hiddenInput.value` 再 `markDirty()`，tree.js 零改动）。
- `src/core/bus.js`：事件表 +2 行（`MODERATOR_HIT`）
- `src/engines/moderator-engine.js`：词库存取 / `[...new Set]` 保序去重 / 扫描命中计数累加 / `{words}` 占位符前缀生成，单例 `moderator`
- `src/ui/moderator-ui.js`：输入框右侧禁止图标（`bottom:15 right:50`，与全屏编辑器入口水平错开）+ 气泡配置面板（非模态，点外关闭）+ 命中提示条
- `src/main.js`：副作用 import 引入 UI 模块（+2 行）

### 2. 移动端优化
- `src/styles/chat.css`：`.msg` 加 `user-select:none`，长按气泡不弹系统文本选择器（复制走自定义菜单 clipboard，不受影响）
- `src/ui/event-bindings/monitor.js`：上下文上限编辑 `openCtxEdit` 删 `focus()` / `select()` 两行，打开编辑框不再自动弹软键盘

### 3. 会话级 LLM / 系统提示词（SP）
每条会话独立 LLM（apiUrl/model）+ SP，列表项直接呈现并支持快捷切换；配置只影响该会话请求，不污染全局存档。
- `src/core/state.js`：新增 `sessionLlmConfig: null`（`{apiUrl, model}` | null = 继承全局）
- `src/core/sessions.js`：`buildIndexEntry` 加可选 `llmConfig/sysPrompt` 参数（索引快照携带配置）
- `src/core/storage.js`：persistSession / loadSession / updateIndexFromRaw / loadFromLocal / createFirstSession 五处贯通 `llmConfig`
- `src/chat/session-manager.js`：switchTo 载入、createNew/removeSession 重置、listSessions 透传 `llmConfig`+`sysPrompt`
- `src/chat/api.js`：streamChat 请求层注入覆盖（`apiUrl/model/key` 解析）+ pending 快照与后台落盘补 `llmConfig` 字段
- `src/ui/event-bindings/msg-nav-panel.js`：列表双行布局（标题 + LLM 芯片 / SP 预览）+ 芯片快切 + 行内 SP 编辑器
- `src/styles/modal.css`：行布局 + 芯片样式（智谱紫 / DeepSeek 绿 / 默认灰）+ 行内 SP 编辑器样式
- `文档/换肤契约.md` + `tests/skin-lint.js`：登记 4 个服务商品牌色（89,102,242 / 154,163,255 / 68,193,150 / 127,217,184），双端一致

### 4. 会话列表重设计
- SP 编辑从 fixed 气泡改为**行内展开（accordion）**：grid `0fr→1fr` 平滑展开，文档流内永远可见，消灭 z-index / 视口钳制 / 外点关闭全套复杂度，移动端天然适配
- 模型切换从「双服务商互切」改为**三态循环** `全局 → 智谱 → DeepSeek → 全局`，并修复落盘（`persistSession` 内部 `updateIndexFromRaw` 同步索引，chip 即时更新、刷新不丢）
- 布局回归两行制：`标题省略 + LLM 芯片` / `时间·条数弱信息 + SP 预览`
- SP 微标签（9px 徽章）：有覆盖 = accent 微光，继承全局 = 灰，扫一眼即知哪些会话有独立提示词
- 交互：Esc 收编辑器、Ctrl/Cmd+Enter 保存、armed 态自动隐藏 SP 按钮让位「删除?」、单 key 也可切、全无 key 才提示

### 5. 构建产物命名
- `vite.config.js`：`closeBundle` 钩子自动复制 `dist/index.html` 为 `dist/li-<label>.html`（index.html 保留兼容部署）。label 取 `BUILD_LABEL` 环境变量，缺省回退 `<分支名>-<短提交>`
- 用法：`BUILD_LABEL=本轮改动 npm run build`

---

## 修复

- **SP 编辑区不可见**：原 fixed 气泡定位在 90vh 底部 sheet + 可滚动列表场景下上下双溢出。改为行内展开后彻底消除
- **模型切换失效**：原切换只调 `touchIndex(id)`（仅改 updatedAt，不同步索引内容），chip 显示与轮换逻辑读索引旧值形成死循环且不落盘。改为三态循环 + `saveSession` 落盘 + 索引同步

---

## 验证回执

| 项 | 结果 |
|---|---|
| 语法检查（全部改动 JS） | 通过 |
| `node tests/import-lint.js` | 通过（符号 + 相对路径双检） |
| `node tests/skin-lint.js` | 通过（4 品牌色双端登记一致） |
| `node tests/modal-theme-lint` | 通过（拦截未注册 token `--white-a25`，已改 `a30`） |
| `npm run build` | 通过，58 modules，~160ms |
| 禁止词引擎冒烟（node 实测） | 6/6 PASS：去重、命中计数、计数累加、`{words}` 替换、localStorage 往返、空文本不命中 |
| 会话级配置解析冒烟 | 5/5 PASS：全局继承、DeepSeek 覆盖（url/model/key 全换）、model 回退、key 兜底、enable_cache 判定 |
| 三态轮换冒烟 | 4/4 PASS：完整循环、custom 落回全局、单 key 循环、空配置不崩 |
| 死代码检查 | `sp-edit-pop / mn-sp-btn / mn-top-row / mn-bottom-row / mn-session-main / mn-sp-preview / openSpEditor / closeSp` 在 src 与产物均零残留 |

---

## 改动统计

13 文件修改 + 2 文件新增（moderator-engine.js / moderator-ui.js）+ CHANGELOG.md
约 +382 / -34（不含新增文件行数）
