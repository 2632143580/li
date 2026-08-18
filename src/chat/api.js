/**
 * API 客户端 + 插件代码解析（事件绑定已迁至 ui/event-bindings，stage3 解耦）
 *
 * 职责：
 *   1. streamChat：流式请求 + 超时保护 + 缓存命中追踪
 *   2. executeStreamRequest：三处重复请求的公共逻辑提取
 *   3. applyPluginCode：插件代码解析 + 四态嗅探分发（背景/主题/混合）
 *   4. 订阅 core/bus 的 STREAM_REQUEST，承接 tree.js 的发消息请求
 *
 * 导出：streamChat, executeStreamRequest, applyPluginCode
 * 依赖：core/dom, core/state, core/logger, core/storage, core/bus（订阅 tree 的 STREAM_REQUEST）,
 *       engines/bg-engine, engines/theme-engine,
 *       ui/input-renderer, chat/tree, main（onResize）
 * 注意：事件绑定（bind*）与背景图编辑状态（tempSettings / crop*）已迁到 ui/event-bindings，
 *       本模块不再持有 UI 事件代码，仅保留 API 与插件解析能力。
 */
import { DOM, W, H } from '../core/dom.js';
import { Logger } from '../core/logger.js';
import { state } from '../core/store.js';
import { API_TIMEOUT_MS, DEFAULT_SETTINGS } from '../core/constants.js';
import { getProviderByUrl, safeParseInt, clamp, ensureKeysObject } from '../core/utils.js';
import { saveToLocal, debouncedSave } from '../core/storage.js';
import { BgEngine } from '../engines/bg-engine.js';
import { ThemeEngine } from '../engines/theme-engine.js';
import hooksData from '../../hooks.json'; // 宿主契约单一事实源：插件归因告警（通配/未命中钩子）从此读取
import { inputRenderer } from '../ui/input-renderer.js';
import { openFSEditor } from '../ui/input-manager.js';
import { onResize } from '../main.js';
// 来自 tree.js 的纯函数 / 状态（循环引用安全：均为运行时调用 / 活绑定）
// 仅保留本模块实际引用的名字；其余 tree.js 导出不再在此 import（避免死导入）。
import {
    updateMonitorUI, updateMsgContent, ingestUsage, setNodeError
} from './tree.js';

// 应用级事件总线（零依赖）：订阅来自 tree.js 的 STREAM_REQUEST，解耦 tree→api 的循环依赖
import { bus, EVENTS } from '../core/bus.js';


// ================================================================
//  API 客户端
//  流式请求 + 超时保护 + 缓存命中追踪
// ================================================================

/**
 * 发起流式聊天请求
 * @param {Array<{role:string,content:string}>} messages - API 消息体
 * @param {function(string)} onChunk - 每次收到新内容时回调（传入累积全文）
 * @param {function(string,object)} onDone - 流结束回调（传入全文和缓存命中 tokens）
 * @param {function(Error)} onError - 错误回调
 */
