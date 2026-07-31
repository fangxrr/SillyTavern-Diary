/**
 * API 层
 *
 * 两种连接方式：
 *   standalone —— 浏览器直连你填的地址。完全绕开酒馆的 API 和预设。
 *                 注意：会撞 CORS。Gemini / OpenRouter / 多数中转站没问题，
 *                 OpenAI 官方端点会被浏览器拦掉，那种情况请改用 tavern 模式。
 *   tavern     —— 借用酒馆的连接（走它的后端转发，没有 CORS 问题）。
 *                 只借连接，不借预设，也不会切换你正在用的配置。
 */

import { getContext } from '../../../extensions.js';

/** 把用户填的地址规整成 .../v1 形式 */
function normalizeBase(url) {
    let u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/(chat\/)?completions$/.test(u)) u = u.replace(/\/(chat\/)?completions$/, '');
    if (!/\/v\d+$/.test(u) && !/\/api$/.test(u)) u += '/v1';
    return u;
}

/* ────────── 独立 API ────────── */

export async function fetchModels(url, key) {
    const base = normalizeBase(url);
    if (!base) throw new Error('先填 API 地址');
    const res = await fetch(`${base}/models`, {
        method: 'GET',
        headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) throw new Error(await describeError(res));
    const json = await res.json();
    const list = json?.data || json?.models || [];
    return list.map(m => m.id || m.name).filter(Boolean).sort();
}

async function callStandalone(cfg, messages, signal) {
    const base = normalizeBase(cfg.url);
    if (!base) throw new Error('先填 API 地址');
    if (!cfg.model) throw new Error('先选模型');

    let res;
    try {
        res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
            },
            body: JSON.stringify({
                model: cfg.model,
                messages,
                temperature: Number(cfg.temp) || 0.7,
                max_tokens: Number(cfg.max) || 1000,
                stream: false,
            }),
            signal,
        });
    } catch (e) {
        // fetch 直接抛异常，八成是 CORS 或者地址不通
        throw new Error(
            '连不上。可能是地址写错，或者这个端点不允许浏览器直连（CORS）。' +
            '若是后者，把连接方式改成「酒馆当前」。');
    }
    if (!res.ok) throw new Error(await describeError(res));

    const json = await res.json();
    const choice = json?.choices?.[0];
    const text = choice?.message?.content
        ?? choice?.text
        ?? json?.content?.[0]?.text
        ?? '';
    if (!text) throw new Error('返回是空的');

    return {
        text: String(text).trim(),
        // 'length' / 'max_tokens' 都表示写到一半被上限切断了
        finish: choice?.finish_reason ?? choice?.stop_reason ?? json?.stop_reason ?? '',
        usage: json?.usage || null,
    };
}

async function describeError(res) {
    let detail = '';
    try {
        const t = await res.text();
        detail = (JSON.parse(t)?.error?.message) || t.slice(0, 200);
    } catch { /* 读不出就算了 */ }
    if (res.status === 401 || res.status === 403) return `密钥被拒（${res.status}）${detail ? '：' + detail : ''}`;
    if (res.status === 404) return `地址不对（404）。检查末尾是不是该带 /v1`;
    if (res.status === 429) return '被限流了（429），等一下再试';
    return `请求失败（${res.status}）${detail ? '：' + detail : ''}`;
}

/* ────────── 酒馆连接 ────────── */

/** 取出可用的连接配置（Connection Profiles） */
export function tavernProfiles() {
    const ctx = getContext();
    const list = ctx?.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(list) ? list : [];
}

function hasConnectionManager() {
    const ctx = getContext();
    return typeof ctx?.ConnectionManagerRequestService?.sendRequest === 'function';
}

async function callTavern(cfg, messages) {
    const ctx = getContext();
    const prompt = messages.map(m => m.content).join('\n\n');

    // 首选：指定的连接配置。不会切换你正在用的那个。
    if (cfg.profile && hasConnectionManager()) {
        const r = await ctx.ConnectionManagerRequestService.sendRequest(
            cfg.profile, prompt, Number(cfg.max) || 1000,
        );
        const text = r?.content ?? r?.choices?.[0]?.message?.content ?? r;
        if (text) {
            return {
                text: String(text).trim(),
                finish: r?.choices?.[0]?.finish_reason ?? '',
                usage: r?.usage || null,
            };
        }
    }

    // 退路：用酒馆当前连着的那个，静默生成，不写进聊天记录
    if (typeof ctx.generateQuietPrompt === 'function') {
        const text = await ctx.generateQuietPrompt(prompt, false, false);
        if (text) return { text: String(text).trim(), finish: '', usage: null };
    }
    throw new Error('酒馆这边没能发出请求。换成「独立 API」试试。');
}

/* ────────── 统一入口 ────────── */

/** 返回 { text, finish, usage }。finish 为 length/max_tokens 表示被上限截断。 */
export async function chat(cfg, messages, signal) {
    return cfg.mode === 'tavern'
        ? callTavern(cfg, messages)
        : callStandalone(cfg, messages, signal);
}

/** 这次回复是不是写到一半被 max_tokens 切断了 */
export function wasTruncated(r) {
    return /^(length|max_tokens|MAX_TOKENS)$/i.test(String(r?.finish || ''));
}

/** 测试连接，返回一句人话 */
export async function testConnection(cfg) {
    const t0 = Date.now();
    const r = await chat(cfg, [{ role: 'user', content: '回复"ok"两个字母，不要别的。' }]);
    return `通了（${Date.now() - t0}ms）：${r.text.slice(0, 40)}`;
}

/** 从模型输出里抠 JSON，容忍它多嘴 */
export function parseJson(text) {
    let t = String(text).trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
}
