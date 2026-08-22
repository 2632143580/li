/**
 * import 完整性静态 lint（import-lint）
 *
 * 作用：扫描 src/ 下全部 .js（ES Module），用 acorn 做 AST 解析，做两类检查：
 *  ── 检查 A（符号）── 检测「被引用的标识符，既不在本文件的 import 绑定里、也不在任何层级的声明里、
 *      且不是浏览器/标准内置全局」的情况——即「用了却没 import / 没声明」的疑似漏网符号。
 *      这类问题 Vite(esbuild) 打包时不会报错，只会在运行时抛 ReferenceError，
 *      正是此前 settings.js 漏 import `saveToLocal` 导致「合于一处」按钮点击无效的同类坑。
 *  ── 检查 B（路径）── 检测「相对 import / export-from / import() 的路径无法解析到文件」。
 *      旧版只查符号、不查路径：目录深度写错的相对 import（如 `src/ui/` 下误写 `./core/registry.js`，
 *      解析成并不存在的 `src/ui/core/registry.js`）能过 lint，直到 `vite build` 才报 UNRESOLVED_IMPORT、
 *      构建直接失败。本项目约定原生 ESM + dev 纯 http 伺服（无 Vite transform、无扩展名推断），
 *      故「可解析」= 字面量路径必须精确命中已存在文件（不做 .js / index.js 兜底）。
 *      两项检查均在 `vite build` 之前跑（package.json 的 build 链：skin → imports → modal-theme → vite build），
 *      满足「构建阶段尽早暴露」——把原来要等整包构建才发现的路径错误，前移到 lint 阶段。
 *
 * 用法：node tests/import-lint.js
 * 退出码：0 = 全部符号已声明（或已 import）；1 = 发现疑似漏 import（可接 CI / git pre-commit）
 *
 * 设计要点：
 *  - 两遍遍历（关键）：第一遍 collectDecl 全量收集「所有声明名」（import 绑定 + 任意层级的
 *    function/var/let/const/class/参数/解构/catch 声明），不判引用；第二遍 collectRef 再基于
 *    完整的 declared 集合判定引用。
 *    → 用两遍而非单遍，是为了解决「先调用、后定义」（如 tree.js:123 调 toggleMonitorEdit，
 *      定义在 L128）导致的误报：单遍遍历到调用点时 declared 尚未填入后续定义，会误判为未声明。
 *  - 宽松声明池：把所有层级的声明名收进一个集合（不区分作用域）。一个符号只要「全文件任何地方
 *    被声明过」即视为已定义。→ 对「漏 import」100% 有效（漏 import 的符号全文件都没声明），
 *    且误报极低（仅当合法代码引用了一个「全文件都没声明」的符号，那本就是 bug）。
 *  - 引用判定：仅在 Identifier 节点且不属于「声明位置 / 属性非计算键 / import.meta」时计入。
 *  - 白名单：项目 index.html 仅有一个 `<script type="module" src="/src/main.js">`，无任何 CDN /
 *    第三方全局注入；故 GLOBALS 只需覆盖浏览器 + 标准内置全局，无需补 CDN 全局。
 *
 * 维护：
 *  - 若报出合法全局（白名单遗漏）→ 把该全局名加入下方 GLOBALS（并注明来源）。
 *  - 若报出真正的漏 import → 在对应文件补 import 或声明，而不是加白名单。
 *
 * 依赖：acorn（devDependencies，仅本脚本使用，不进入运行产物）。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'acorn';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');

/**
 * 浏览器 + 标准内置全局白名单。
 * 项目无 CDN 全局注入，故仅此集即可。新增合法全局时在此补充并注明来源。
 * @type {Set<string>}
 */
