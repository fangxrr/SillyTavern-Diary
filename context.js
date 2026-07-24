/**
 * 上下文层
 * 负责把「一堆聊天记录」变成「干净的、模型能读的正文」。
 */

import { getContext } from '../../../extensions.js';
import { settings, data, uidOf } from './store.js';

/* ────────── 正文提取 ────────── */

// 常见的噪音标签：思考、草稿、状态栏
const NOISE_TAGS = [
    'think', 'thinking', 'thought', 'thoughts', 'reasoning', 'reason',
    'slate', 'draft', 'plan', 'planning', 'analysis', 'scratchpad',
    'status', 'statusbar', 'stat', 'state', 'plot', 'meta', 'ooc', 'system',
];

export function cleanText(msg) {
    const s = settings();
    let text = String(msg?.mes || '');

    // 自定义正则优先：填了就只取匹配到的部分
    if (s.contentRegex?.trim()) {
        try {
            const re = new RegExp(s.contentRegex, 'gi');
            const hits = [];
            let m;
            while ((m = re.exec(text)) !== null) {
                hits.push(m[1] ?? m[0]);
                if (m.index === re.lastIndex) re.lastIndex++;
            }
            if (hits.length) return tidy(hits.join('\n\n'));
        } catch { /* 正则写错了就退回默认清洗 */ }
    }

    if (!s.clean) return tidy(text);

    // 剥标签块
    for (const tag of NOISE_TAGS) {
        text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
        text = text.replace(new RegExp(`<${tag}[^>]*\\/?>`, 'gi'), '');
    }
    // 剥 markdown 代码块（状态栏常这么写）
    text = text.replace(/```[\s\S]*?```/g, '');
    // 剥 <details> 折叠块
    text = text.replace(/<details[\s\S]*?<\/details>/gi, '');
    // 剥表格行
    text = text.replace(/^\s*\|.*\|\s*$/gm, '');
    // 剥剩余 HTML 标签，保留文字
    text = text.replace(/<\/?[a-z][^>]*>/gi, '');

    return tidy(text);
}

function tidy(t) {
    return String(t).replace(/\n{3,}/g, '\n\n').trim();
}

/** 消息是否值得送进日记（空的、纯系统的就算了） */
export function worthReading(msg) {
    if (!msg) return false;
    if (msg.is_system) return false;
    return cleanText(msg).length > 0;
}

/** 把一批消息拼成带编号的正文 */
export function numbered(messages) {
    return messages.map((m, i) => {
        const who = m.is_user ? (getContext().name1 || 'User') : (m.name || getContext().name2 || 'Char');
        return `[${i}] ${who}：${cleanText(m)}`;
    }).join('\n\n');
}

/** 不带编号，供写日记用 */
export function plain(messages) {
    return messages.map(m => {
        const who = m.is_user ? (getContext().name1 || 'User') : (m.name || getContext().name2 || 'Char');
        return `${who}：${cleanText(m)}`;
    }).join('\n\n');
}

/* ────────── 世界书 ────────── */

async function loadBook(name) {
    try {
        const mod = await import('../../../world-info.js');
        if (typeof mod.loadWorldInfo === 'function') return await mod.loadWorldInfo(name);
    } catch { /* 版本不兼容就当没有 */ }
    return null;
}

/** 列出所有可选的世界书 */
export async function listBooks() {
    try {
        const mod = await import('../../../world-info.js');
        const names = Array.isArray(mod.world_names) ? mod.world_names : [];
        const ctx = getContext();
        // 角色卡绑定的那本，用来做默认勾选
        const bound = ctx?.characters?.[ctx.characterId]?.data?.extensions?.world || '';
        return names.map(n => ({ name: n, bound: n === bound }));
    } catch {
        return [];
    }
}

/** 取世界书内容。constantOnly 时只要常驻（蓝灯）条目。 */
export async function readWorld() {
    const s = settings();
    if (!s.world.enabled || !s.world.books.length) return '';

    const chunks = [];
    for (const name of s.world.books) {
        const book = await loadBook(name);
        if (!book?.entries) continue;
        for (const e of Object.values(book.entries)) {
            if (e.disable) continue;
            if (s.world.constantOnly && !e.constant) continue;
            const body = String(e.content || '').trim();
            if (body) chunks.push(body);
        }
    }
    return budget(chunks.join('\n\n'), s.world.budget);
}

/** 取记忆插件那本的最近 N 条 */
export async function readMemory() {
    const s = settings();
    if (!s.memory.enabled || !s.memory.book) return '';

    const book = await loadBook(s.memory.book);
    if (!book?.entries) return '';
    const all = Object.values(book.entries)
        .filter(e => !e.disable && String(e.content || '').trim())
        .sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
    const recent = all.slice(-Math.max(1, Number(s.memory.recent) || 8));
    return budget(recent.map(e => String(e.content).trim()).join('\n\n'), s.memory.budget);
}

/** 粗略按字数截断，从最旧的开始砍 */
function budget(text, maxTokens) {
    const limit = Math.max(200, Number(maxTokens) || 2000) * 2; // 中文粗估 1 token ≈ 0.5 字
    if (text.length <= limit) return text;
    return '…（较早的内容已略去）\n\n' + text.slice(-limit);
}

/* ────────── 提示词组装 ────────── */

export async function buildWritePrompt(date, messages) {
    const s = settings();
    const ctx = getContext();
    const world = await readWorld();
    const memory = await readMemory();

    let body = s.writePrompt
        .replaceAll('{{char}}', ctx.name2 || '角色')
        .replaceAll('{{user}}', ctx.name1 || '用户')
        .replaceAll('{{date}}', date || '今天')
        .replaceAll('{{content}}', plain(messages))
        .replaceAll('{{world}}', world)
        .replaceAll('{{memory}}', memory);

    // 提示词里没显式引用的，作为前置块补上，并分开标注
    const pre = [];
    if (world && !s.writePrompt.includes('{{world}}')) {
        pre.push(`<world_setting>\n${world}\n</world_setting>`);
    }
    if (memory && !s.writePrompt.includes('{{memory}}')) {
        pre.push(`<earlier_summary>\n${memory}\n</earlier_summary>`);
    }
    if (pre.length) {
        body = `以下是背景资料，只用来理解上下文，不要直接写进日记。\n\n${pre.join('\n\n')}\n\n---\n\n${body}`;
    }
    return [{ role: 'user', content: body }];
}

export function buildTimePrompt(messages) {
    const s = settings();
    const d = data();
    const body = s.timePrompt
        .replaceAll('{{start}}', d.startDate || `${s.startYearFallback}-01-01`)
        .replaceAll('{{content}}', numbered(messages));
    return [{ role: 'user', content: body }];
}

/** 让模型读第一条角色回复，猜故事起始日 */
export function buildStartPrompt(msg) {
    const s = settings();
    return [{
        role: 'user',
        content:
`读下面这段角色扮演的开场，判断故事发生在哪一天。
只输出 JSON，不要解释：{"date":"YYYY-MM-DD"}
看不出年份就用 ${s.startYearFallback}。完全看不出日期就用 ${s.startYearFallback}-01-01。

正文：
${cleanText(msg)}`,
    }];
}

export { uidOf };
