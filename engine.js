/**
 * 引擎层
 * 决定什么时候写、写哪几层、记在哪天。
 */

import { getContext } from '../../../extensions.js';
import * as store from './store.js';
import * as api from './api.js';
import * as ctxLib from './context.js';

let running = false;
const listeners = new Set();

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch { /* UI 挂了不影响引擎 */ } } }

export function isRunning() { return running; }

/* ────────── 待处理区间 ────────── */

/**
 * 找出还没写进日记的消息。
 * 用 uid 定位进度，所以你删掉前面的楼层不会影响判断。
 */
export function pending() {
    const s = store.settings();
    const d = store.data();
    const chat = getContext().chat || [];
    if (!chat.length) return [];

    // 已写过的日记里，最靠后的那条源楼层
    const written = d.entries
        .map(e => store.indexOfUid(e.endUid))
        .filter(i => i >= 0);
    const writtenTo = written.length ? Math.max(...written) : -1;

    let start = 0;
    if (d.cursor) {
        const i = store.indexOfUid(d.cursor);
        // 指针那条被删了就退回已写到的位置，不会从头重写一遍
        start = i >= 0 ? i + 1 : writtenTo + 1;
    } else if (writtenTo >= 0) {
        start = writtenTo + 1;
    }

    let slice = chat.slice(start);

    // 第一篇要不要含开场白
    if (start === 0 && !s.includeGreeting && slice.length) slice = slice.slice(1);

    // 等下一条消息再动笔：末尾若是角色回复，先按住不处理
    if (s.waitNext) {
        while (slice.length && !slice.at(-1).is_user) slice = slice.slice(0, -1);
    }

    return slice.filter(ctxLib.worthReading);
}

/* ────────── 起始日 ────────── */

export async function detectStartDate(force = false) {
    const d = store.data();
    if (d.startDate && !force) return d.startDate;

    const chat = getContext().chat || [];
    // 开场白之后的第一条角色回复；找不到就退回开场白
    const first = chat.find((m, i) => i > 0 && !m.is_user && ctxLib.worthReading(m))
        || chat.find(m => ctxLib.worthReading(m));
    if (!first) return '';

    const s = store.settings();

    // 先试正则 + 本地解析，能白嫖就不花钱
    const frag = ctxLib.extractTime(first);
    if (frag) {
        const local = parseLocalDate(frag, s.startYearFallback);
        if (local) { d.startDate = local; store.save(); emit('meta'); return local; }
    }

    try {
        const out = await api.chat(s.apiTime, ctxLib.buildStartPrompt(first));
        const date = normDate(api.parseJson(out)?.date);
        if (date) { d.startDate = date; store.save(); emit('meta'); return date; }
    } catch (e) {
        console.warn('[日记本] 起始日没读出来：', e.message);
    }
    return d.startDate;
}

const pad = n => String(n).padStart(2, '0');