const GLOBALS = new Set([
    // 标准 ECMAScript 字面量 / 基础
    'undefined', 'NaN', 'Infinity', 'globalThis', 'global', 'self', 'window', 'top', 'parent', 'frames',
    // 标准内置对象
    'Object', 'Array', 'Function', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'Date',
    'JSON', 'RegExp', 'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError',
    'URIError', 'AggregateError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect',
    'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly',
    'Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array',
    'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'BigInt64Array', 'Uint8BigInt',
    // 标准函数
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'encodeURI',
    'decodeURIComponent', 'encodeURIComponent', 'escape', 'unescape',
    'structuredClone', 'queueMicrotask',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'setImmediate', 'clearImmediate',
    'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
    // BOM / Web API
    'console', 'performance', 'navigator', 'location', 'history', 'document', 'screen',
    'localStorage', 'sessionStorage', 'indexedDB', 'IDBKeyRange', 'caches',
    'fetch', 'XMLHttpRequest', 'EventSource', 'WebSocket',
    'btoa', 'atob', 'getComputedStyle', 'matchMedia', 'getSelection',
    'alert', 'confirm', 'prompt', 'print',
    'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response',
    'TextEncoder', 'TextDecoder', 'Image', 'Audio', 'Option', 'Worker', 'SharedWorker',
    'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'TouchEvent', 'WheelEvent', 'UIEvent',
    'InputEvent', 'FocusEvent', 'ClipboardEvent', 'DragEvent', 'AnimationEvent',
    'TransitionEvent', 'MessageEvent', 'ErrorEvent', 'ProgressEvent', 'StorageEvent',
    'HashChangeEvent', 'PopStateEvent', 'PageTransitionEvent', 'SubmitEvent', 'ToggleEvent',
    'SecurityPolicyViolationEvent', 'ResizeObserver', 'IntersectionObserver', 'MutationObserver',
    'HTMLElement', 'HTMLInputElement', 'HTMLDivElement', 'HTMLButtonElement', 'HTMLSpanElement',
    'HTMLAnchorElement', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'HTMLAudioElement',
    'HTMLSelectElement', 'HTMLOptionElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'HTMLPreElement',
    'CanvasRenderingContext2D',
    'Node', 'NodeList', 'Element', 'SVGElement', 'Text', 'Comment', 'DocumentFragment',
    'CSSStyleSheet', 'CSS', 'MediaQueryList', 'DOMParser', 'XMLSerializer',
    'customElements', 'shadowRoot', 'speechSynthesis', 'SpeechSynthesisUtterance',
    'Notification', 'Credential', 'Crypto', 'crypto', 'SubtleCrypto',
]);

/**
 * 把一个「绑定模式（binding pattern）」里的所有声明名收进 declared 集合。
 * 处理 Identifier / ObjectPattern / ArrayPattern / RestElement / AssignmentPattern / MemberExpression(非法忽略)。
 * @param {import('acorn').Node|null|undefined} node
 * @param {Set<string>} declared
 */
function collectPattern(node, declared) {
    if (!node) return;
    switch (node.type) {
        case 'Identifier':
            declared.add(node.name);
            break;
        case 'ObjectPattern':
            for (const p of node.properties) {
                if (p.type === 'RestElement') collectPattern(p.argument, declared);
                else collectPattern(p.value, declared); // 解构值才是声明（键非声明）
            }
            break;
        case 'ArrayPattern':
            for (const el of node.elements) if (el) collectPattern(el, declared);
            break;
        case 'RestElement':
            collectPattern(node.argument, declared);
            break;
        case 'AssignmentPattern':
            collectPattern(node.left, declared); // 默认参数左值是声明
            break;
        case 'MemberExpression':
            break; // 非法绑定模式，忽略
        default:
            break;
    }
}

/**
 * 第一遍：全量收集声明名（不判引用）。
 * 遍历所有节点，把 import 绑定 + 任意层级的 function/var/let/const/class/参数/解构/catch 声明名
 * 收进 declared；同时递归进入函数体/块/表达式，确保嵌套声明也被收集。
 * @param {import('acorn').Node} node
 * @param {Set<string>} declared
 */
