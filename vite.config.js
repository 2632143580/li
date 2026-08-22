import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { copyFileSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 构建环境标记：GitHub Actions 运行时**自动**置 GITHUB_ACTIONS='true'，本地无此变量 → 默认"本地"。
// 注入为 import.meta.env.VITE_BUILD_ENV（类型：'github' | '本地'），供 document.title 等区分构建来源。
const BUILD_ENV = process.env.GITHUB_ACTIONS === 'true' ? 'github' : '本地';

/**
 * 文件名安全化：去掉 Windows 非法字符、多空格归一、过长截断，中文保留。
 * 非法字符 (/ \ : * ? " < > |) 直接变连字符，保证产物在任意系统可双击打开。
 */
function sanitizeLabel(s) {
    return String(s)
        .replace(/[\\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
}

/**
 * 产物可读命名标签：默认**自动取最近一次提交标题**（语义化，直接看出这版改了什么）；
 * 也可用环境变量显式覆盖（如 BUILD_LABEL=临时描述 npm run build）。
 * 取不到提交信息时回退「分支名-短提交」，再回退中性名 dev。
 * 这样平时只需 `npm run build`，产物名就自动跟着 commit message 走，零额外输入。
 */
const BUILD_LABEL = process.env.BUILD_LABEL || (() => {
    try {
        const msg = execSync('git log -1 --pretty=%s').toString().trim(); // 最近提交标题（最语义化）
        const fallback = execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
            + '-' + execSync('git rev-parse --short HEAD').toString().trim();
        return sanitizeLabel(msg) || fallback;
    } catch (_) { return 'dev'; } // 无 git 环境时回退中性名
})();

/**
 * 构建收尾插件：
 * 1. dist/index.html 复制一份为 dist/li-<label>.html。保留 index.html 原副本
 *    （兼容静态服务器/预览默认页），带名副本供用户直接取用区分版本。
 */
const labeledOutput = () => ({
    name: 'li-labeled-output',
    apply: 'build',
    closeBundle() {
        const src = path.join(__dirname, 'dist', 'index.html');
        const dst = path.join(__dirname, 'dist', `li-${BUILD_LABEL}.html`);
        copyFileSync(src, dst);
        console.log(`[li-labeled-output] 产物副本: ${dst}`);
    }
});

/**
 * 构建目标：把 index.html + 全部 ES Module + style.css 压回**一个**双击可运行的 HTML。
 *
 * 为什么需要这些选项（每一项都在解决单文件打包的一个具体障碍）：
 *   cssCodeSplit:false        —— 关闭 CSS 分包，否则 style.css 会被拆成独立 .css 外链文件
 *   assetsInlineLimit         —— 资源内联体积阈值（单位：字节）。设为极大值，强制所有资源转 base64 内联
 *   inlineDynamicImports:true —— 关闭动态 import 拆 chunk，保证只产出一个 JS bundle
 *   target:'esnext'           —— 单文件产物给现代浏览器直接双击运行，无需为旧引擎降级
 *
 * viteSingleFile() 会在上述基础上把 <script src> / <link rel=stylesheet> 改写为内联标签。
 */
export default defineConfig({
  base: './',
  // 将构建环境标记静态注入客户端：构建期即确定，运行时直接读取，无需运行时判断。
  define: {
    'import.meta.env.VITE_BUILD_ENV': JSON.stringify(BUILD_ENV),
  },
  plugins: [viteSingleFile(), labeledOutput()],
  build: {
    target: 'esnext',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
