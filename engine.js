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
    try {
        const out = await api.chat(s.apiTime, ctxLib.buildStartPrompt(first));
        const date = normDate(api.parseJson(out)?.date);
        if (date) { d.startDate = date; store.save(); emit('meta'); return date; }
    } catch (e) {
        console.warn('[日记本] 起始日没读出来：', e.message);
    }
    return d.startDate;
}

function normDate(v) {
    const m = String(v || '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
    if (!m) return '';
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

/* ────────── 日期检测 ────────── */

/**
 * 给一批消息标日期。
 * 返回 [{ msg, uid, date, from }]，from 非空表示这条横跨多天。
 */
export async function tagDates(messages) {
    if (!messages.length) return [];
    const s = store.settings();
    const d = store.data();

    // 已经标过的直接用缓存
    const unknown = messages.filter(m => !d.dateIndex[store.uidOf(m)]);
    if (unknown.length) {
        try {
            const out = await api.chat(s.apiTime, ctxLib.buildTimePrompt(unknown));
            const items = api.parseJson(out)?.items || [];
            for (const it of items) {
                const m = unknown[Number(it.i)];
                if (!m) continue;
                const date = normDate(it.date);
                if (!date) continue;
                const uid = store.uidOf(m);
                d.dateIndex[uid] = date;
                if (normDate(it.from)) d.dateIndex[uid + ':from'] = normDate(it.from);
            }
            store.save();
        } catch (e) {
            console.warn('[日记本] 日期没读出来：', e.message);
        }
    }

    // 没标到的沿用上一条
    let last = d.startDate || '';
    return messages.map(m => {
        const uid = store.uidOf(m);
        const date = d.dateIndex[uid] || last;
        if (date) last = date;
        return { msg: m, uid, date, from: d.dateIndex[uid + ':from'] || '' };
    });
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

    let title = '', text = raw.trim();
    const m = text.match(/^\s*(?:标题|title)\s*[:：]\s*(.+)\s*\n+/i);
    if (m) { title = m[1].trim(); text = text.slice(m[0].length).trim(); }
    if (!title) title = text.split('\n')[0].slice(0, 24);

    const entry = store.addEntry({
        date, title, text, source, spanFrom,
        startUid: store.uidOf(messages[0]),
        endUid: store.uidOf(messages.at(-1)),
    });
    emit('entry');
    return entry;
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
            // 这天已经写过就并进去，不重复开一篇
            const exist = store.entryOnDate(g.date).find(e => e.source === 'auto');
            if (exist) {
                store.updateEntry(exist.id, { endUid: g.items.at(-1).uid });
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
        let title = '', text = raw.trim();
        const m = text.match(/^\s*(?:标题|title)\s*[:：]\s*(.+)\s*\n+/i);
        if (m) { title = m[1].trim(); text = text.slice(m[0].length).trim(); }
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