function collectDecl(node, declared) {
    switch (node.type) {
        case 'ImportDeclaration':
            for (const s of node.specifiers) if (s.local) declared.add(s.local.name);
            return; // specifier 无嵌套声明
        case 'ImportExpression':
            collectDecl(node.source, declared);
            return;
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
            return; // 已在上层 ImportDeclaration 处理
        case 'VariableDeclaration':
            node.declarations.forEach((d) => collectDecl(d, declared));
            return;
        case 'VariableDeclarator':
            collectPattern(node.id, declared); // id 是声明
            if (node.init) collectDecl(node.init, declared);
            return;
        case 'FunctionDeclaration':
            if (node.id) declared.add(node.id.name);
            node.params.forEach((p) => collectPattern(p, declared));
            collectDecl(node.body, declared);
            return;
        case 'FunctionExpression':
            if (node.id) declared.add(node.id.name);
            node.params.forEach((p) => collectPattern(p, declared));
            collectDecl(node.body, declared);
            return;
        case 'ArrowFunctionExpression':
            node.params.forEach((p) => collectPattern(p, declared));
            collectDecl(node.body, declared);
            return;
        case 'ClassDeclaration':
            if (node.id) declared.add(node.id.name);
            if (node.superClass) collectDecl(node.superClass, declared);
            collectDecl(node.body, declared);
            return;
        case 'ClassExpression':
            if (node.id) declared.add(node.id.name);
            if (node.superClass) collectDecl(node.superClass, declared);
            collectDecl(node.body, declared);
            return;
        case 'ClassBody':
            node.body.forEach((m) => collectDecl(m, declared));
            return;
        case 'MethodDefinition':
            if (node.computed) collectDecl(node.key, declared);
            if (node.value) collectDecl(node.value, declared);
            return;
        case 'PropertyDefinition':
            if (node.computed) collectDecl(node.key, declared);
            if (node.value) collectDecl(node.value, declared);
            return;
        case 'Property':
            if (node.computed) collectDecl(node.key, declared);
            collectDecl(node.value, declared);
            return;
        case 'ObjectPattern':
            node.properties.forEach((p) => {
                if (p.type === 'RestElement') collectPattern(p.argument, declared);
                else collectPattern(p.value, declared);
            });
            return;
        case 'ArrayPattern':
            node.elements.forEach((e) => e && collectPattern(e, declared));
            return;
        case 'RestElement':
            collectPattern(node.argument, declared);
            return;
        case 'AssignmentPattern':
            collectPattern(node.left, declared);
            collectDecl(node.right, declared);
            return;
        case 'ExportNamedDeclaration':
            if (node.declaration) collectDecl(node.declaration, declared); // re-export（带 source）无本地声明
            return;
        case 'ExportDefaultDeclaration':
            collectDecl(node.declaration, declared);
            return;
        case 'ExportAllDeclaration':
            return;
        case 'CatchClause':
            if (node.param) collectPattern(node.param, declared);
            collectDecl(node.body, declared);
            return;
        case 'MetaProperty':
            return;
        default:
            // 通用递归（表达式/控制流等，可能有嵌套声明如箭头/函数表达式）
            for (const key of Object.keys(node)) {
                if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
                const child = node[key];
                if (child && typeof child === 'object') {
                    if (Array.isArray(child)) child.forEach((c) => c && c.type && collectDecl(c, declared));
                    else if (child.type) collectDecl(child, declared);
                }
            }
    }
}

/**
 * 第二遍：基于完整 declared 判定引用（不收集声明）。
 * 遍历所有节点，仅在 Identifier 节点且不属于「声明位置 / 属性非计算键 / import.meta」时，
 * 若不在 declared 且不在 GLOBALS → 记为疑似漏 import（记录最小行号去重）。
 * @param {import('acorn').Node} node
 * @param {Set<string>} declared 第一遍收集完成的声明名集合
 * @param {Map<string, number>} refs 引用名 → 最小行号（去重用）
 */
