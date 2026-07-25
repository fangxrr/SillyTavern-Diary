/**
 * 存储层
 *
 * 两处存储：
 *   chat_metadata.diary        —— 本对话的日记 / 收藏 / 标记 / 进度（跟着聊天文件走）
 *   extension_settings.diary   —— 全局设置（API、提示词等）
 *
 * 定位一律用 message.extra.diary_uid，不用楼层号。
 * 楼层号会因为删楼、插楼、换分支而错位，uid 不会。
 */

import { getContext, extension_settings } from '../../../extensions.js';

export const MODULE = 'diary';

/* ────────── uid ────────── */

export function newId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 给消息打上 uid（幂等）。返回 uid。 */
export function uidOf(msg) {
    if (!msg) return null;
    if (!msg.extra) msg.extra = {};
    if (!msg.extra.diary_uid) msg.extra.diary_uid = newId();
    return msg.extra.diary_uid;
}

/** uid → 当前楼层号；找不到返回 -1（源楼层已删） */
export function indexOfUid(uid) {
    if (!uid) return -1;
    const chat = getContext().chat || [];
    return chat.findIndex(m => m?.extra?.diary_uid === uid);
}

/** 给整个聊天补齐 uid。切换聊天时跑一次。 */
export function backfillUids() {
    const chat = getContext().chat || [];
    let touched = 0;
    for (const m of chat) {
        if (!m.extra?.diary_uid) { uidOf(m); touched++; }
    }
    return touched;
}

/* ────────── 本对话数据 ────────── */

function blank() {
    return {
        version: 1,
        startDate: '',     // 故事起始日 YYYY-MM-DD
        entries: [],       // 日记
        favorites: [],     // 收藏
        marks: {},         // { 'YYYY-MM-DD': '情人节' }
        dateIndex: {},     // { uid: 'YYYY-MM-DD' } 已检测出的楼层日期
        cursor: null,      // 已处理到哪条消息的 uid
        sinceCount: 0,     // 距上次写日记累计了几层
        logs: [],          // 运行日志，只留最近若干条
    };
}

const LOG_KEEP = 12;

/** 记一条运行日志。出问题时靠它复盘。 */
export function addLog(rec) {
    const d = data();
    if (!Array.isArray(d.logs)) d.logs = [];
    d.logs.unshift({ at: Date.now(), ...rec });
    if (d.logs.length > LOG_KEEP) d.logs.length = LOG_KEEP;
    save();
    console.log('[日记本]', rec.kind, rec);
}

export function clearLogs() {
    data().logs = [];
    save();
}

export function data() {
    const meta = getContext().chatMetadata;
    if (!meta) return blank();
    if (!meta[MODULE]) meta[MODULE] = blank();
    // 老数据补字段
    const d = meta[MODULE];
    const b = blank();
    for (const k of Object.keys(b)) if (d[k] === undefined) d[k] = b[k];
    return d;
}

export function save() {
    const ctx = getContext();
    if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
}

/** 连消息体一起存盘（改动了 message.extra 时必须调） */
export async function saveChatFile() {
    const ctx = getContext();
    if (typeof ctx.saveChat === 'function') await ctx.saveChat();
}

/* ────────── 日记 ────────── */

export function addEntry(entry) {
    const d = data();
    d.entries.push({
        id: newId(),
        date: '',
        title: '',
        text: '',
        source: 'auto',      // auto | manual
        startUid: null,
        endUid: null,
        spanFrom: '',        // 跨天时的起始日
        pinned: false,
        createdAt: Date.now(),
        ...entry,
    });
    save();
    return d.entries.at(-1);
}

export function updateEntry(id, patch) {
    const e = data().entries.find(x => x.id === id);
    if (e) { Object.assign(e, patch); save(); }
    return e;
}

export function removeEntry(id) {
    const d = data();
    const i = d.entries.findIndex(x => x.id === id);
    if (i >= 0) { d.entries.splice(i, 1); save(); }
}

/** 置顶在前，其余按日期倒序 */
export function sortedEntries() {
    return [...data().entries].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return String(b.date).localeCompare(String(a.date));
    });
}

