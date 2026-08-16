// vite-plugin-deps.js
// 开发期依赖可视化插件：把 Vite 已经解析好的模块图（server.moduleGraph）暴露为
// 一个 HTTP 接口 GET /__deps，返回 { nodes, links } 供前端 D3 力导向图消费。
//
// 设计要点（基于 Vite 8.2.1 真实 API，非旧版抄写）：
//  - ViteDevServer.moduleGraph 仍存在（便利属性，指向 client 环境的 ModuleGraph）。
//  - ModuleNode.importedModules 是 getter，返回 Set<ModuleNode>。
//  - moduleGraph.idToModuleMap: Map<id, ModuleNode> 可迭代。
//  - Vite 的模块图是“按需填充”的：应用没在浏览器跑过，图可能为空。
//    因此用 server.transformRequest() 主动预热——这是公开 API，稳定。
//  - 仅 build 时 configureServer 不执行，对单文件产物零侵入。

import { statSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path';

/**
 * 提取文件头部注释块（供「AI 完备 Prompt」的全局地图使用）
 * - .js 取文件头 JSDoc 块（本项目所有 src JS 文件头部都是 /** 起始的注释块）
 * - .css 取文件头注释块
 * - 无头部注释返回空串
 * @param {string} file - 绝对文件路径
 * @returns {string}
 */
function extractHeadComment(file) {
  try {
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
    const m = text.match(/^\s*\/\*[\s\S]*?\*\//);
    return m ? m[0] : '';
  } catch (e) {
    return '';
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.entry='/src/main.js'] 项目入口 URL（dev 服务器视角）
 * @param {string[]} [options.coreFiles] 「AI 完备 Prompt」的防幻觉基石文件（相对项目根的路径）：
 *   生成 Prompt 时前端通过 /__code 拉取这些文件源码作为全局核心契约。
 *   默认含 core 层基础 + hooks.json（插件契约单一事实源，注意它在项目根、不在 /src/ 下，
 *   不会被 /__deps 模块图收录，必须在此显式配置才能被拉取）。
 */
export default function depsPlugin(options = {}) {
  const entry = options.entry || '/src/main.js';
  const coreFiles = options.coreFiles || [
    'src/core/state.js',
    'src/core/constants.js',
    'src/core/dom.js',
    'src/core/bus.js',
    'src/core/utils.js',
    'hooks.json'
  ];

  return {
    name: 'vite-plugin-deps',

    configureServer(server) {
      // 预热结果缓存：文件变动后失效，保证图实时且请求廉价。
      let warmPromise = null;
      const invalidate = () => { warmPromise = null; };
      server.watcher.on('change', invalidate);
      server.watcher.on('add', invalidate);
      server.watcher.on('unlink', invalidate);

      // 不动点爬取整张静态依赖图（见 ensureGraph 内部实现说明）。
      async function ensureGraph() {
        if (warmPromise) return warmPromise;
        warmPromise = (async () => {
          const seen = new Set();
          // 先验入口，触发 Vite 记录其 importedModules。
          seen.add(entry);
          try {
            await server.transformRequest(entry);
          } catch (e) {
            server.config.logger.warn(`[vite-plugin-deps] 预热失败: ${entry} — ${e.message}`);
          }
          // 不动点爬取：transformRequest 会异步向 moduleGraph 追加新模块，
          // 故反复扫描 idToModuleMap，直到一轮无任何新增 src 模块为止。
          // 这样即便 Vite 异步填充 importedModules，也能收敛到完整静态图，
          // 避免首请求缓存到半截图（表现为节点数偏少）。
          let added = true;
          while (added) {
            added = false;
            const batch = [];
            for (const [id] of server.moduleGraph.idToModuleMap) {
              if (id.includes('node_modules') || id.includes('\0')) continue;
              if (!id.includes('/src/')) continue;
              if (!seen.has(id)) { seen.add(id); batch.push(id); added = true; }
            }
            for (const id of batch) {
              try {
                await server.transformRequest(id);
              } catch (e) {
                server.config.logger.warn(`[vite-plugin-deps] 预热失败: ${id} — ${e.message}`);
              }
            }
          }
        })();
        return warmPromise;
      }

      server.middlewares.use('/__deps', async (req, res) => {
        try {
          await ensureGraph();
          const { moduleGraph } = server;

          const nodes = [];
          const links = [];
          const moduleMap = new Map();
          const usedIds = new Set(); // 防御：basename 撞名时加父目录消歧

          for (const [id, moduleNode] of moduleGraph.idToModuleMap) {
            if (id.includes('node_modules')) continue; // 排除第三方依赖
            if (id.includes('\0')) continue;           // 排除虚拟模块
            if (!id.includes('/src/')) continue;        // 只关心业务源码

            const relativePath = id.replace(/.*?\/src\//, 'src/');
            let shortId = basename(relativePath);
            if (usedIds.has(shortId)) {
              shortId = `${dirname(relativePath).split('/').pop()}/${shortId}`;
            }
            usedIds.add(shortId);

            let size = 1;
            try {
              if (moduleNode.file) {
                const stats = statSync(moduleNode.file);
                size = Math.max(1, Math.round((stats.size / 1024) * 10) / 10); // KB，1 位小数
              }
            } catch (e) { /* 文件可能尚未落盘，忽略 */ }

            let type = 'default';
            if (relativePath.endsWith('main.js')) type = 'entry';
            else if (relativePath.includes('/core/')) type = 'core';
            else if (relativePath.includes('/engines/')) type = 'engine';
            else if (relativePath.includes('/ui/')) type = 'ui';
            else if (relativePath.includes('/plugins/')) type = 'plugin';

            nodes.push({ id: shortId, path: relativePath, size, type, jsdoc: moduleNode.file ? extractHeadComment(moduleNode.file) : '' });
            moduleMap.set(moduleNode, shortId);
          }

          // 由 importedModules 生成有向边：source 引用了 target。
          for (const moduleNode of moduleMap.keys()) {
            const sourceId = moduleMap.get(moduleNode);
            for (const targetNode of moduleNode.importedModules || []) {
              const targetId = moduleMap.get(targetNode);
              if (targetId && sourceId !== targetId) {
                links.push({ source: sourceId, target: targetId, kind: 'direct' });
              }
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ nodes, links, coreFiles }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String((err && err.message) || err) }));
        }
      });

      // /__code：按路径列表读取文件真实源码（「AI 完备 Prompt」的代码切片/核心契约数据源）。
      // 请求格式：GET /__code?paths=src/core/state.js,hooks.json
      // 响应：{ files: [{ path, source }] }；路径校验防 ../ 逃逸（本地 dev 工具，拒绝越出项目根）。
      server.middlewares.use('/__code', (req, res) => {
        try {
          const root = server.config.root;
          const url = new URL(req.url, 'http://localhost');
          const paths = (url.searchParams.get('paths') || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);

          const files = [];
          for (const p of paths) {
            const abs = resolve(root, p);
            // 路径越界判定（跨平台）：relative 结果以 .. 开头或为绝对路径 = 逃出项目根
            const rel = relative(root, abs);
            if (rel.startsWith('..') || isAbsolute(rel)) {
              files.push({ path: p, source: '', error: '路径越界被拒绝' });
              continue;
            }
            try {
              files.push({ path: p, source: readFileSync(abs, 'utf8') });
            } catch (e) {
              files.push({ path: p, source: '', error: String((e && e.message) || e) });
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ files }));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String((err && err.message) || err) }));
        }
      });
    },
  };
}