function collectRef(node, declared, refs) {
    switch (node.type) {
        case 'Program':
            node.body.forEach((n) => collectRef(n, declared, refs));
            return;
        case 'ImportDeclaration':
            return; // 无引用
        case 'ImportExpression':
            collectRef(node.source, declared, refs);
            return;
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
            return;
        case 'VariableDeclaration':
            node.declarations.forEach((d) => collectRef(d, declared, refs));
            return;
        case 'VariableDeclarator':
            if (node.init) collectRef(node.init, declared, refs); // id 是声明，不 walk
            return;
        case 'FunctionDeclaration':
            node.params.forEach((p) => collectRef(p, declared, refs)); // id 声明不 walk
            collectRef(node.body, declared, refs);
            return;
        case 'FunctionExpression':
            node.params.forEach((p) => collectRef(p, declared, refs));
            collectRef(node.body, declared, refs);
            return;
        case 'ArrowFunctionExpression':
            node.params.forEach((p) => collectRef(p, declared, refs));
            collectRef(node.body, declared, refs);
            return;
        case 'ClassDeclaration':
            if (node.superClass) collectRef(node.superClass, declared, refs);
            collectRef(node.body, declared, refs);
            return;
        case 'ClassExpression':
            if (node.superClass) collectRef(node.superClass, declared, refs);
            collectRef(node.body, declared, refs);
            return;
        case 'ClassBody':
            node.body.forEach((m) => collectRef(m, declared, refs));
            return;
        case 'MethodDefinition':
            if (node.computed) collectRef(node.key, declared, refs);
            if (node.value) collectRef(node.value, declared, refs);
            return;
        case 'PropertyDefinition':
            if (node.computed) collectRef(node.key, declared, refs);
            if (node.value) collectRef(node.value, declared, refs);
            return;
        case 'Property':
            if (node.computed) collectRef(node.key, declared, refs);
            collectRef(node.value, declared, refs);
            return;
        case 'ObjectPattern':
            return; // 解构键/值均为声明侧，无引用
        case 'ArrayPattern':
            return;
        case 'MemberExpression':
            collectRef(node.object, declared, refs);
            if (node.computed) collectRef(node.property, declared, refs); // 非计算属性键非引用
            return;
        case 'CallExpression':
        case 'NewExpression':
            collectRef(node.callee, declared, refs);
            node.arguments.forEach((a) => collectRef(a, declared, refs));
            return;
        case 'AssignmentExpression':
            collectRef(node.left, declared, refs); // 左值可能是漏声明引用（按引用查）
            collectRef(node.right, declared, refs);
            return;
        case 'AssignmentPattern':
            collectRef(node.right, declared, refs); // left 声明不 walk
            return;
        case 'UpdateExpression':
            collectRef(node.argument, declared, refs);
            return;
        case 'IfStatement':
            collectRef(node.test, declared, refs);
            collectRef(node.consequent, declared, refs);
            if (node.alternate) collectRef(node.alternate, declared, refs);
            return;
        case 'BlockStatement':
            node.body.forEach((n) => collectRef(n, declared, refs));
            return;
        case 'ExpressionStatement':
            collectRef(node.expression, declared, refs);
            return;
        case 'ReturnStatement':
            if (node.argument) collectRef(node.argument, declared, refs);
            return;
        case 'ThrowStatement':
            if (node.argument) collectRef(node.argument, declared, refs);
            return;
        case 'TryStatement':
            collectRef(node.block, declared, refs);
            if (node.handler) collectRef(node.handler.body, declared, refs);
            if (node.finalizer) collectRef(node.finalizer, declared, refs);
            return;
        case 'ForStatement':
            if (node.init) collectRef(node.init, declared, refs);
            if (node.test) collectRef(node.test, declared, refs);
            if (node.update) collectRef(node.update, declared, refs);
            collectRef(node.body, declared, refs);
            return;
        case 'ForInStatement':
        case 'ForOfStatement':
            collectRef(node.left, declared, refs);
            collectRef(node.right, declared, refs);
            collectRef(node.body, declared, refs);
            return;
        case 'WhileStatement':
            collectRef(node.test, declared, refs);
            collectRef(node.body, declared, refs);
            return;
        case 'DoWhileStatement':
            collectRef(node.body, declared, refs);
            collectRef(node.test, declared, refs);
            return;
        case 'LabeledStatement':
            collectRef(node.body, declared, refs);
            return;
        case 'BreakStatement':
        case 'ContinueStatement':
            return;
        case 'SwitchStatement':
            collectRef(node.discriminant, declared, refs);
            node.cases.forEach((c) => {
                if (c.test) collectRef(c.test, declared, refs);
                c.consequent.forEach((n) => collectRef(n, declared, refs));
            });
            return;
        case 'ConditionalExpression':
            collectRef(node.test, declared, refs);
            collectRef(node.consequent, declared, refs);
            collectRef(node.alternate, declared, refs);
            return;
        case 'SequenceExpression':
            node.expressions.forEach((e) => collectRef(e, declared, refs));
            return;
        case 'UnaryExpression':
            collectRef(node.argument, declared, refs);
            return;
        case 'BinaryExpression':
        case 'LogicalExpression':
            collectRef(node.left, declared, refs);
            collectRef(node.right, declared, refs);
            return;
        case 'AwaitExpression':
            collectRef(node.argument, declared, refs);
            return;
        case 'YieldExpression':
            if (node.argument) collectRef(node.argument, declared, refs);
            return;
        case 'ChainExpression':
            collectRef(node.expression, declared, refs);
            return;
        case 'ParenthesizedExpression':
            collectRef(node.expression, declared, refs);
            return;
        case 'TemplateLiteral':
            node.expressions.forEach((e) => collectRef(e, declared, refs));
            return;
        case 'TaggedTemplateExpression':
            collectRef(node.tag, declared, refs);
            collectRef(node.quasi, declared, refs);
            return;
        case 'SpreadElement':
            collectRef(node.argument, declared, refs);
            return;
        case 'RestElement':
            return; // 声明侧
        case 'ArrayExpression':
            node.elements.forEach((e) => e && collectRef(e, declared, refs));
            return;
        case 'ExportNamedDeclaration':
            if (node.declaration) collectRef(node.declaration, declared, refs);
            else if (!node.source) node.specifiers.forEach((s) => collectRef(s.local, declared, refs)); // 普通 export { a }：a 是引用；re-export 跳过
            return;
        case 'ExportDefaultDeclaration':
            collectRef(node.declaration, declared, refs);
            return;
        case 'ExportAllDeclaration':
            return;
        case 'MetaProperty':
            return; // import.meta / new.target 非引用
        case 'Identifier': {
            const name = node.name;
            if (!declared.has(name) && !GLOBALS.has(name)) {
                const line = node.loc ? node.loc.start.line : 0;
                if (!refs.has(name) || (refs.get(name) || Infinity) > line) refs.set(name, line);
            }
            return;
        }
        case 'Literal':
        case 'ThisExpression':
        case 'Super':
        case 'PrivateIdentifier':
        case 'TemplateElement':
            return;
        default:
            // 兜底：通用递归所有子节点（覆盖未显式列出的节点类型，避免漏查引用）
            for (const key of Object.keys(node)) {
                if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
                const child = node[key];
                if (child && typeof child === 'object') {
                    if (Array.isArray(child)) child.forEach((c) => c && c.type && collectRef(c, declared, refs));
                    else if (child.type) collectRef(child, declared, refs);
                }
            }
    }
}

