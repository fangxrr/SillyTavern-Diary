/**
 * 上下文层
 * 负责把「一堆聊天记录」变成「干净的、模型能读的正文」。
 */

import { getContext } from '../../../extensions.js';
import { settings, data, uidOf, charRules } from './store.js';

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

    // 第一层：正则圈定范围（用这张卡自己的规则）
    const pattern = charRules().contentRegex;
    if (pattern?.trim()) {
        const hits = runRegex(pattern, text);
        if (hits.length) text = hits.join('\n\n');
    }

    // 第二层：把圈定范围内残留的噪音再剥一遍
    // （draft、检查记录这类东西常常就藏在 <content> 里面）
    if (!s.clean) return tidy(text);
    return tidy(scrub(text));
}

/** 跑一条正则，把所有捕获结果收集起来 */
function runRegex(pattern, text) {
    try {
        const re = new RegExp(pattern, 'gi');
        const hits = [];
        let m;
        while ((m = re.exec(text)) !== null) {
            hits.push(m[1] ?? m[0]);
            if (m.index === re.lastIndex) re.lastIndex++;
        }
        return hits;
    } catch {
        return [];   // 正则写错了，当作没填
    }
}

/** 剥掉各种非正文内容 */
function scrub(text) {
    // HTML 注释 —— draft、修改记录、自检清单常藏在这里
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    // 标签块
    for (const tag of NOISE_TAGS) {
        text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
        text = text.replace(new RegExp(`<${tag}[^>]*\\/?>`, 'gi'), '');
    }
    // markdown 代码块（状态栏常这么写）
    text = text.replace(/```[\s\S]*?```/g, '');
    // <details> 折叠块
    text = text.replace(/<details[\s\S]*?<\/details>/gi, '');
    // 表格行
    text = text.replace(/^\s*\|.*\|\s*$/gm, '');
    // 剩余 HTML 标签，保留文字
    text = text.replace(/<\/?[a-z][^>]*>/gi, '');
    return text;
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

/**
 * 拿一条真实消息试跑正文规则，让用户看清到底读到了什么。
 * 返回 { mode, text, raw }：mode 说明这次是正则命中还是退回了默认清洗。
 */
export function previewExtract(msg) {
    const s = settings();
    const raw = String(msg?.mes || '');
    const pattern = charRules().contentRegex?.trim();
    const final = cleanText(msg);

    if (pattern) {
        try { new RegExp(pattern); }
        catch (e) { return { mode: 'bad', text: final, raw, error: e.message }; }

        const hits = runRegex(pattern, raw);
        if (!hits.length) return { mode: 'miss', text: final, raw };
        return {
            mode: 'regex',
            hits: hits.length,
            afterRegex: hits.join('\n\n').length,
            text: final,
            raw,
        };
    }
    return { mode: 'clean', text: final, raw };
}

/* ────────── 时间片段 ────────── */

/**
 * 用「时间在哪」那条正则，从消息里只抠出时间那一小段。
 * 抠到了就不用把整段正文喂给模型，省一大笔 token。
 */
export function extractTime(msg) {
    let pattern = charRules().timeRegex?.trim();
    if (!pattern) return '';

    // 常见手误：写成 <Ti></Ti> 这种没有捕获组的形式，
    // 只会匹配紧挨着的空标签，永远抠不到东西。自动补上捕获组。
    const empty = pattern.match(/^(<(\w+)[^>]*>)\s*(<\/\2>)$/i);
    if (empty) pattern = `${empty[1]}([\\s\\S]*?)${empty[3]}`;

    try {
        const re = new RegExp(pattern, 'gi');
        const text = String(msg?.mes || '');
        let last = null, m;
        // 取最后一个匹配：一条消息里可能有回忆段落也带时间标签，
        // 场景是往前推进的，最后那个才是当前时间。
        while ((m = re.exec(text)) !== null) {
            last = m;
            if (m.index === re.lastIndex) re.lastIndex++;
        }
        if (!last) return '';
        return String(last[1] ?? last[0]).replace(/<[^>]*>/g, '').trim();
    } catch {
        return '';   // 正则写错了，当作没填
    }
}

/** 让模型看一条消息的原文，猜出时间标签在哪 */
export function buildRegexProbePrompt(msg) {
    return [{
        role: 'user',
        content:
`下面是一条角色扮演回复的原文。里面可能有专门存放"故事内时间"的标签或字段。

找出它，给我一个 JavaScript 正则，用一个捕获组抓出时间文本本身。
只输出 JSON，不要解释、不要代码块标记：
{"regex":"<Ti>([^<]*)</Ti>","sample":"抓到的内容"}

注意：
- 正则写成字符串，反斜杠要写成两个（例如 \\\\d）
- 只要时间，不要地点、天气、场景标题
- 找不到就回 {"regex":"","sample":""}

原文：
${String(msg?.mes || '').slice(0, 3000)}`,
    }];
}

/** 让模型看一条消息的原文，找出真正的故事正文在哪 */
export function buildContentProbePrompt(msg) {
    const raw = String(msg?.mes || '');
    // 正文边界通常在开头附近，但结尾的特征也要看到，所以掐头留尾
    const shown = raw.length > 6000
        ? raw.slice(0, 4200) + '\n\n……（中间省略）……\n\n' + raw.slice(-1600)
        : raw;

    return [{
        role: 'user',
        content:
`下面是一条角色扮演回复的原文。它前面往往有思考过程、步骤分析、状态栏、场景信息，
后面才是真正的故事正文（角色的对话和场景描写）。

找出真正的故事正文，给我一个 JavaScript 正则，用一个捕获组抓出它。
只输出 JSON，不要解释、不要代码块标记：
{"regex":"...","note":"一句话说明正文的位置特征","sample":"抓到的前 40 字"}

常见情况参考：
- 正文被标签包住 → "<content>([\\\\s\\\\S]*?)</content>"
- 正文在最后一个步骤标题之后 → "#\\\\s*Step\\\\s*\\\\d[^\\\\n]*\\\\n([\\\\s\\\\S]*)$"
- 正文在某个分隔线之后 → "---\\\\s*\\\\n([\\\\s\\\\S]*)$"

注意：
- 正则写成字符串，反斜杠要写成两个（例如 \\\\s）
- 捕获组只要故事正文，不要思考、步骤、状态栏、场景标题
- 实在找不到清晰边界就回 {"regex":"","note":"原因"}

原文：
${shown}`,
    }];
}

/* ────────── 提示词组装 ────────── */

export async function buildWritePrompt(date, messages) {
    const s = settings();
    const ctx = getContext();
    const world = await readWorld();
    const memory = await readMemory();

    // 很多卡的角色回复里已经复述了 user 那一轮的内容，
    // 两边都喂等于同一件事说两遍。留一手：滤空了就退回全部。
    let feed = messages;
    if (s.onlyCharContent) {
        const onlyChar = messages.filter(m => !m.is_user);
        if (onlyChar.length) feed = onlyChar;
    }

    let body = s.writePrompt
        .replaceAll('{{char}}', ctx.name2 || '角色')
        .replaceAll('{{user}}', ctx.name1 || '用户')
        .replaceAll('{{date}}', date || '今天')
        .replaceAll('{{content}}', plain(feed))
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

export function buildTimePrompt(messages, fragments = null) {
    const s = settings();
    const d = data();
    // fragments 非空 = 已用正则抠出时间字段，只喂这些，不喂全文。
    // 这里自动加一行说明来源，免得提示词里说"正文"而模型收到的是碎片。
    const content = fragments
        ? '（以下每行是从一条消息里抠出的时间字段，不是完整正文）\n'
          + fragments.map((f, i) => `[${i}] ${f || '（这条没抓到）'}`).join('\n')
        : numbered(messages);
    const body = s.timePrompt
        .replaceAll('{{start}}', d.startDate || `${s.startYearFallback}-01-01`)
        .replaceAll('{{content}}', content);
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