function normDate(v) {
    const m = String(v || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
    if (!m) return '';
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
}

const EN_MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * 本地解析日期，不花钱。认得这些写法：
 *   2007年3月15日 / 2007-03-15 / 2007/3/15 / 2007.3.15
 *   3月15日（缺年份就补上故事的年份）
 *   March 15, 2007 / 15 Mar 2007
 */
function parseLocalDate(text, year) {
    const t = String(text || '');

    let m = t.match(/(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;

    m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (m) return `${year}-${pad(m[1])}-${pad(m[2])}`;

    m = t.match(/([a-z]{3,9})\.?\s+(\d{1,2})(?:\s*,)?\s*(\d{4})?/i);
    if (m) {
        const mi = EN_MONTH.indexOf(m[1].slice(0, 3).toLowerCase());
        if (mi >= 0) return `${m[3] || year}-${pad(mi + 1)}-${pad(m[2])}`;
    }
    m = t.match(/(\d{1,2})\s+([a-z]{3,9})\.?\s*(\d{4})?/i);
    if (m) {
        const mi = EN_MONTH.indexOf(m[2].slice(0, 3).toLowerCase());
        if (mi >= 0) return `${m[3] || year}-${pad(mi + 1)}-${pad(m[1])}`;
    }
    return '';
}

/* ────────── 日期检测 ────────── */

/**
 * 给一批消息标日期，返回 [{ msg, uid, date, from }]。
 *
 * 三级策略，能省则省：
 *   1. 缓存里有 → 不动
 *   2. 「时间在哪」正则抠得出、本地解析得出 → 零成本
 *   3. 还是不行 → 问模型。有片段就只喂片段，没有才喂全文。
 */
export async function tagDates(messages) {
    if (!messages.length) return [];
    const s = store.settings();
    const d = store.data();
    const year = (d.startDate || '').slice(0, 4) || s.startYearFallback;

    const ask = [];       // 需要问模型的消息
    const frags = [];     // 与 ask 一一对应的时间片段（可能为空串）
    let allHaveFrag = true;

    for (const m of messages) {
        const uid = store.uidOf(m);
        if (d.dateIndex[uid]) continue;

        const frag = ctxLib.extractTime(m);
        if (frag) {
            const local = parseLocalDate(frag, year);
            if (local) { d.dateIndex[uid] = local; continue; }  // 白嫖成功
        } else {
            allHaveFrag = false;
        }
        ask.push(m);
        frags.push(frag);
    }

    if (ask.length) {
        try {
            const prompt = ctxLib.buildTimePrompt(ask, allHaveFrag ? frags : null);
            const out = await api.chat(s.apiTime, prompt);
            for (const it of (api.parseJson(out)?.items || [])) {
                const m = ask[Number(it.i)];
                if (!m) continue;
                const date = normDate(it.date);
                if (!date) continue;
                const uid = store.uidOf(m);
                d.dateIndex[uid] = date;
                if (normDate(it.from)) d.dateIndex[uid + ':from'] = normDate(it.from);
            }
        } catch (e) {
            console.warn('[日记本] 日期没读出来：', e.message);
        }
    }
    store.save();

    // 没标到的沿用上一条
    let last = d.startDate || '';
    return messages.map(m => {
        const uid = store.uidOf(m);
        const date = d.dateIndex[uid] || last;
        if (date) last = date;
        return { msg: m, uid, date, from: d.dateIndex[uid + ':from'] || '' };
    });
}

/**
 * 读一条角色消息，猜出正文在哪，返回正则建议。
 * 会先验一遍这条正则是否真的抓得到东西，抓不到就不给。
 */
export async function probeContentRegex() {
    const msg = lastCharMessage();
    if (!msg) throw new Error('聊天里还没有角色回复');

    const s = store.settings();
    const out = await api.chat(s.apiWrite, ctxLib.buildContentProbePrompt(msg));
    const r = api.parseJson(out);
    if (!r?.regex) throw new Error(r?.note || '没找到清晰的正文边界，得手动填');

    let re;
    try { re = new RegExp(r.regex, 'i'); } catch { throw new Error('模型给的正则不合法，手动填吧'); }

    const hit = re.exec(String(msg.mes || ''));
    if (!hit) throw new Error('模型给的正则匹配不到，手动填吧');

    const got = String(hit[1] ?? hit[0]);
    if (got.length < 40) throw new Error('这条正则只抓到一点点，不像正文，手动填吧');

    return { regex: r.regex, note: r.note || '', sample: got.slice(0, 40) };
}

/** 最后一条有内容的角色消息 */
function lastCharMessage() {
    const chat = getContext().chat || [];
    return [...chat].reverse().find(m => !m.is_user && String(m.mes || '').trim()) || null;
}

/**
 * 读一条角色消息，猜出时间标签在哪，返回正则建议。
 * 只给建议，填不填由用户决定。
 */
export async function probeTimeRegex() {
    const chat = getContext().chat || [];
    const first = chat.find((m, i) => i > 0 && !m.is_user && String(m.mes || '').trim())
        || chat.find(m => String(m.mes || '').trim());
    if (!first) throw new Error('聊天里还没有角色回复');

    const s = store.settings();
    const out = await api.chat(s.apiTime, ctxLib.buildRegexProbePrompt(first));
    const r = api.parseJson(out);
    if (!r?.regex) throw new Error('没找到专门放时间的标签，手动填一个吧');

    // 验一下这条正则真的能用
    try { new RegExp(r.regex); } catch { throw new Error('模型给的正则不合法，手动填吧'); }
    return { regex: r.regex, sample: r.sample || '' };
}

/* ────────── 分组 ────────── */

/** 按日期归并。跨多天的整段记在最后一天。 */
function groupByDate(tagged) {
    const groups = [];
    for (const t of tagged) {
        const g = groups.find(x => x.date === t.date);
        if (g) {
            g.items.push(t);
            if (t.from && (!g.spanFrom || t.from < g.spanFrom)) g.spanFrom = t.from;
        } else {
            groups.push({ date: t.date, items: [t], spanFrom: t.from || '' });
        }
    }
    return groups;
}

/* ────────── 写一篇 ────────── */

export async function write({ messages, date, spanFrom = '', source = 'auto' }) {
    const s = store.settings();
    const prompt = await ctxLib.buildWritePrompt(date, messages);
    const raw = await api.chat(s.apiWrite, prompt);
    const { title, text } = splitTitle(raw);

    const entry = store.addEntry({
        date, title, text, source, spanFrom,
        startUid: store.uidOf(messages[0]),
        endUid: store.uidOf(messages.at(-1)),
    });
    emit('entry');
    return entry;
}

/**
 * 这一天已有日记，又来了新楼层：从这篇日记的起点一路读到新的终点，
 * 拿一整天的内容重写，保证日记覆盖当天全部。
 */
async function extendEntry(entry, group) {
    const chat = getContext().chat || [];
    const endUid = group.items.at(-1).uid;
    let a = store.indexOfUid(entry.startUid);
    const b = store.indexOfUid(endUid);

    // 起点没了（源楼层被删）就退回这一组的开头
    if (a < 0) a = store.indexOfUid(group.items[0].uid);
    if (a < 0 || b < a) {
        store.updateEntry(entry.id, { endUid });
        return;
    }

    const full = chat.slice(a, b + 1).filter(ctxLib.worthReading);
    if (!full.length) return;

    const s = store.settings();
    const raw = await api.chat(s.apiWrite, await ctxLib.buildWritePrompt(entry.date, full));
    const { title, text } = splitTitle(raw);
    store.updateEntry(entry.id, {
        title: title || entry.title,
        text,
        endUid,
        spanFrom: group.spanFrom || entry.spanFrom,
    });
    emit('entry');
}

/** 把「标题：xxx」从正文里拆出来 */
function splitTitle(raw) {
    let title = '', text = String(raw).trim();
    const m = text.match(/^\s*(?:标题|title)\s*[:：]\s*(.+)\s*\n+/i);
    if (m) { title = m[1].trim(); text = text.slice(m[0].length).trim(); }
    if (!title) title = text.split('\n')[0].slice(0, 24);
    return { title, text };
}

/** 某篇日记当前覆盖了哪些楼层，给界面显示用 */
export function coverageOf(entry) {
    const a = store.indexOfUid(entry.startUid);
    const b = store.indexOfUid(entry.endUid);
    if (a < 0 || b < a) return null;
    return { from: a, to: b, count: b - a + 1 };
}

/* ────────── 自动跑一轮 ────────── */

export async function tick() {
    const s = store.settings();
    if (!s.auto || running) return;

    const msgs = pending();
    if (!msgs.length) return;

    const d = store.data();
    const needN = s.trigger.everyN && msgs.length >= Math.max(1, Number(s.trigger.n) || 10);
    if (!s.trigger.newDay && !needN) return;

    running = true;
    emit('busy');
    try {
        if (!d.startDate) await detectStartDate();

        const tagged = await tagDates(msgs);
        const groups = groupByDate(tagged);
        if (!groups.length) return;

        // 翻到新一天：最后一组还没结束，先不写；前面的都封档
        // 满 N 层：连最后一组一起写
        const closed = needN ? groups : groups.slice(0, -1);
        if (!closed.length) return;

        for (const g of closed) {
            if (!g.date) continue;
            const exist = store.entryOnDate(g.date).find(e => e.source === 'auto');
            if (exist) {
                // 这天已经写过了。把新楼层并进来，重读这一天的全部内容重写，
                // 否则日记会停在先前那几层，后面发生的事进不去。
                await extendEntry(exist, g);
                continue;
            }
            await write({
                messages: g.items.map(t => t.msg),
                date: g.date,
                spanFrom: g.spanFrom,
                source: 'auto',
            });
        }

        d.cursor = closed.at(-1).items.at(-1).uid;
        store.save();
        await store.saveChatFile();
    } catch (e) {
        console.error('[日记本] 写日记失败：', e);
        emit('error', e);
    } finally {
        running = false;
        emit('idle');
    }
}

/* ────────── 手动补写 ────────── */

/** 按楼层号区间补写。楼层号是当下看到的号，内部立刻转成 uid。 */
export async function writeRange(fromIdx, toIdx, dateHint = '') {
    const chat = getContext().chat || [];
    const a = Math.max(0, Math.min(fromIdx, toIdx));
    const b = Math.min(chat.length - 1, Math.max(fromIdx, toIdx));
    const msgs = chat.slice(a, b + 1).filter(ctxLib.worthReading);
    if (!msgs.length) throw new Error('这个区间里没有可读的正文');

    running = true; emit('busy');
    try {
        let date = normDate(dateHint), spanFrom = '';
        if (!date) {
            const tagged = await tagDates(msgs);
            const groups = groupByDate(tagged);
            const last = groups.at(-1);
            date = last?.date || store.data().startDate || '';
            spanFrom = groups.length > 1 ? (groups[0].date || '') : (last?.spanFrom || '');
        }
        if (!date) throw new Error('判断不出日期，请手填');
        return await write({ messages: msgs, date, spanFrom, source: 'manual' });
    } finally {
        running = false; emit('idle');
    }
}

/** 重写某一篇（源楼层还在才行） */
export async function rewrite(id) {
    const e = store.data().entries.find(x => x.id === id);
    if (!e) return;
    const a = store.indexOfUid(e.startUid), b = store.indexOfUid(e.endUid);
    if (a < 0 || b < 0) throw new Error('这篇的源楼层已经不在了，只能手动编辑');
    const chat = getContext().chat;
    const msgs = chat.slice(a, b + 1).filter(ctxLib.worthReading);

    running = true; emit('busy');
    try {
        const s = store.settings();
        const raw = await api.chat(s.apiWrite, await ctxLib.buildWritePrompt(e.date, msgs));
        const { title, text } = splitTitle(raw);
        store.updateEntry(id, { title: title || e.title, text });
        emit('entry');
    } finally {
        running = false; emit('idle');
    }
}

/** 单独测一层楼的日期，收藏页用 */
export async function dateOfMessage(uid) {
    const d = store.data();
    if (d.dateIndex[uid]) return d.dateIndex[uid];
    const i = store.indexOfUid(uid);
    if (i < 0) return '';
    const msg = getContext().chat[i];
    await tagDates([msg]);
    return d.dateIndex[uid] || '';
}

export { normDate };