export async function streamChat(messages, onChunk, onDone, onError) {
    if (!messages.some(m => m.role === 'user')) {
        state.waiting = false;
        inputRenderer.markDirty();
        onError(new Error("本轮没有可发送的用户消息，无法请求模型。"));
        return;
    }

    const controller = new AbortController();
    let timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const reqBody = {
            model: state.settings.model,
            messages: messages,
            stream: true,
            temperature: 0.8
        };
        // enable_cache 为 DeepSeek 专属缓存开关；智谱 GLM 等无此字段，发送会被拒绝，故仅 DeepSeek 附加
        if (getProviderByUrl(state.settings.apiUrl) === 'deepseek') {
            reqBody.enable_cache = true;
        }

        const resp = await fetch(state.settings.apiUrl, {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + state.settings.apiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(reqBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
            let errInfo = `HTTP ${resp.status} ${resp.statusText}`;
            try {
                const errData = await resp.json();
                errInfo = errData.error?.message || errData.message || errInfo;
            } catch (e) {
                Logger.warn('[API] 解析错误响应失败', e);
            }
            throw new Error(errInfo);
        }

        // 防御：部分非标准服务器可能不返回 body 流
        if (!resp.body) {
            throw new Error("服务器未返回流式响应体");
        }

        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let full = "";
        let lastUsage = null; // 累积最近一次 usage（含 prompt/completion/total/cache 命中）

        while (true) {
            // 每次读取前重置超时
            timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
            const { done, value } = await reader.read();
            clearTimeout(timeoutId);

            if (done) break;

            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";

            for (const ln of lines) {
                const t = ln.trim();
                if (!t.startsWith("data:")) continue;
                const d = t.slice(5).trim();
                if (d === "[DONE]") {
                    // 先落 waiting 再回调：onDone 内部会做最终一次渲染，
                    // 若此时 waiting 仍为 true，渲染会被判定为"流式中"而走增量分支，
                    // 导致打字指示器无法被非流式重建路径清除。
                    state.waiting = false;
                    onDone(full, lastUsage);
                    return;
                }
                try {
                    const j = JSON.parse(d);
                    const delta = j.choices?.[0]?.delta;
                    if (delta?.content) {
                        full += delta.content;
                        onChunk(full);
                    }
                    if (j.usage) lastUsage = j.usage; // 记录完整 usage，供监控统计消费
                } catch (e) {
                    Logger.warn('[API] 解析 SSE 行失败', e, d.slice(0, 80));
                }
            }
        }
        state.waiting = false;
        onDone(full, lastUsage);
    } catch (e) {
        let errMsg = e.message || "未知网络错误";
        if (e.name === 'AbortError') errMsg = "请求超时，请检查网络连接";
        // 浏览器原生 "Failed to fetch" 多为跨域(CORS)限制或接口不可达，给出可操作的排查提示
        else if (e.name === 'TypeError' && /fetch/i.test(errMsg)) {
            errMsg = "网络请求失败（Failed to fetch）：多为跨域(CORS)限制或接口地址不可达。请确认 API 地址正确、网络可达，或通过后端代理访问。";
        }
        Logger.error('[API] 流式请求失败', e);
        state.waiting = false;
        onError(new Error(errMsg));
    } finally {
        clearTimeout(timeoutId);
        // 兜底：上面三个出口已各自置 false，此处覆盖 return/异常绕过的残余路径。重复赋值幂等无副作用。
        state.waiting = false;
        inputRenderer.markDirty();
    }
}

/**
 * 执行流式请求的公共逻辑
 * 提取自 sendMessage / regenerate / editAndResend 三处重复代码
 * @param {Array} apiMessages - 构建好的 API 消息体
 * @param {object} aiNode - AI 回复节点
 */
export function executeStreamRequest(apiMessages, aiNode) {
    updateMonitorUI();
    return streamChat(
        apiMessages,
        (full) => updateMsgContent(aiNode, full),
        (full, usage) => {
            updateMsgContent(aiNode, full);
            ingestUsage(usage); // 合并 usage 到监控统计并刷新 UI
            BgEngine.triggerMessage('assistant', full);
            bus.emit(EVENTS.ASSISTANT_DONE, full); // 广播 AI 完成文本，供背景触发器按触发词切换
            // 语音回复（句句发语音）：不在到达时自动朗读，改为 renderContent 把 AI 回复渲染成语音条，
            // 由用户点击语音条播放（符合「点击气泡播放、再点停止」的交互，避免浏览器自动播放策略拦截）。
            saveToLocal(null, true);
        },
        (err) => {
            setNodeError(aiNode, err.message);
            saveToLocal(null, true);
        }
    );
}

// 订阅事件总线：tree.js 通过 bus.emit(STREAM_REQUEST, { apiMessages, aiNode }) 触发发消息，
// 本模块不再被 tree 直接 import executeStreamRequest —— 循环依赖削掉一条边（stage2 解耦）。
// 注册发生在 api.js 模块求值期（startup 即被 main.js 引入），用户首次发消息前订阅已就绪。
bus.on(EVENTS.STREAM_REQUEST, ({ apiMessages, aiNode }) => {
    // 兜底：dispatchEvent 会吞掉 listener 抛出的同步异常（EventTarget 规范行为，异常不向调用方冒泡）。
    // 若 executeStreamRequest 同步抛错，state.waiting 已置 true 却永远无法复位 → 输入框永久锁死。
    // 故同步路径用 try/catch 复位；异步返回的 Promise 追加 .catch 兜底同一目标，两条路径都复位 waiting 并标记错误节点。
    try {
        const p = executeStreamRequest(apiMessages, aiNode);
        if (p && typeof p.catch === 'function') {
            p.catch((err) => {
                Logger.error('[API] 流式处理被拒', err);
                if (aiNode) setNodeError(aiNode, err.message || '请求处理失败');
                state.waiting = false;
                inputRenderer.markDirty();
            });
        }
    } catch (err) {
        Logger.error('[API] 处理 STREAM_REQUEST 失败', err);
        if (aiNode) setNodeError(aiNode, err.message || '请求处理失败');
        state.waiting = false;
        inputRenderer.markDirty();
    }
});
/**
 * 解析并挂载一个代码插件字符串（非模块 .txt，文件末尾 return 对象）。
 * 成功返回成功描述文案；失败抛出 Error（含中文引导）。供文件导入、批量导入、沙盒 __loadPlugin 复用。
 * @param {string} codeString 插件源码文本
 * @param {(level:'info'|'warn'|'error', msg:string)=>void} [onLog] 可选日志回调；省略时走内部 Logger
 * @returns {string} 成功描述
 */
export function applyPluginCode(codeString, onLog) {
    const log = (level, msg) => {
        if (onLog) { onLog(level, msg); return; }
        if (level === 'error') Logger.error('[Plugin]', msg);
        else if (level === 'warn') Logger.warn('[Plugin]', msg);
        else Logger.info('[Plugin]', msg);
    };
    let pluginObj;
    try {
        const func = new Function(codeString);
        pluginObj = func();
    } catch (evalErr) {
        // 插件必须是「非模块」.txt：靠文件末尾 return {...} 返回对象，不能含 import/export。
        // 若源码含 import/export 却被 new Function 当普通脚本执行，会抛此错，这里转成可操作引导。
        if (/\b(import|export)\b/.test(codeString)) {
            const tip = "插件必须是非模块 .txt 文件，不能包含 import/export 语句；请删除 import/export，用文件末尾 return 返回对象（参照导出的主题模板）";
            log('error', tip);
            throw new Error(tip);
        }
        log('error', '插件解析失败：' + evalErr.message);
        throw evalErr;
    }
    if (!pluginObj || typeof pluginObj !== 'object') {
        const tip = "格式错误：未返回有效对象（文件末尾需 return 主题对象）";
        log('error', tip);
        throw new Error(tip);
    }

    // === 特征嗅探自动分发：一个对象可同时具备"背景特征"与"主题特征"，无需任何 bundle 包装 ===
    // 背景特征：init+animate(Canvas 背景) 或 type:'dom'+onMount(DOM 背景)
    // 主题特征：meta.cssText(字符串) 或 meta.tokens(对象)
    const hasCanvasBg = typeof pluginObj.init === 'function' && typeof pluginObj.animate === 'function';
    const hasDomBg = pluginObj.type === 'dom' && typeof pluginObj.onMount === 'function';
    const hasBg = hasCanvasBg || hasDomBg;
    const hasTheme = !!(pluginObj.meta && (typeof pluginObj.meta.cssText === 'string' || (pluginObj.meta.tokens && typeof pluginObj.meta.tokens === 'object')));

    const cssText = hasTheme ? (pluginObj.meta?.cssText || '') : '';
    // 归因告警 1：通配选择器（瞎猜 DOM 的标志）
    if (cssText && /\[\s*class\*=?["']?/.test(cssText)) {
        log('warn', `CSS 含通配选择器（如 [class*=...]），可能瞎猜宿主 DOM 类名。请用契约钩子：${hooksData.bubbleHooks.ai} / ${hooksData.bubbleHooks.user}`);
    }
    // 归因告警 2：主题未命中任何宿主气泡钩子（气泡可能透明）
    if (hasTheme && cssText) {
        const hitAi = cssText.includes(hooksData.bubbleHooks.ai);
        const hitUser = cssText.includes(hooksData.bubbleHooks.user);
        if (!hitAi && !hitUser) {
            log('warn', `主题 CSS 未命中任何宿主气泡钩子（${hooksData.bubbleHooks.ai} / ${hooksData.bubbleHooks.user}），气泡可能透明。请检查是否写了 DOM 不存在的类。`);
        }
    }

    const typeName = (hasBg && hasTheme) ? '混合' : hasCanvasBg ? 'Canvas背景' : hasDomBg ? 'DOM背景' : hasTheme ? '主题' : '未知';
    log('info', `解析成功，类型：${typeName}`);

    // 记录已成功激活的子插件，任一 mount 抛错时整体回滚，避免留下脏状态
    const mounted = [];
    const rollback = () => {
        for (const m of mounted) {
            try {
                if (m.engine === 'bg') BgEngine.unmount(m.id);
                else ThemeEngine.unmount(m.id);
            } catch (_) { /* 回滚失败忽略，避免掩盖原错误 */ }
        }
    };

    try {
        if (hasBg && hasTheme) {
            // 混合插件：自动嗅探拆分为"背景子插件" + "主题子插件"分派两个引擎。
            const bgMeta = { ...pluginObj.meta };
            delete bgMeta.cssText;
            delete bgMeta.tokens;
            const bgPlugin = {
                type: pluginObj.type,
                meta: bgMeta,
                init: pluginObj.init,
                animate: pluginObj.animate,
                onMount: pluginObj.onMount,
                onUnmount: pluginObj.onUnmount
            };
            const themePlugin = {
                meta: {
                    name: pluginObj.meta?.name,
                    cssText: pluginObj.meta?.cssText,
                    tokens: pluginObj.meta?.tokens
                }
            };
            const bgId = 'bg_custom_' + Date.now();
            const themeId = 'theme_custom_' + Date.now();
            BgEngine.registerPlugin(bgId, bgPlugin);
            const okBg = BgEngine.mount(bgId);
            mounted.push({ engine: 'bg', id: bgId });
            if (!okBg) throw new Error('混合插件：背景子插件初始化失败（onMount/init 抛错，已回滚）');
            ThemeEngine.register(themeId, themePlugin);
            const okTheme = ThemeEngine.mount(themeId);
            mounted.push({ engine: 'theme', id: themeId });
            if (!okTheme) throw new Error('混合插件：主题子插件初始化失败（onMount 抛错，已回滚）');
            log('info', '混合插件：背景 + 主题 均已挂载');
            return "混合插件导入成功！已自动嗅探并拆分为背景 + 主题两部分。";
        } else if (hasCanvasBg) {
            if (!pluginObj.meta) pluginObj.meta = { bgColor: 'transparent' };
            const customName = 'bg_custom_' + Date.now();
            BgEngine.registerPlugin(customName, pluginObj);
            const ok = BgEngine.mount(customName);
            // 补追踪：旧实现单态分支从不 push mounted，回滚机制对单态插件形同虚设（D1）。
            mounted.push({ engine: 'bg', id: customName });
            // mount 现返回真值；init/onMount 抛错 → false → 抛出让外层 catch 触发回滚，根除"假成功"。
            if (!ok) throw new Error('Canvas 背景插件初始化失败（onMount/init 抛错，已回滚）');
            log('info', 'Canvas 背景已挂载');
            return "Canvas 背景插件导入成功！";
        } else if (hasDomBg) {
            const customName = 'bg_dom_' + Date.now();
            BgEngine.registerPlugin(customName, pluginObj);
            const ok = BgEngine.mount(customName);
            mounted.push({ engine: 'bg', id: customName });
            if (!ok) throw new Error('DOM 背景插件初始化失败（onMount 抛错，已回滚）');
            log('info', 'DOM 背景已挂载');
            return "DOM 背景插件导入成功！";
        } else if (hasTheme) {
            const customName = 'theme_custom_' + Date.now();
            ThemeEngine.register(customName, pluginObj);
            const ok = ThemeEngine.mount(customName);
            mounted.push({ engine: 'theme', id: customName });
            if (!ok) throw new Error('主题插件初始化失败（onMount 抛错，已回滚）');
            if (cssText) log('info', '主题 CSS 已注入 <head>');
            log('info', '主题已挂载');
            return "主题插件导入成功！";
        } else {
            const tip = "接口错误：无法识别的插件类型（需具备 init+animate / type:'dom'+onMount / meta.cssText|tokens，或同时具备背景+主题特征以自动嗅探拆分）";
            log('error', tip);
            throw new Error(tip);
        }
    } catch (err) {
        rollback();
        const tip = "导入失败，已回滚：" + err.message;
        log('error', tip);
        throw new Error(tip);
    }
}