export function entryOnDate(date) {
    return data().entries.filter(e => e.date === date);
}

/* ────────── 收藏 ────────── */

export function isFav(uid) {
    return data().favorites.some(f => f.uid === uid);
}

export function toggleFav(msg) {
    const d = data();
    const uid = uidOf(msg);
    const i = d.favorites.findIndex(f => f.uid === uid);
    if (i >= 0) {
        d.favorites.splice(i, 1);
        save();
        return false;
    }
    d.favorites.push({
        id: newId(),
        uid,
        name: '',                                   // 用户自命名
        snapshot: String(msg.mes || '').slice(0, 4000), // 原文快照，源楼层删了也还在
        speaker: msg.name || '',
        isUser: !!msg.is_user,
        date: d.dateIndex[uid] || '',
        createdAt: Date.now(),
    });
    save();
    return true;
}

export function updateFav(id, patch) {
    const f = data().favorites.find(x => x.id === id);
    if (f) { Object.assign(f, patch); save(); }
    return f;
}

export function removeFav(id) {
    const d = data();
    const i = d.favorites.findIndex(x => x.id === id);
    if (i >= 0) { d.favorites.splice(i, 1); save(); }
}

/* ────────── 日期标记 ────────── */

export function setMark(date, label) {
    const d = data();
    if (label) d.marks[date] = label; else delete d.marks[date];
    save();
}

/* ────────── 全局设置 ────────── */

const DEFAULT_TIME_PROMPT =
`你是一个时间标注器。下面是按顺序编号的若干条内容，来自一段角色扮演。
判断每条发生在故事里的哪一天。

规则：
- 只输出 JSON，不要任何解释、前言或代码块标记
- 日期格式 YYYY-MM-DD
- 一条内若横跨多天，date 填最后一天，并填 from 为起始那天
- 完全看不出日期的，沿用上一条的日期
- 已知故事起始日：{{start}}

格式：
{"items":[{"i":0,"date":"YYYY-MM-DD","from":""},{"i":1,"date":"YYYY-MM-DD","from":"YYYY-MM-DD"}]}

内容：
{{content}}`;

const DEFAULT_WRITE_PROMPT =
`你是 {{char}}。为今天（{{date}}）写一篇私人日记。

这是你自己的本子，没有人会读。所以：
- 第一人称，用你平时说话的语气，不要文绉绉
- 写你在意的那一两件事，不要复述流水账
- 可以有没说出口的话、偏见、说谎、自我辩解
- 不要提到"用户"或任何系统性的东西
- 200 到 400 字

先用一行写一个标题，格式为「标题：xxx」，然后空一行再写正文。

今天发生的事：
{{content}}`;

function defaultSettings() {
    return {
        auto: true,
        trigger: { newDay: true, everyN: true, n: 10 },
        includeGreeting: true,
        waitNext: true,
        clean: true,
        contentRegex: '',
        timeRegex: '',
        startYearFallback: new Date().getFullYear(),

        apiTime: {
            mode: 'standalone',  // standalone | tavern
            url: '', key: '', model: '', profile: '',
            temp: 0.2, max: 800,
        },
        apiWrite: {
            mode: 'standalone',
            url: '', key: '', model: '', profile: '',
            temp: 0.9, max: 1200,
        },

        world: { enabled: true, books: [], constantOnly: true, budget: 2000 },
        memory: { enabled: false, book: '', recent: 8, budget: 1200 },

        timePrompt: DEFAULT_TIME_PROMPT,
        writePrompt: DEFAULT_WRITE_PROMPT,
    };
}

export function settings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = defaultSettings();
    const s = extension_settings[MODULE];
    const d = defaultSettings();
    // 深补一层
    for (const k of Object.keys(d)) {
        if (s[k] === undefined) s[k] = d[k];
        else if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) {
            for (const k2 of Object.keys(d[k])) if (s[k][k2] === undefined) s[k][k2] = d[k][k2];
        }
    }
    return s;
}

export function saveSettings() {
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
}

export { DEFAULT_TIME_PROMPT, DEFAULT_WRITE_PROMPT };