/**
 * 解析单个文件并返回疑似漏 import 列表。
 * @param {string} code 文件源码
 * @returns {Array<{line:number, name:string}>}
 */
function lintFile(code) {
    /** @type {Set<string>} */
    const declared = new Set();
    /** @type {Map<string, number>} */
    const refs = new Map();
    const ast = parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        allowAwaitOutsideFunction: true, // 支持顶层 await
        allowReturnOutsideFunction: true,
        allowHashBang: true,
    });
    collectDecl(ast, declared); // 第一遍：全量收集声明（不判引用）
    collectRef(ast, declared, refs); // 第二遍：基于完整 declared 判定引用
    /** @type {Array<{line:number, name:string}>} */
    const out = [];
    for (const [name, line] of refs) out.push({ line, name });
    out.sort((a, b) => a.line - b.line);
    return out;
}

/**
 * 检查 B（路径）：校验「相对 import / export-from / import() 路径是否真能解析到文件」。
 *
 * 背景：旧版 import-lint 只查「符号是否声明」，不校验路径是否可解析——一个目录深度写错的相对
 * import（如 `src/ui/` 下误写 `./core/registry.js`，解析成并不存在的 `src/ui/core/registry.js`）
 * 能过 lint，直到 `vite build` 才报 UNRESOLVED_IMPORT、构建直接失败。本函数在 lint 阶段（跑在
 * build 之前）就拦下，满足「构建阶段尽早暴露」。
 *
 * 规则：
 *  - 仅校验「相对路径」（以 ./ 或 ../ 开头）的静态字符串 specifier；
 *    bare 标识符（如 'acorn'、'wordcloud'）与绝对路径（/...）由打包器/运行时解析，跳过。
 *  - 动态 import(variable) 的 source 非字面量 → 无法静态解析，跳过。
 *  - 本项目约定：原生 ESM + dev 模式纯 http 伺服（无 Vite transform、无扩展名推断），相对 import
 *    必须带显式扩展名且精确命中文件。故「可解析」= 该字面量路径必须 exists 且为文件，
 *    不做 .js / index.js 兜底（避免把 dev 模式下同样会炸的缺扩展名路径误判为通过）。
 *
 * @param {string} code 文件源码
 * @param {string} file 当前文件绝对路径（相对解析基址）
 * @returns {Array<{line:number, spec:string, resolved:string}>} 无法解析的相对路径列表
 */
