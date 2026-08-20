import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import depsPlugin from './vite-plugin-deps.js';
import { copyFileSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 构建环境标记：GitHub Actions 运行时**自动**置 GITHUB_ACTIONS='true'，本地无此变量 → 默认"本地"。
// 注入为 import.meta.env.VITE_BUILD_ENV（类型：'github' | '本地'），供 document.title 等区分构建来源。
const BUILD_ENV = process.env.GITHUB_ACTIONS === 'true' ? 'github' : '本地';

/**
 * 产物可读命名标签：默认取「分支名-短提交」；也可用环境变量显式传改动描述
 * （如 BUILD_LABEL=会话级llm-sp编辑 npm run build → dist/li-会话级llm-sp编辑.html），
 * 让产物文件名直接看出这版改了什么（版本区分用）。
 */
const BUILD_LABEL = process.env.BUILD_LABEL || (() => {
    try {
        return execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
            + '-' + execSync('git rev-parse --short HEAD').toString().trim();
    } catch (_) { return 'dev'; } // 无 git 环境时回退中性名
})();

/**
 * 构建收尾插件：构建结束后把 dist/index.html 复制一份为 dist/li-<label>.html。
 * 保留 index.html 原副本（兼容静态服务器/预览默认页），带名副本供用户直接取用区分版本。
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
  // depsPlugin 仅在 dev 服务器生效（configureServer），build 时不执行，对单文件产物零侵入。
  plugins: [viteSingleFile(), labeledOutput(), depsPlugin({
    coreFiles: [
      // 1. 防幻觉基石（原 core js + hooks 契约）
      'src/core/state.js',
      'src/core/constants.js',
      'src/core/dom.js',
      'src/core/bus.js',
      'src/core/utils.js',
      'hooks.json',
      // 2. CSS 全量规则（19 个 styles 子表 + 聚合入口 style.css）
      'src/style.css',
      'src/styles/tokens.css',
      'src/styles/base.css',
      'src/styles/background.css',
      'src/styles/chat.css',
      'src/styles/waifu.css',
      'src/styles/tts.css',
      'src/styles/topbar.css',
      'src/styles/monitor.css',
      'src/styles/msg-footer.css',
      'src/styles/responsive.css',
      'src/styles/modal.css',
      'src/styles/settings-panel.css',
      'src/styles/sandbox.css',
      'src/styles/form-controls.css',
      'src/styles/dropdown.css',
      'src/styles/fs-editor.css',
      'src/styles/context-menu.css',
      'src/styles/plugin-manager.css',
      'src/styles/quick-theme.css',
      // 3. HTML 骨架
      'index.html',
    ],
  })],
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
