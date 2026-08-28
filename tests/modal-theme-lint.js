/**
 * 模态框配色覆盖 lint（modal-theme-lint）
 *
 * 作用：静态扫描「模态框相关」CSS 文件里引用的 CSS 变量，校验每个变量是否处于
 *      配色可管控范围内（= tokens.css 全局默认 ∪ quick-themes.js 注入集）。
 *      凡引用了「既不在全局默认、也不在任一配色注入」的变量 → 报错（门禁）。
 *
 * 与 skin-lint 的分工（两层互补，不重复）：
 *   - skin-lint 拦「硬编码颜色字面」（#hex / rgba 直接写），且已登记合法状态色。
 *   - 本脚本拦「配色无法控制的变量」：未来有人在模态框引入一个新的、配色切不动的
 *     颜色变量时，构建当场红，防止重演「配色对模态框作用有限 / 程度不一致」的覆盖缺口。
 *
 * 重要边界（避免误判，写清免得以后又混）：
 *   - 本脚本当下预期 0 门禁违规。现有「深浅组不对称」「半透明叠加」等已知缺口，其变量
 *     （--black-a*、--white-a* 等）都已在允许集内（tokens.css 全局默认），属设计意图，
 *     由 A/B 手动修复，不在本门禁范围。本脚本价值在「防未来新增」，非修现有。
 *   - 硬编码颜色字面不在此拦，交给 skin-lint（避免重复 + 误伤已登记状态色）。
 *   - 结构性变量（--radius-*、--transition-* 等）在 tokens.css 全局默认中，允许通过。
 *
 * 用法：node tests/modal-theme-lint.js
 * 退出码：0 = 无未管控变量；1 = 有未管控变量（可接 build 门禁）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STYLES_DIR = path.join(ROOT, 'src/styles');
const QUICK_THEMES = path.join(ROOT, 'src/plugins/quick-themes.js');

// 模态框相关样式文件（经诊断：承载弹窗/设置/下拉/上下文菜单/Composer 浮层 UI 等）
// 2026-08-28:fs-editor.css 已删除（合并入 .composer）,新增 composer.css
const MODAL_CSS_FILES = [
    'modal.css', 'settings-panel.css', 'form-controls.css',
    'dropdown.css', 'composer.css', 'context-menu.css', 'plugin-manager.css', 'quick-theme.css',
];

// 颜色类变量前缀（仅用于 INFO 提示「随配色变」的变量，非门禁用）
const COLOR_PREFIX = /^--(color-|bg-|white-a|black-a|border-|surface-|shadow-|accent|gradient|input-)/;
// 深浅组行为敏感前缀（全局默认驱动，已知不对称）
const SENSITIVE_PREFIX = /^--(black-a|white-a)/;

// ---- 允许集：tokens.css 全局默认 ∪ quick-themes 注入 ----
function extractDefinedTokens(cssText) {
    // --xxx: value 形式（tokens.css 的 :root 块）
    return new Set([...cssText.matchAll(/--[a-z][a-z0-9-]*(?=\s*:)/g)].map((m) => m[0]));
}
function extractQuotedTokens(jsText) {
    // '--xxx' 形式（quick-themes.js 的 tokens 键与模板展开均为单引号包裹）
    return new Set([...jsText.matchAll(/'(--[a-z][a-z0-9-]*)'/g)].map((m) => m[0]));
}

const tokensCss = fs.readFileSync(path.join(STYLES_DIR, 'tokens.css'), 'utf8');
const qtJs = fs.readFileSync(QUICK_THEMES, 'utf8');
const allowed = new Set([
    ...extractDefinedTokens(tokensCss),
    ...extractQuotedTokens(qtJs),
]);

// ---- 扫描模态框 CSS 的 var(--x) 引用 ----
/** @type {Array<{file:string, ln:number, v:string}>} */
const violations = [];
/** @type {string[]} */
const missingFiles = [];
/** @type {Map<string, Set<string>>} */
const colorInfo = new Map();
for (const f of MODAL_CSS_FILES) {
    const p = path.join(STYLES_DIR, f);
    // 缺失文件从「警告」升级为「硬错误」：被删/改名却不更新清单会静默放行，故构建直接红
    if (!fs.existsSync(p)) { missingFiles.push(f); continue; }
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const vars = [...lines[i].matchAll(/var\((--[a-z][a-z0-9-]*)\)/g)].map((m) => m[1]);
        for (const v of vars) {
            if (!allowed.has(v)) {
                violations.push({ file: f, ln: i + 1, v });
            }
            if (COLOR_PREFIX.test(v)) {
                if (!colorInfo.has(v)) colorInfo.set(v, new Set());
                colorInfo.get(v).add(f);
            }
        }
    }
}

// ---- 输出 ----
let exitCode = 0;

// 缺失文件：硬错误（门禁），先于变量违规输出
if (missingFiles.length > 0) {
    exitCode = 1;
    console.log(`modal-theme-lint: 发现 ${missingFiles.length} 个清单内的模态框 CSS 文件缺失（硬错误）：`);
    for (const f of missingFiles) {
        console.log(`  [FAIL] MODAL_CSS_FILES 含 ${f}，但 ${f} 不存在（被删/改名？请同步更新清单或恢复文件）`);
    }
}

if (violations.length > 0) {
    exitCode = 1;
    console.log(`modal-theme-lint: 发现 ${violations.length} 处「配色无法控制的变量」（模态框引用了既不在 tokens.css 全局默认、也不在 quick-themes 注入的变量）：`);
    for (const x of violations) {
        console.log(`  ${x.file}:${x.ln}  var(${x.v})`);
    }
    console.log('\n处理：改用已有 token，或在 quick-themes.js 的 tokens 里注入该变量（须同步 hooks.json 白名单）。');
} else if (missingFiles.length === 0) {
    console.log('modal-theme-lint: 通过 — 模态框引用的变量均在配色管控范围内（无未管控变量）。');
}

// INFO：颜色类变量分布（深浅组敏感项标 *），辅助维护者看清「哪些颜色随配色变」
console.log('\n[INFO] 模态框颜色类变量分布（* = 深浅组行为可能不对称，已知设计，由 A/B 修）：');
for (const v of [...colorInfo.keys()].sort()) {
    const mark = SENSITIVE_PREFIX.test(v) ? ' *' : '';
    console.log(`  ${v}${mark}  <- ${[...colorInfo.get(v)].sort().join(', ')}`);
}
console.log('  * 项（--black-a* / --white-a*）由全局默认驱动：深色组黑阴影在黑底不可见等已知缺口，不在本门禁拦截范围。');

process.exit(exitCode);