function collectBrokenPaths(code, file) {
    const ast = parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowHashBang: true,
    });
    const dir = path.dirname(file);
    /** @type {Array<{line:number, spec:string, resolved:string}>} */
    const out = [];
    const tryResolve = (base) => {
        try {
            const st = fs.statSync(base);
            return st.isFile() ? base : null;
        } catch {
            return null; // 不存在 → 返回 null
        }
    };
    const checkSource = (srcNode) => {
        if (!srcNode || srcNode.type !== 'Literal' || typeof srcNode.value !== 'string') return; // 非字面量 → 跳过
        const spec = srcNode.value;
        if (!(spec.startsWith('./') || spec.startsWith('../'))) return; // 非相对 → 跳过
        const resolved = path.resolve(dir, spec);
        if (!tryResolve(resolved)) {
            const line = srcNode.loc ? srcNode.loc.start.line : 0;
            out.push({ line, spec, resolved });
        }
    };
    /** 通用 AST 递归：定位 import / export-from / 动态 import 的 source 字面量 */
    const visit = (node) => {
        if (!node || typeof node !== 'object' || !node.type) return;
        if (
            node.type === 'ImportDeclaration' ||
            node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportAllDeclaration' ||
            node.type === 'ImportExpression'
        ) {
            checkSource(node.source);
        }
        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
            const child = node[key];
            if (child && typeof child === 'object') {
                if (Array.isArray(child)) child.forEach((c) => c && c.type && visit(c));
                else if (child.type) visit(child);
            }
        }
    };
    visit(ast);
    return out;
}

/**
 * 递归遍历目录下的 .js 文件。
 * @param {string} dir 目录绝对路径
 * @param {(file:string)=>void} cb 对每个 .js 文件调用
 */
function walkDir(dir, cb) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full, cb);
        else if (entry.isFile() && entry.name.endsWith('.js')) cb(full);
    }
}

/** @type {Array<{file:string, items:Array<{line:number, name:string}>}>} */
const problems = [];
/** @type {Array<{file:string, items:Array<{line:number, spec:string, resolved:string}>}>} */
const pathProblems = [];
walkDir(SRC_DIR, (file) => {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
    const code = fs.readFileSync(file, 'utf8');
    try {
        const items = lintFile(code);
        if (items.length) problems.push({ file: rel, items });
    } catch (e) {
        problems.push({ file: rel, items: [{ line: 0, name: 'PARSE_ERROR', msg: e.message }] });
    }
    try {
        const paths = collectBrokenPaths(code, file);
        if (paths.length) pathProblems.push({ file: rel, items: paths });
    } catch (e) {
        pathProblems.push({ file: rel, items: [{ line: 0, spec: '', resolved: e.message }] });
    }
});

const symbolTotal = problems.reduce((n, p) => n + p.items.length, 0);
const pathTotal = pathProblems.reduce((n, p) => n + p.items.length, 0);

if (symbolTotal === 0 && pathTotal === 0) {
    console.log('import-lint: 通过 — src/ 下全部 .js 的①引用符号均已 import/声明 ②相对 import 路径均可解析到文件。');
    process.exit(0);
}

let anyError = false;

if (symbolTotal > 0) {
    anyError = true;
    let total = 0;
    console.log('import-lint: 发现疑似「用了却未 import / 未声明」的符号（运行时将抛 ReferenceError）：');
    for (const p of problems) {
        for (const it of p.items) {
            total++;
            if (it.name === 'PARSE_ERROR') console.log(`  [${p.file}] 解析失败: ${it.msg}`);
            else console.log(`  ${p.file}:L${it.line}  ->  ${it.name}`);
        }
    }
    console.log(`\n  符号类共 ${total} 处。处理：①真漏 import → 补 import；②真漏声明 → 补声明；③合法全局误报 → 加 GLOBALS 白名单。`);
}

if (pathTotal > 0) {
    anyError = true;
    let total = 0;
    console.log('import-lint: 发现相对 import 路径无法解析到文件（与 vite build 的 UNRESOLVED_IMPORT 同源，构建会失败）：');
    for (const p of pathProblems) {
        for (const it of p.items) {
            total++;
            if (it.spec === '') console.log(`  [${p.file}] 解析异常: ${it.resolved}`);
            else console.log(`  ${p.file}:L${it.line}  ->  '${it.spec}'  解析为不存在: ${it.resolved}`);
        }
    }
    console.log(`\n  路径类共 ${total} 处。处理：①目录深度写错 → 按「相对直接父目录」修正（如 src/ui/ 下应是 '../core/x.js' 而非 './core/x.js'）；②文件名/扩展名拼错 → 修正字面量。`);
}

if (anyError) process.exit(1);
