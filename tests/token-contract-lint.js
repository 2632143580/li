/**
 * 令牌契约一致性 lint（token-contract-lint）
 *
 * 作用：白/黑透明度令牌（--white-a* / --black-a*）存在「三处来源、必须保持一致」的硬契约：
 *   1) src/styles/tokens.css 的 :root / .theme-light —— 真实定义（深色默认 + 浅色翻转）
 *   2) hooks.json 的 tokens.whiteAlpha / tokens.blackAlpha —— 契约白名单（机器可读事实源）
 *   3) src/plugins/quick-themes.js 的 LIGHT_WHITE_ALPHA —— 浅色主题内联覆盖集（JS 优先级高于 CSS）
 * 凡三处不一致（契约列了但 tokens.css 没定义 / quick-themes 引了但契约没登记 / 反之），
 * 构建当场红，防止重演「--white-a12 漏加 tokens.css」「--white-a80 漏登 hooks.json」这类契约漂移。
 *
 * 与 modal-theme-lint 的分工：
 *   - modal-theme-lint 查「某个 CSS 文件引用了不存在的变量」；
 *   - 本脚本查「变量在契约三处源之间的登记一致性」（从源头防漂移）。
 *
 * 用法：node tests/token-contract-lint.js
 * 退出码：0 = 一致；1 = 存在差异（可接 build 门禁）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOKENS_CSS = path.join(ROOT, 'src/styles/tokens.css');
const HOOKS_JSON = path.join(ROOT, 'hooks.json');
const QUICK_THEMES = path.join(ROOT, 'src/plugins/quick-themes.js');

// ---- 读取并抽取 ----
const tokensCss = fs.readFileSync(TOKENS_CSS, 'utf8');
const hooks = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
const qtJs = fs.readFileSync(QUICK_THEMES, 'utf8');

// tokens.css 中出现的白/黑透明度令牌名（:root 定义块 + .theme-light 翻转块，去重）
const whiteInCss = new Set([...tokensCss.matchAll(/--white-a(\d+)/g)].map((m) => `--white-a${m[1]}`));
const blackInCss = new Set([...tokensCss.matchAll(/--black-a(\d+)/g)].map((m) => `--black-a${m[1]}`));

// hooks.json 契约白名单
const whiteContract = new Set(hooks.tokens && hooks.tokens.whiteAlpha ? hooks.tokens.whiteAlpha : []);
const blackContract = new Set(hooks.tokens && hooks.tokens.blackAlpha ? hooks.tokens.blackAlpha : []);

// quick-themes.js 的 LIGHT_WHITE_ALPHA 键（浅色内联覆盖集）
const whiteInQt = new Set([...qtJs.matchAll(/'(--white-a\d+)'\s*:/g)].map((m) => m[1]));

// ---- 校验 ----
/** @type {string[]} */
const errors = [];

// 1) 契约登记的白透明度令牌，必须在 tokens.css 有真实定义（否则配色切不动）
for (const t of whiteContract) {
    if (!whiteInCss.has(t)) errors.push(`契约白名单含 ${t}，但 tokens.css 未定义（配色将切不动）`);
}
// 2) 契约登记的黑透明度令牌，必须在 tokens.css 有真实定义
for (const t of blackContract) {
    if (!blackInCss.has(t)) errors.push(`契约白名单含 ${t}，但 tokens.css 未定义`);
}
// 3) quick-themes 内联覆盖的令牌，必须在 tokens.css 有定义（否则浅色覆盖无深色默认兜底）
for (const t of whiteInQt) {
    if (!whiteInCss.has(t)) errors.push(`quick-themes LIGHT_WHITE_ALPHA 含 ${t}，但 tokens.css 未定义（缺深色默认）`);
}
// 4) quick-themes 内联覆盖的令牌，必须登记进契约白名单（否则与事实源脱节）
for (const t of whiteInQt) {
    if (!whiteContract.has(t)) errors.push(`quick-themes LIGHT_WHITE_ALPHA 含 ${t}，但未登记进 hooks.json tokens.whiteAlpha（契约漂移）`);
}

// ---- 警告（不阻断，供发现潜在漂移） ----
/** @type {string[]} */
const warns = [];
for (const t of whiteInCss) {
    if (!whiteContract.has(t)) warns.push(`tokens.css 定义了 ${t}，但不在 hooks.json 白名单（疑似未登记或多余令牌）`);
}
for (const t of blackInCss) {
    if (!blackContract.has(t)) warns.push(`tokens.css 定义了 ${t}，但不在 hooks.json 白名单`);
}

// ---- 输出 ----
let exitCode = 0;
if (errors.length) {
    exitCode = 1;
    console.log(`token-contract-lint: 发现 ${errors.length} 处契约不一致（门禁失败）：`);
    for (const e of errors) console.log(`  [FAIL] ${e}`);
} else {
    console.log('token-contract-lint: 通过 — tokens.css / hooks.json / quick-themes 三处白·黑透明度令牌登记一致。');
}
if (warns.length) {
    console.log(`\n[WARN] ${warns.length} 处潜在漂移（不阻断）：`);
    for (const w of warns) console.log(`  [WARN] ${w}`);
}
process.exit(exitCode);
