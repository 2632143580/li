/**
 * 换肤契约静态 lint（skin-lint）
 *
 * 作用：扫描 src/styles/ 下全部样式文件（由 src/style.css 以 @import 聚合）的硬编码颜色，
 *      与 文档/换肤契约.md 第八节登记的 KNOWN_RGB 比对，未登记的 RGB 通道报警。
 *      拆分后 style.css 仅为聚合入口（不含真实规则），故直接遍历 src/styles/*.css 全量扫描，避免“假绿”。
 *
 * 用法：node tests/skin-lint.js
 * 退出码：0 = 全部已登记；1 = 有未登记（可接 CI / git pre-commit）
 *
 * 规则：
 *   - 跳过 :root 块与 .theme-light 块（均为 token 定义块，不是"使用"；状态色双套系统在此定义，组件用 var(--status-*) 引用，不在此散落）
 *   - 跳过含 var() 的行（已是 token 引用，不算硬编码；color-mix/var 渐变也跳过）
 *   - 跳过注释行
 *   - 提取 rgba()/rgb()/#hex/#abc 的 RGB 通道（忽略 alpha）
 *   - 未在 KNOWN_RGB 集合中的 RGB → 报警
 *
 * 维护：新增硬编码颜色 → 先登记到 文档/换肤契约.md 第八节 8.1，再把它对应的
 *      RGB 通道加到下方 KNOWN_RGB，否则本脚本失败。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 拆分后 style.css 仅为 @import 聚合入口（不含真实规则），直接遍历 src/styles/*.css 全量扫描
const STYLES_DIR = path.resolve(__dirname, '../src/styles');
// 聚合顺序（与 src/style.css 的 @import 顺序一致）；:root 块仅出现在 tokens.css，最先处理
const STYLE_FILES = [
    'tokens.css', 'base.css', 'background.css', 'chat.css', 'waifu.css', 'topbar.css',
    'monitor.css', 'msg-footer.css', 'responsive.css', 'modal.css', 'settings-panel.css',
    'form-controls.css', 'dropdown.css', 'fs-editor.css', 'context-menu.css',
    'plugin-manager.css', 'quick-theme.css',
];

/**
 * 已登记的 RGB 通道集合（来自 文档/换肤契约.md 第八节 8.1）
 * 状态色已纳入「双套系统」（tokens.css 的 :root 深 / .theme-light 浅，lint 跳过这两个定义块），
 * 组件统一用 var(--status-*) 引用，不再散落硬编码，故本集合不再需要登记状态色。
 * 目前仅剩不可避免的字面量兜底：黑阴影 rgba(0,0,0,*)（如 quick-theme.css 模态框投影）。
 * 角色色/白色/状态色若被写回硬编码散落，lint 会报警。
 * 新增不可避免的字面量时：先在 文档/换肤契约.md 8.1 登记，再将其 "r,g,b" 加入此集合。
 * @type {Set<string>}
 */
const KNOWN_RGB = new Set([
    '0,0,0',          // 黑阴影兜底（rgba(0,0,0,*) 投影等，style.css 无但保留）
    '89,102,242',     // 智谱品牌紫（msg-nav LLM 芯片底色/边框，服务商标识色，不随主题变；登记 8.1「服务商品牌色」）
    '154,163,255',    // 智谱品牌紫高亮（msg-nav LLM 芯片文字色，同上）
    '68,193,150',     // DeepSeek 品牌绿（msg-nav LLM 芯片底色/边框，服务商标识色，不随主题变；登记 8.1「服务商品牌色」）
    '127,217,184',    // DeepSeek 品牌绿高亮（msg-nav LLM 芯片文字色，同上）
]);

/**
 * 从一行 CSS 提取所有硬编码颜色的 RGB 通道
 * @param {string} line @returns {Array<{r:number,g:number,b:number,raw:string}>}
 */
function extractColors(line) {
    const out = [];
    const re1 = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
    let m;
    while ((m = re1.exec(line))) out.push({ r: +m[1], g: +m[2], b: +m[3], raw: m[0] });
    const re2 = /#([0-9a-fA-F]{6})\b/g;
    while ((m = re2.exec(line))) {
        const n = parseInt(m[1], 16);
        out.push({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, raw: m[0] });
    }
    const re3 = /#([0-9a-fA-F]{3})\b/g;
    while ((m = re3.exec(line))) {
        const r = parseInt(m[1][0] + m[1][0], 16);
        const g = parseInt(m[1][1] + m[1][1], 16);
        const b = parseInt(m[1][2] + m[1][2], 16);
        out.push({ r, g, b, raw: m[0] });
    }
    return out;
}

const css = STYLE_FILES
    .map((f) => fs.readFileSync(path.join(STYLES_DIR, f), 'utf8'))
    .join('\n');
const lines = css.split('\n');
let inRoot = false;
let currentSelector = '';
/** @type {Array<{ln:number,selector:string,value:string,rgb:string}>} */
const violations = [];

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    const trimmed = line.trim();

    // :root 与 .theme-light 块跟踪（均为 token 定义块，不是"使用"，跳过）
    if (/:root\s*\{/.test(line) || /\.theme-light\s*\{/.test(line)) { inRoot = true; continue; }
    if (inRoot) {
        if (/^\}/.test(trimmed)) inRoot = false;
        continue;
    }

    // 当前选择器跟踪（遇 { 更新，遇 } 清空）
    if (trimmed.includes('{')) {
        currentSelector = trimmed.replace(/\{.*$/, '').trim().slice(0, 60);
    }
    if (/^\}/.test(trimmed)) { currentSelector = ''; continue; }

    // 跳过注释行
    if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    // 跳过含 var() 的行（已是 token 引用；color-mix/var 渐变也算）
    if (line.includes('var(')) continue;

    const colors = extractColors(line);
    for (const c of colors) {
        const key = `${c.r},${c.g},${c.b}`;
        if (!KNOWN_RGB.has(key)) {
            violations.push({ ln, selector: currentSelector || '(未知选择器)', value: c.raw, rgb: key });
        }
    }
}

if (violations.length === 0) {
    console.log('skin-lint: 通过 — 所有硬编码 RGB 均已登记到 文档/换肤契约.md 第八节。');
    process.exit(0);
} else {
    console.log(`skin-lint: 发现 ${violations.length} 处未登记硬编码颜色（需登记到 文档/换肤契约.md 第八节，或改用 var() token）：`);
    for (const v of violations) {
        console.log(`  L${v.ln} [${v.selector}] ${v.value}  (rgb ${v.rgb})`);
    }
    console.log('\n处理方式：');
    console.log('  1. 若是新增状态色/语义色 → 在 文档/换肤契约.md 8.1 登记 RGB 通道 + 语义，并加入本脚本 KNOWN_RGB');
    console.log('  2. 若是角色色/白色散落 → 改用 var(--color-*)/var(--white-a*) token，消除硬编码');
    process.exit(1);
}
