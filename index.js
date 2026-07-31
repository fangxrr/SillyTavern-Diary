/**
 * 日记本 —— SillyTavern 扩展
 *
 * 入口：挂事件、装魔棒按钮。
 * 真正的逻辑在 engine.js，界面在 ui.js。
 */

import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import * as store from './store.js';
import * as engine from './engine.js';
import * as ui from './ui.js';

const NAME = '日记本';

let deco = null;
function scheduleDecorate() {
    clearTimeout(deco);
    deco = setTimeout(() => ui.decorateMessages(), 120);
}

let ticking = null;
function scheduleTick() {
    clearTimeout(ticking);
    ticking = setTimeout(() => engine.tick().catch(e => console.error(`[${NAME}]`, e)), 800);
}

async function onChatChanged() {
    const touched = store.backfillUids();
    if (touched) await store.saveChatFile();
    scheduleDecorate();
    ui.refresh();
}

function boot() {
    ui.addWandButton();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // 渲染完补收藏按钮
    for (const ev of [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
    ]) {
        if (ev) eventSource.on(ev, scheduleDecorate);
    }

    // 触发时机
    // waitNext 开着：等用户发出下一条，说明上一条定稿了
    // waitNext 关掉：角色一回完就处理
    eventSource.on(event_types.MESSAGE_SENT, () => {
        store.uidOf(getContext().chat?.at(-1));
        if (store.settings().waitNext) scheduleTick();
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        store.uidOf(getContext().chat?.at(-1));
        if (!store.settings().waitNext) scheduleTick();
    });

    // 引擎有动静就刷新界面；写歪了要出声，不能闷着
    engine.onChange((ev, payload) => {
        if (ev === 'warn') ui.notify(String(payload), true);
        if (ev === 'error') ui.notify(payload?.message || '写日记失败', true);
        ui.refresh();
    });

    // 兜底：魔棒菜单可能比扩展晚建好
    const retry = setInterval(() => {
        ui.addWandButton();
        if (document.getElementById('dy-wand')) clearInterval(retry);
    }, 1000);
    setTimeout(() => clearInterval(retry), 15000);

    console.log(`[${NAME}] 装好了`);
}

jQuery(async () => {
    try {
        store.settings();
        boot();
        await onChatChanged();
    } catch (e) {
        console.error(`[${NAME}] 启动失败：`, e);
    }
});
