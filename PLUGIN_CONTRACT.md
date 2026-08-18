# LI 插件系统 · 宿主契约（单一事实源 · 人读版）

> 本文件与 `hooks.json` 是插件契约的**唯一权威来源**。
> 导出模板里的注释、静态校验器、导入时的自检逻辑，都从 `hooks.json` **派生 / 读取**，不要在任何地方手写一份死副本——那样会慢慢和真实代码对不上。
> 改了 `src/style.css` 或 `tree.js` 里的钩子 / token，必须同步改这里和 `hooks.json`。

## 一、插件是什么（先弄清本质）
- 插件是 **`.txt` 文本文件**，不是 ES Module（也就是不能用 `import` / `export`）。
- 文件**末尾必须 `return` 一个对象**，加载器用 `new Function(code)()` 求值拿到这个对象。
- 加载器位置：`src/chat/api.js` 的 `importCodeString()`（解析 + 嗅探分类 + 报错引导，纯函数、无 DOM 依赖）。

## 二、插件有哪几种（特征嗅探自动分发）
加载器看对象长什么样，自动决定交给哪个引擎：

| 类型 | 识别特征 | 交给谁 |
|---|---|---|
| 主题 | `meta.cssText`（CSS 字符串）或 `meta.tokens`（CSS 变量对象） | ThemeEngine |
| 背景·Canvas | 同时有 `init` 函数和 `animate` 函数 | BgEngine |
| 背景·DOM | `type:'dom'` 且有 `onMount` 函数 | BgEngine |
| 混合 | 同时具备「背景特征」+「主题特征」 | 自动拆成「背景子插件」+「主题子插件」分别挂载 |

> 混合插件拆分规则：背景引擎取走 `init/animate/onMount/onUnmount`；主题引擎取走 `meta.cssText/tokens`。`onMount` 归背景侧调度，主题侧不要依赖 `onMount` 注入。

## 三、主题上色 · 必须用这两个钩子（最容易写错的地方）
**气泡长什么样完全由主题负责**。内置默认主题标了 `exportOnly`，**不挂载**，所以一启动没有默认气泡底色，全靠你激活的主题去画。

| 你要上色的目标 | 必须用的选择器（DOM 真实类名） |
|---|---|
| AI 气泡（普通模式 + 看板娘 waifu 气泡都算） | `.chat-bubble--ai` |
| 用户气泡（普通模式） | `.chat-bubble--user` |

**关键纠正（避免「兼容增强版」那类坑）**：
- 不要写 `.msg-bubble` / `.message-bubble` —— 这两个类在 DOM 里**根本不存在**，写了气泡就透明（这就是之前 G还原 没气泡的根因）。
- 不要单独列 `.waifu-bubble` 当「看板娘专用钩子」—— 它**已经被 `.chat-bubble--ai` 覆盖**了。对准 `.chat-bubble--ai` 一个，普通模式和 waifu 模式的气泡**同时**上色；单独给 `.waifu-bubble` 写样式，会让普通模式的 `.msg` 气泡漏色。
- 不要写通配选择器（如 `div[class*="ai"]`、`div[class*="bubble"]`）「碰运气」—— 它会过宽误伤未来其它元素，而且是「瞎猜 DOM 类名」的标志。

## 四、背景层钩子
| 用途 | 选择器 / ID |
|---|---|
| DOM 背景要挂载到的容器 | `#bg-dom-layer`（背景插件 `onMount(dom)` 收到的 `dom` 就是这个层） |
| Canvas 背景 | 自己 `init` 里建 `<canvas>` 自绘，`animate` 里刷新，不用 DOM 层 |

## 五、可用 Design Token（也就是预设好的 CSS 变量，改色优先用这些）
圆角请统一用 `var(--radius-md)`，不要硬编码 `px`（应用以后改圆角，你的插件会跟着变）。
- 颜色：`--color-bg` `--color-user` `--color-ai` `--color-accent` `--color-accent-soft` `--color-error` `--color-accent-bright` `--color-accent-solid` `--color-accent-glow` `--color-accent-dim` `--color-user-bright` `--color-waifu-active`（waifu 开关激活态，默认粉）
- 圆角：`--radius-sm`(4px) `--radius-md`(8px) `--radius-lg`(12px)
- 过渡：`--transition-fast` `--transition-normal` `--transition-smooth`
- 白色透明度序列：`--white-a03` ~ `--white-a90`（03/05/06/08/10/12/20/30/35/40/45/50/60/70/80/90）
- 黑色透明度：`--black-a20` `--black-a30` `--black-a50` `--black-a60`
- 输入框：`--input-ring-normal` `--input-ring-waiting` `--input-line` `--input-dot` `--input-text` `--input-cursor`
- 背景层：`--bg-modal` `--bg-select` `--bg-input`
- 状态色（深/浅双套，由 `<html>.theme-light` 自动翻转，组件用 var 引用）：`--status-send`(发送/消息绿) `--status-cache`(缓存命中黄) `--status-warn`(警告黄) `--status-error`(错误红) `--status-bar-ok`/`--status-bar-warn`/`--status-bar-danger`(用量条分档渐变)

> 完整以 `src/style.css` 的 `:root` 为准；新增 token 必须同步本文件与 `hooks.json`。

## 六、归因矩阵（项目 bug / 插件 bug / 契约问题 怎么分）
开发插件时三步反馈循环（启动 → 导入 → 看效果），卡住时按这张表定位：

| 现象 | 更像谁的锅 | 验证方法 |
|---|---|---|
| 导入直接报错（含 import/export、未 return、未知类型） | 插件 bug | 看 `importCodeString` 的中文报错引导 |
| 导入成功但某处没样式（如气泡透明） | 插件 bug（选择器写错/用了不存在的类） | 在 `hooks.json` 的 `deadSelectors`/`forbiddenSelectors` 里查，或开沙盒看命中日志 |
| 多个插件都正常，唯独新 AI 写的没效果 | 大概率是 AI 瞎猜了 DOM（契约没对齐） | 喂进沙盒，正则告警 `class*=` 通配符 |

## 七、维护铁律
- `src/styles/tokens.css` 改了钩子名 / token 名 → 必须同步改 `hooks.json` 和本文件。
- `tree.js` 改了气泡类名 → 同上。
- 任何「契约变更」只改**单一事实源**，派生物（导出模板注释、校验器）自动跟随，不手写第二份。
