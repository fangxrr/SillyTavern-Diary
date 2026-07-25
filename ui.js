/**
 * 界面层
 */

import { getContext } from '../../../extensions.js';
import * as store from './store.js';
import * as api from './api.js';
import * as ctxLib from './context.js';
import * as engine from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let root = null;
let calCursor = null;   // 日历当前月 { y, m }

function toast(msg, bad = false) {
    if (typeof toastr !== 'undefined') bad ? toastr.error(msg) : toastr.success(msg);
    else console.log('[日记本]', msg);
}

/* ══════════════ 魔棒入口 ══════════════ */

export function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('dy-wand')) return;
    const el = document.createElement('div');
    el.id = 'dy-wand';
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.tabIndex = 0;
    el.innerHTML = `<i class="fa-solid fa-book"></i><span>日记本</span>`;
    el.addEventListener('click', () => open('cover'));
    menu.appendChild(el);
}

/* ══════════════ 楼层收藏按钮 ══════════════ */

export function decorateMessages() {
    document.querySelectorAll('#chat .mes').forEach(node => {
        const holder = node.querySelector('.mes_buttons');
        if (!holder || holder.querySelector('.dy-star')) return;

        const idx = Number(node.getAttribute('mesid'));
        const msg = getContext().chat?.[idx];
        if (!msg) return;

        const uid = store.uidOf(msg);
        const btn = document.createElement('div');
        btn.className = 'dy-star mes_button fa-solid fa-bookmark interactable';
        btn.title = '收藏这层';
        if (store.isFav(uid)) btn.classList.add('dy-star--on');
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            const on = store.toggleFav(msg);
            btn.classList.toggle('dy-star--on', on);
            await store.saveChatFile();
            toast(on ? '收进收藏夹了' : '已取消收藏');
            if (root) refresh();
        });
        holder.prepend(btn);
    });
}

/* ══════════════ 打开 / 关闭 ══════════════ */

export function open(page = 'cover') {
    if (!root) build();
    root.classList.add('dy-on');
    document.body.classList.add('dy-lock');
    go(page);
}

export function close() {
    root?.classList.remove('dy-on');
    document.body.classList.remove('dy-lock');
}

function build() {
    root = document.createElement('div');
    root.id = 'dy-root';
    root.innerHTML = `
      <div class="dy-scrim"></div>
      <div class="dy-stage">
        <div class="dy-book">
          <button class="dy-x" title="关闭日记本">×</button>
          <div class="dy-cover"></div>
          <div class="dy-marks"></div>
          <div class="dy-inner">
            <div class="dy-top">
              <button class="dy-close">← 合上</button>
              <div class="dy-top__t"></div>
              <div class="dy-top__m"></div>
            </div>
            <div class="dy-pane"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector('.dy-scrim').addEventListener('click', close);
    root.querySelector('.dy-x').addEventListener('click', close);
    root.querySelector('.dy-close').addEventListener('click', () => go('cover'));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && root?.classList.contains('dy-on')) close();
    });
}

function go(page) {
    const book = root.querySelector('.dy-book');
    if (page === 'cover') {
        book.removeAttribute('data-open');
        renderCover();
        return;
    }
    book.setAttribute('data-open', '');
    const ctx = getContext();
    root.querySelector('.dy-top__t').textContent = ctx.name2 || '日记本';
    const d = store.data();
    root.querySelector('.dy-top__m').textContent =
        `${d.startDate ? d.startDate.slice(0, 4) + ' 年 · ' : ''}第 ${(ctx.chat?.length || 1) - 1} 层`;
    const pane = root.querySelector('.dy-pane');
    pane.scrollTop = 0;
    if (page === 'diary') renderDiary(pane);
    else if (page === 'fav') renderFav(pane);
    else renderSettings(pane);
}

function refresh() {
    if (!root?.classList.contains('dy-on')) return;
    const book = root.querySelector('.dy-book');
    if (!book.hasAttribute('data-open')) renderCover();
    else {
        const cur = root.querySelector('.dy-pane').dataset.page || 'diary';
        go(cur);
    }
}

/* ══════════════ 封面 ══════════════ */

function renderCover() {
    const ctx = getContext();
    const d = store.data();
    root.querySelector('.dy-cover').innerHTML = `
      <div class="dy-cover__eyebrow">P R I V A T E</div>
      <div class="dy-cover__mid">
        <div class="dy-cover__title">日记</div>
        <div class="dy-cover__rule"></div>
        <div class="dy-cover__who">
          <b>${esc(ctx.name2 || '未选择角色')}</b>
          <span>${esc(ctx.chatName || ctx.getCurrentChatId?.() || '')}</span>
        </div>
      </div>
      <div class="dy-cover__foot">
        <div class="dy-cover__stat">
          已写 <b>${d.entries.length}</b> 篇 · 收藏 <b>${d.favorites.length}</b> 条
          ${d.startDate ? `<br>${esc(cnDate(d.startDate))} 起` : ''}
        </div>
        <button class="dy-gear" data-go="set" title="设置">⚙</button>
      </div>`;

    root.querySelector('.dy-marks').innerHTML = `
      <button class="dy-mark" data-go="diary">日记 <b>${d.entries.length}</b></button>
      <button class="dy-mark" data-go="fav">收藏 <b>${d.favorites.length}</b></button>`;

    root.querySelectorAll('[data-go]').forEach(b =>
        b.addEventListener('click', () => go(b.dataset.go)));
}

/* ══════════════ 日记 ══════════════ */

function renderDiary(pane) {
    pane.dataset.page = 'diary';
    const entries = store.sortedEntries();
    const pinned = entries.filter(e => e.pinned);
    const rest = entries.filter(e => !e.pinned);

    pane.innerHTML = `
      <div class="dy-bar">
        <div class="dy-seg">
          <button data-view="list" aria-pressed="true">列表</button>
          <button data-view="cal" aria-pressed="false">日历</button>
        </div>
        <button class="dy-btn dy-btn--on dy-push" data-act="sheet">＋ 补写</button>
      </div>
      <div class="dy-sheet"></div>
      <div class="dy-list">
        ${pinned.length ? `<div class="dy-divider">置顶</div>${pinned.map(entryHtml).join('')}` : ''}
        ${rest.length ? `<div class="dy-divider">时间</div>${rest.map(entryHtml).join('')}` : ''}
        ${entries.length ? '' : emptyHtml('还没有日记', '玩下去它会自己动笔，或者点上面的「补写」。')}
      </div>
      <div class="dy-cal" style="display:none"></div>`;

    pane.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
        pane.querySelectorAll('[data-view]').forEach(x => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        const cal = b.dataset.view === 'cal';
        pane.querySelector('.dy-list').style.display = cal ? 'none' : '';
        pane.querySelector('.dy-sheet').style.display = cal ? 'none' : '';
        const box = pane.querySelector('.dy-cal');
        box.style.display = cal ? '' : 'none';
        if (cal) renderCal(box);
    }));

    pane.querySelector('[data-act="sheet"]').addEventListener('click', () => {
        const s = pane.querySelector('.dy-sheet');
        s.hasAttribute('data-on') ? s.removeAttribute('data-on') : openSheet(s);
    });

    bindEntries(pane);
}

function entryHtml(e) {
    const [y, m, dd] = String(e.date || '').split('-');
    const alive = e.startUid ? store.indexOfUid(e.startUid) >= 0 : true;
    const a = store.indexOfUid(e.startUid), b = store.indexOfUid(e.endUid);
    return `
      <div class="dy-entry${e.pinned ? ' dy-entry--pin' : ''}" data-id="${e.id}">
        <div class="dy-entry__head">
          <div class="dy-stamp">
            <div class="dy-stamp__d">${esc(dd || '—')}</div>
            <div class="dy-stamp__m">${monthAbbr(m)}</div>
          </div>
          <div class="dy-entry__main">
            <div class="dy-entry__title">${e.pinned ? '<span class="dy-pin">置顶</span>' : ''}${esc(e.title || '(无标题)')}</div>
            <div class="dy-entry__excerpt">${esc(String(e.text).replace(/\n+/g, ' ').slice(0, 90))}</div>
          </div>
        </div>
        <div class="dy-entry__full">
          <div class="dy-entry__text" data-role="text">${esc(e.text)}</div>
          <div class="dy-entry__foot">
            <span class="dy-tag">${e.source === 'manual' ? '手动' : '自动'}</span>
            ${e.spanFrom ? `<span class="dy-tag dy-tag--w">含 ${esc(e.spanFrom)} 起</span>` : ''}
            ${alive && a >= 0 ? `<span class="dy-tag">第 ${a}–${b} 层</span>`
                              : '<span class="dy-tag dy-tag--x">源楼层已删</span>'}
            <button class="dy-btn dy-btn--xs dy-push" data-e="pin">${e.pinned ? '取消置顶' : '置顶'}</button>
            <button class="dy-btn dy-btn--xs" data-e="edit">编辑</button>
            ${alive ? '<button class="dy-btn dy-btn--xs" data-e="rewrite">重写</button>' : ''}
            <button class="dy-btn dy-btn--xs" data-e="del">删除</button>
          </div>
        </div>
      </div>`;
}

const MONTHS = ['—', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const monthAbbr = m => MONTHS[Number(m)] || '—';

function cnDate(iso) {
    const [y, m, d] = String(iso || '').split('-');
    return y && m && d ? `${y} 年 ${Number(m)} 月 ${Number(d)} 日` : String(iso || '');
}

function bindEntries(scope) {
    scope.querySelectorAll('.dy-entry__head').forEach(h => h.addEventListener('click', () => {
        const e = h.parentElement;
        e.hasAttribute('data-open') ? e.removeAttribute('data-open') : e.setAttribute('data-open', '');
    }));

    scope.querySelectorAll('[data-e]').forEach(btn => btn.addEventListener('click', async ev => {
        ev.stopPropagation();
        const wrap = btn.closest('.dy-entry');
        const id = wrap.dataset.id;
        const act = btn.dataset.e;

        if (act === 'pin') {
            const e = store.data().entries.find(x => x.id === id);
            store.updateEntry(id, { pinned: !e.pinned });
            refresh();
        }
        if (act === 'del') {
            if (!confirm('删掉这篇日记？')) return;
            store.removeEntry(id);
            refresh();
        }
        if (act === 'edit') {
            const box = wrap.querySelector('[data-role="text"]');
            if (box.tagName === 'TEXTAREA') return;
            const ta = document.createElement('textarea');
            ta.className = 'dy-editor';
            ta.value = store.data().entries.find(x => x.id === id)?.text || '';
            ta.dataset.role = 'text';
            box.replaceWith(ta);
            btn.textContent = '保存';
            btn.dataset.e = 'save';
        }
        if (act === 'save') {
            const ta = wrap.querySelector('textarea[data-role="text"]');
            store.updateEntry(id, { text: ta.value });
            await store.saveChatFile();
            toast('存好了');
            refresh();
        }
        if (act === 'rewrite') {
            btn.textContent = '写…'; btn.disabled = true;
            try { await engine.rewrite(id); toast('重写好了'); refresh(); }
            catch (e) { toast(e.message, true); btn.textContent = '重写'; btn.disabled = false; }
        }
    }));
}

/* ────────── 补写 ────────── */

function openSheet(box) {
    const len = (getContext().chat?.length || 1) - 1;
    box.setAttribute('data-on', '');
    box.innerHTML = `
      <div class="dy-sheet__h">补 写 一 篇</div>
      <div class="dy-field"><span>范围</span>
        <input type="number" data-f="a" value="${Math.max(0, len - 9)}" style="width:66px"> 到
        <input type="number" data-f="b" value="${len}" style="width:66px">
      </div>
      <div class="dy-field"><span>记在</span>
        <input type="text" data-f="d" placeholder="留空自动检测" style="width:128px">
        <span class="dy-faint">跨天记在最后一天</span>
      </div>
      <div class="dy-field" style="margin-top:12px">
        <button class="dy-btn dy-btn--on" data-f="run">动笔</button>
        <button class="dy-btn" data-f="cancel">取消</button>
      </div>`;
    box.querySelector('[data-f="cancel"]').addEventListener('click', () => box.removeAttribute('data-on'));
    box.querySelector('[data-f="run"]').addEventListener('click', async ev => {
        const btn = ev.currentTarget;
        btn.textContent = '写…'; btn.disabled = true;
        try {
            await engine.writeRange(
                Number(box.querySelector('[data-f="a"]').value),
                Number(box.querySelector('[data-f="b"]').value),
                box.querySelector('[data-f="d"]').value.trim(),
            );
            await store.saveChatFile();
            toast('写好了');
            refresh();
        } catch (e) {
            toast(e.message, true);
            btn.textContent = '动笔'; btn.disabled = false;
        }
    });
}

/* ══════════════ 日历 ══════════════ */

function renderCal(box) {
    const d = store.data();
    // 跟着最新一篇走
    if (!calCursor) {
        const latest = [...d.entries].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
        const src = latest?.date || d.startDate || new Date().toISOString().slice(0, 10);
        const [y, m] = src.split('-').map(Number);
        calCursor = { y: y || new Date().getFullYear(), m: m || 1 };
    }
    const { y, m } = calCursor;
    const first = new Date(y, m - 1, 1).getDay();
    const days = new Date(y, m, 0).getDate();

    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div class="dy-day"></div>';
    for (let n = 1; n <= days; n++) {
        const key = `${y}-${String(m).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
        const has = d.entries.some(e => e.date === key);
        const mark = d.marks[key];
        cells += `<div class="dy-day dy-day--in${has ? ' dy-day--has' : ''}" data-d="${key}">
            <div class="dy-day__n">${n}</div>
            ${mark ? `<div class="dy-day__mark" title="${esc(mark)}">♦</div>` : ''}
          </div>`;
    }

    box.innerHTML = `
      <div class="dy-cal__nav">
        <button class="dy-arrow" data-c="-1">‹</button>
        <div class="dy-cal__label"><b>${y}</b> 年 <b>${m}</b> 月</div>
        <button class="dy-arrow" data-c="1">›</button>
      </div>
      <div class="dy-cal__grid">
        ${'日一二三四五六'.split('').map(x => `<div class="dy-cal__wd">${x}</div>`).join('')}
        ${cells}
      </div>
      <div class="dy-cal__out"><div class="dy-blank"><p>点一个日子，看那天写了什么。</p></div></div>`;

    box.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => {
        let mm = calCursor.m + Number(b.dataset.c);
        if (mm < 1) { mm = 12; calCursor.y--; }
        if (mm > 12) { mm = 1; calCursor.y++; }
        calCursor.m = mm;
        renderCal(box);
    }));

    box.querySelector('.dy-cal__grid').addEventListener('click', ev => {
        const cell = ev.target.closest('.dy-day--in');
        if (!cell) return;
        box.querySelectorAll('.dy-day--sel').forEach(x => x.classList.remove('dy-day--sel'));
        cell.classList.add('dy-day--sel');
        showDay(box.querySelector('.dy-cal__out'), cell.dataset.d);
    });
}

function showDay(out, date) {
    const list = store.entryOnDate(date);
    const mark = store.data().marks[date] || '';
    if (list.length) {
        out.innerHTML = list.map(entryHtml).join('') + markBar(mark);
        out.querySelectorAll('.dy-entry').forEach(e => e.setAttribute('data-open', ''));
        bindEntries(out);
    } else {
        out.innerHTML = `<div class="dy-blank">
            <p>${esc(cnDate(date))} 还是空的。</p>
            <button class="dy-btn dy-btn--on" data-day="write">为这天补写</button>
          </div>` + markBar(mark);
        out.querySelector('[data-day="write"]')?.addEventListener('click', () => {
            const pane = root.querySelector('.dy-pane');
            pane.querySelector('[data-view="list"]').click();
            const s = pane.querySelector('.dy-sheet');
            openSheet(s);
            s.querySelector('[data-f="d"]').value = date;
        });
    }
    bindMark(out, date);
}

function markBar(mark) {
    return `<div class="dy-markbar">
        <input type="text" data-mk="i" placeholder="给这天加个标记，比如 情人节" value="${esc(mark)}">
        <button class="dy-btn dy-btn--xs" data-mk="save">存</button>
      </div>`;
}

function bindMark(out, date) {
    out.querySelector('[data-mk="save"]')?.addEventListener('click', () => {
        store.setMark(date, out.querySelector('[data-mk="i"]').value.trim());
        toast('标记好了');
        const box = root.querySelector('.dy-cal');
        renderCal(box);
    });
}

/* ══════════════ 收藏 ══════════════ */

function renderFav(pane) {
    pane.dataset.page = 'fav';
    const favs = [...store.data().favorites].sort((a, b) => b.createdAt - a.createdAt);
    pane.innerHTML = favs.length
        ? favs.map(favHtml).join('')
        : emptyHtml('收藏夹是空的', '在聊天里点任意一层右上角的书签图标。');

    pane.querySelectorAll('.dy-entry__head').forEach(h => h.addEventListener('click', () => {
        const e = h.parentElement;
        e.hasAttribute('data-open') ? e.removeAttribute('data-open') : e.setAttribute('data-open', '');
    }));

    pane.querySelectorAll('[data-f]').forEach(btn => btn.addEventListener('click', async ev => {
        ev.stopPropagation();
        const wrap = btn.closest('.dy-entry');
        const id = wrap.dataset.id;
        const fav = store.data().favorites.find(x => x.id === id);
        const act = btn.dataset.f;

        if (act === 'rename') {
            const name = prompt('给这条起个名字', fav.name || '');
            if (name === null) return;
            store.updateFav(id, { name: name.trim() });
            await store.saveChatFile();
            refresh();
        }
        if (act === 'del') {
            store.removeFav(id);
            await store.saveChatFile();
            decorateMessages();
            refresh();
        }
        if (act === 'jump') {
            const i = store.indexOfUid(fav.uid);
            if (i < 0) return toast('这层已经不在了', true);
            close();
            document.querySelector(`#chat .mes[mesid="${i}"]`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (act === 'date') {
            btn.textContent = '…';
            try {
                const date = await engine.dateOfMessage(fav.uid);
                store.updateFav(id, { date });
                await store.saveChatFile();
                refresh();
            } catch (e) { toast(e.message, true); }
        }
    }));
}

function favHtml(f) {
    const i = store.indexOfUid(f.uid);
    return `
      <div class="dy-entry" data-id="${f.id}">
        <div class="dy-entry__head">
          <div class="dy-stamp">
            <div class="dy-stamp__d">${i >= 0 ? i : '—'}</div>
            <div class="dy-stamp__m">${f.date ? esc(f.date.slice(5)) : '层'}</div>
          </div>
          <div class="dy-entry__main">
            <div class="dy-entry__title">${esc(f.name || f.snapshot.replace(/\n+/g, ' ').slice(0, 20) + '…')}</div>
            <div class="dy-entry__excerpt">${esc(f.snapshot.replace(/\n+/g, ' ').slice(0, 90))}</div>
          </div>
        </div>
        <div class="dy-entry__full">
          <div class="dy-entry__text">${esc(f.snapshot)}</div>
          <div class="dy-entry__foot">
            ${f.date ? `<span class="dy-tag">${esc(f.date)}</span>`
                     : '<button class="dy-btn dy-btn--xs" data-f="date">查日期</button>'}
            ${i < 0 ? '<span class="dy-tag dy-tag--x">已不在当前分支</span>' : ''}
            <button class="dy-btn dy-btn--xs dy-push" data-f="rename">改名</button>
            ${i >= 0 ? '<button class="dy-btn dy-btn--xs" data-f="jump">跳到这层</button>' : ''}
            <button class="dy-btn dy-btn--xs" data-f="del">移除</button>
          </div>
        </div>
      </div>`;
}

function emptyHtml(title, sub) {
    return `<div class="dy-empty"><h4>${esc(title)}</h4><p>${esc(sub)}</p></div>`;
}

/* ══════════════ 设置 ══════════════ */

async function renderSettings(pane) {
    pane.dataset.page = 'set';
    const s = store.settings();
    const d = store.data();
    const books = await ctxLib.listBooks();
    const profiles = api.tavernProfiles();

    pane.innerHTML = `
      <div class="dy-sec">
        <div class="dy-sec__h">动 笔</div>
        <div class="dy-row"><div class="dy-row__t"><label>自动</label></div>
          <div class="dy-row__c"><input type="checkbox" class="dy-sw" data-s="auto" ${s.auto ? 'checked' : ''}></div></div>
        <div class="dy-auto" ${s.auto ? '' : 'data-off'}>
          <div class="dy-row"><div class="dy-row__t"><label>触发</label>
            <div class="dy-sub">
              <div class="dy-line"><input type="checkbox" class="dy-sw" data-s="trigger.newDay" ${s.trigger.newDay ? 'checked' : ''}><span>新一天</span></div>
              <div class="dy-line"><input type="checkbox" class="dy-sw" data-s="trigger.everyN" ${s.trigger.everyN ? 'checked' : ''}><span>每</span>
                <input type="number" data-s="trigger.n" value="${s.trigger.n}"><span>层楼</span></div>
            </div></div></div>
          <div class="dy-row"><div class="dy-row__t"><label>等下一条消息再动笔</label></div>
            <div class="dy-row__c"><input type="checkbox" class="dy-sw" data-s="waitNext" ${s.waitNext ? 'checked' : ''}></div></div>
          <div class="dy-row"><div class="dy-row__t"><label>第一篇包含开场白</label></div>
            <div class="dy-row__c"><input type="checkbox" class="dy-sw" data-s="includeGreeting" ${s.includeGreeting ? 'checked' : ''}></div></div>
        </div>
      </div>

      ${apiCard('看时间', 'apiTime', s.apiTime, profiles)}
      ${apiCard('写日记', 'apiWrite', s.apiWrite, profiles)}

      <div class="dy-sec">
        <div class="dy-sec__h">给 它 看 什 么</div>
        <div class="dy-wl">
          <div class="dy-wl__h"><span class="dy-wl__n">世界观设定<em>可多选</em></span>
            <input type="checkbox" class="dy-sw" data-s="world.enabled" ${s.world.enabled ? 'checked' : ''}></div>
          <div class="dy-wl__b">
            ${books.length ? books.map(b => `
              <label class="dy-wb"><input type="checkbox" data-book="${esc(b.name)}"
                ${s.world.books.includes(b.name) ? 'checked' : ''}>${esc(b.name)}
                ${b.bound ? '<span>角色绑定</span>' : ''}</label>`).join('')
              : '<p class="dy-faint">没有找到世界书</p>'}
          </div>
          <div class="dy-wl__f"><label class="dy-line"><input type="checkbox" data-s="world.constantOnly"
            ${s.world.constantOnly ? 'checked' : ''}>只取常驻条目</label></div>
        </div>
        <div class="dy-wl">
          <div class="dy-wl__h"><span class="dy-wl__n">前情<em>记忆插件</em></span>
            <input type="checkbox" class="dy-sw" data-s="memory.enabled" ${s.memory.enabled ? 'checked' : ''}></div>
          <div class="dy-wl__f">
            <select data-s="memory.book"><option value="">（选一本）</option>
              ${books.map(b => `<option ${s.memory.book === b.name ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>
            <span>只取最近</span><input type="number" data-s="memory.recent" value="${s.memory.recent}"><span>条</span>
          </div>
        </div>
      </div>

      <div class="dy-sec">
        <div class="dy-sec__h">只 看 正 文</div>
        <div class="dy-row"><div class="dy-row__t"><label>剥掉思考和杂标签</label>
          <p>去掉 thinking / reasoning / slate / draft / 状态栏。</p></div>
          <div class="dy-row__c"><input type="checkbox" class="dy-sw" data-s="clean" ${s.clean ? 'checked' : ''}></div></div>
        <div class="dy-row"><div class="dy-row__t"><label>正文在哪</label>
          <p style="margin-bottom:8px">填了就只取匹配的部分；留空用上面的默认清洗。</p>
          <input type="text" class="dy-wide dy-mono" data-s="contentRegex" value="${esc(s.contentRegex)}"
            placeholder="&lt;content&gt;([\\s\\S]*?)&lt;/content&gt;">
          <div class="dy-probe"><button class="dy-btn dy-btn--xs" data-act="probeContent">让它读一条，猜猜看</button>
            <span class="dy-probe__out" data-out="content"></span></div>
          <pre class="dy-peek" data-peek="content"></pre></div></div>
        <div class="dy-row"><div class="dy-row__t"><label>时间在哪</label>
          <p style="margin-bottom:8px">填了就只从这一小段读日期，不必把整段正文喂给模型，省很多。</p>
          <input type="text" class="dy-wide dy-mono" data-s="timeRegex" value="${esc(s.timeRegex)}"
            placeholder="&lt;Ti&gt;([^&lt;]*)&lt;/Ti&gt;">
          <div class="dy-probe"><button class="dy-btn dy-btn--xs" data-act="probe">让它读一条，猜猜看</button>
            <span class="dy-probe__out"></span></div></div></div>
        <div class="dy-row"><div class="dy-row__t"><label>故事从哪天开始</label></div>
          <div class="dy-row__c"><input type="text" data-s="__start" value="${esc(d.startDate)}"
            placeholder="YYYY-MM-DD" style="width:110px">
            <button class="dy-btn dy-btn--xs" data-act="redetect">重新读</button></div></div>
      </div>

      <div class="dy-sec">
        <div class="dy-sec__h">怎 么 写</div>
        <textarea data-s="writePrompt">${esc(s.writePrompt)}</textarea>
        <p class="dy-hint">可用 <code>{{char}}</code> <code>{{user}}</code> <code>{{date}}</code>
          <code>{{content}}</code> <code>{{world}}</code> <code>{{memory}}</code>
          <button class="dy-btn dy-btn--xs" data-reset="writePrompt">恢复默认</button></p>
        <details class="dy-fold"><summary>看时间用的提示词</summary>
          <textarea data-s="timePrompt">${esc(s.timePrompt)}</textarea>
          <p class="dy-hint">可用 <code>{{start}}</code> <code>{{content}}</code>。必须让它只回 JSON。
            <button class="dy-btn dy-btn--xs" data-reset="timePrompt">恢复默认</button></p>
        </details>
      </div>

      <div class="dy-sec">
        <div class="dy-sec__h">运 行 日 志</div>
        <p class="dy-hint" style="margin:0 0 10px">日记写得不对时看这里：它读了哪几楼、日期怎么判的、实际喂进去什么。只留最近 12 条。</p>
        <div class="dy-logs">${logsHtml()}</div>
        <div class="dy-probe">
          <button class="dy-btn dy-btn--xs" data-act="copyLogs">复制全部</button>
          <button class="dy-btn dy-btn--xs" data-act="clearLogs">清空</button>
        </div>
      </div>

      <div class="dy-sec">
        <div class="dy-sec__h">日 记 本 身</div>
        <div class="dy-row"><div class="dy-row__t"><label>导出</label>
          <p>这个对话的全部日记、收藏、标记。</p></div>
          <div class="dy-row__c">
            <select data-s="__fmt" style="max-width:96px"><option value="json">JSON</option><option value="md">Markdown</option></select>
            <button class="dy-btn dy-btn--on" data-act="export">导出</button></div></div>
        <div class="dy-row"><div class="dy-row__t"><label>导入</label>
          <p>同一天已有日记时会问你保留哪一篇。</p></div>
          <div class="dy-row__c"><button class="dy-btn" data-act="import">选择文件</button></div></div>
      </div>`;

    bindSettings(pane);
}

function apiCard(title, key, cfg, profiles) {
    const tav = cfg.mode === 'tavern';
    return `
      <div class="dy-sec">
        <div class="dy-sec__h">${title} 的 模 型</div>
        <div class="dy-api" data-api="${key}">
          <div class="dy-f"><span>连接方式</span>
            <div class="dy-seg">
              <button data-mode="standalone" aria-pressed="${!tav}">独立 API</button>
              <button data-mode="tavern" aria-pressed="${tav}">酒馆当前</button>
            </div>
          </div>
          <div class="dy-standalone" ${tav ? 'style="display:none"' : ''}>
            <div class="dy-f"><span>地址</span><input type="text" class="dy-mono" data-c="url" value="${esc(cfg.url)}" placeholder="https://api.example.com/v1"></div>
            <div class="dy-f"><span>密钥</span><input type="password" class="dy-mono" data-c="key" value="${esc(cfg.key)}"></div>
            <div class="dy-f"><span>模型</span>
              <select data-c="model">${cfg.model ? `<option selected>${esc(cfg.model)}</option>` : '<option value="">（先拉取）</option>'}</select>
              <button class="dy-btn dy-btn--xs" data-act="pull">拉取</button></div>
          </div>
          <div class="dy-tavern" ${tav ? '' : 'style="display:none"'}>
            <div class="dy-f"><span>连接配置</span>
              <select data-c="profile"><option value="">（用当前正连着的）</option>
                ${profiles.map(p => `<option value="${esc(p.id)}" ${cfg.profile === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
              </select></div>
          </div>
          <div class="dy-f" style="margin-bottom:0"><span>参数</span>
            <span class="dy-faint">温度</span><input type="number" step="0.1" data-c="temp" value="${cfg.temp}" style="width:56px">
            <span class="dy-faint">上限</span><input type="number" data-c="max" value="${cfg.max}" style="width:64px">
            <button class="dy-btn dy-btn--xs dy-push" data-act="test">测试连接</button></div>
        </div>
      </div>`;
}

function setDeep(obj, path, val) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts.at(-1)] = val;
}

/** 拿最新一条角色回复实测正文规则，把结果摊开。纯本地，不花钱，可以随便跑。 */
function runContentPreview(pane) {
    const out = pane.querySelector('[data-out="content"]');
    const peek = pane.querySelector('[data-peek="content"]');
    if (!out || !peek) return;

    const chat = getContext().chat || [];
    const msg = [...chat].reverse().find(m => !m.is_user && String(m.mes || '').trim());
    if (!msg) { out.textContent = '聊天里还没有角色回复'; return; }

    const r = ctxLib.previewExtract(msg);
    const n = msg.mes.length;
    out.textContent = {
        regex: `正则命中 ${r.hits} 处，${n} → ${r.afterRegex} 字，清洗后 ${r.text.length} 字`,
        miss: `⚠ 正则一处都没匹配到，已退回默认清洗（${n} → ${r.text.length} 字）`,
        bad: `⚠ 正则写错了：${r.error}`,
        clean: `没填正则，用默认清洗，${n} → ${r.text.length} 字`,
    }[r.mode];

    const LIMIT = 3000;
    const over = r.text.length - LIMIT;
    peek.textContent = over > 0
        ? r.text.slice(0, LIMIT) + `\n\n…… 这里只是预览，后面还有 ${over} 字，实际会全部用上`
        : r.text;
    peek.setAttribute('data-on', '');
}

/* ────────── 运行日志 ────────── */

function logsHtml() {
    const logs = store.data().logs || [];
    if (!logs.length) return '<p class="dy-hint" style="margin:0">还没有记录。写过一篇日记之后这里才有东西。</p>';

    return logs.map(L => {
        const t = new Date(L.at);
        const when = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
        const head = L.kind === '日期已修正'
            ? `修正了 ${L.count} 处日期`
            : `${L.date}　楼层 ${L.楼层}　提示词 ${L.提示词字数} 字`;
        return `
          <details class="dy-log">
            <summary><span class="dy-log__k">${esc(L.kind)}</span>${esc(when)}　${esc(head)}</summary>
            <pre>${esc(JSON.stringify(L, null, 2))}</pre>
          </details>`;
    }).join('');
}

function bindLogs(pane) {
    pane.querySelector('[data-act="copyLogs"]')?.addEventListener('click', async () => {
        const text = JSON.stringify(store.data().logs || [], null, 2);
        try {
            await navigator.clipboard.writeText(text);
            toast('已复制，可以贴给别人看');
        } catch {
            // 移动端剪贴板可能被拦，退回手动选
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:10%;left:5%;width:90%;height:60%;z-index:99999';
            document.body.appendChild(ta);
            ta.select();
            toast('复制不了，已摊开，手动全选复制后点空白处关闭', true);
            ta.addEventListener('blur', () => ta.remove());
        }
    });
    pane.querySelector('[data-act="clearLogs"]')?.addEventListener('click', () => {
        if (!confirm('清空日志？')) return;
        store.clearLogs();
        refresh();
    });
}

function bindSettings(pane) {
    const s = store.settings();
    bindLogs(pane);

    // 普通字段
    pane.querySelectorAll('[data-s]').forEach(el => {
        const path = el.dataset.s;
        if (path.startsWith('__')) return;
        const ev = el.type === 'checkbox' ? 'change' : 'input';
        el.addEventListener(ev, () => {
            const v = el.type === 'checkbox' ? el.checked
                : el.type === 'number' ? Number(el.value) : el.value;
            setDeep(s, path, v);
            store.saveSettings();
            if (path === 'auto') {
                pane.querySelector('.dy-auto')?.toggleAttribute('data-off', !el.checked);
            }
        });
    });

    // 起始日
    pane.querySelector('[data-s="__start"]')?.addEventListener('input', e => {
        store.data().startDate = e.target.value.trim();
        store.save();
    });

    // 世界书多选
    pane.querySelectorAll('[data-book]').forEach(cb => cb.addEventListener('change', () => {
        const name = cb.dataset.book;
        const list = s.world.books;
        const i = list.indexOf(name);
        if (cb.checked && i < 0) list.push(name);
        if (!cb.checked && i >= 0) list.splice(i, 1);
        store.saveSettings();
    }));

    // API 卡片
    pane.querySelectorAll('.dy-api').forEach(card => {
        const key = card.dataset.api;
        const cfg = s[key];

        card.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
            cfg.mode = b.dataset.mode;
            store.saveSettings();
            card.querySelectorAll('[data-mode]').forEach(x =>
                x.setAttribute('aria-pressed', String(x.dataset.mode === cfg.mode)));
            card.querySelector('.dy-standalone').style.display = cfg.mode === 'tavern' ? 'none' : '';
            card.querySelector('.dy-tavern').style.display = cfg.mode === 'tavern' ? '' : 'none';
        }));

        card.querySelectorAll('[data-c]').forEach(el => {
            const f = el.dataset.c;
            el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
                cfg[f] = el.type === 'number' ? Number(el.value) : el.value;
                store.saveSettings();
            });
        });

        card.querySelector('[data-act="pull"]')?.addEventListener('click', async ev => {
            const b = ev.currentTarget;
            b.textContent = '…'; b.disabled = true;
            try {
                const models = await api.fetchModels(cfg.url, cfg.key);
                const sel = card.querySelector('[data-c="model"]');
                sel.innerHTML = models.map(m =>
                    `<option ${m === cfg.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
                if (!cfg.model && models[0]) { cfg.model = models[0]; store.saveSettings(); }
                toast(`拉到 ${models.length} 个模型`);
            } catch (e) { toast(e.message, true); }
            b.textContent = '拉取'; b.disabled = false;
        });

        card.querySelector('[data-act="test"]')?.addEventListener('click', async ev => {
            const b = ev.currentTarget;
            b.textContent = '测…'; b.disabled = true;
            try { toast(await api.testConnection(cfg)); }
            catch (e) { toast(e.message, true); }
            b.textContent = '测试连接'; b.disabled = false;
        });
    });

    // 猜正文正则：填进框里，顺手跑一次预览让用户当场看结果
    pane.querySelector('[data-act="probeContent"]')?.addEventListener('click', async ev => {
        const b = ev.currentTarget;
        const out = pane.querySelector('[data-out="content"]');
        b.textContent = '读…'; b.disabled = true; out.textContent = '';
        try {
            const r = await engine.probeContentRegex();
            pane.querySelector('[data-s="contentRegex"]').value = r.regex;
            s.contentRegex = r.regex;
            store.saveSettings();
            runContentPreview(pane);
            if (r.note) out.textContent = `${r.note}　|　${out.textContent}`;
        } catch (e) {
            out.textContent = e.message;
        }
        b.textContent = '让它读一条，猜猜看'; b.disabled = false;
    });

    // 恢复默认提示词
    pane.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.reset;
        const def = key === 'timePrompt' ? store.DEFAULT_TIME_PROMPT : store.DEFAULT_WRITE_PROMPT;
        if (!confirm('用默认的覆盖掉现在这份？')) return;
        s[key] = def;
        store.saveSettings();
        const ta = pane.querySelector(`textarea[data-s="${key}"]`);
        if (ta) ta.value = def;
        toast('已恢复默认');
    }));

    // 猜时间正则：只给建议，填不填由用户定
    pane.querySelector('[data-act="probe"]')?.addEventListener('click', async ev => {
        const b = ev.currentTarget;
        const out = pane.querySelector('.dy-probe__out');
        b.textContent = '读…'; b.disabled = true; out.textContent = '';
        try {
            const r = await engine.probeTimeRegex();
            const input = pane.querySelector('[data-s="timeRegex"]');
            input.value = r.regex;
            s.timeRegex = r.regex;
            store.saveSettings();
            out.textContent = r.sample ? `抓到：${r.sample.slice(0, 40)}` : '已填入，确认一下';
        } catch (e) {
            out.textContent = e.message;
        }
        b.textContent = '让它读一条，猜猜看'; b.disabled = false;
    });

    // 重新读起始日
    pane.querySelector('[data-act="redetect"]')?.addEventListener('click', async ev => {
        const b = ev.currentTarget;
        b.textContent = '读…'; b.disabled = true;
        try {
            const date = await engine.detectStartDate(true);
            pane.querySelector('[data-s="__start"]').value = date || '';
            toast(date ? `读到 ${date}` : '没读出来，手填一个吧', !date);
        } catch (e) { toast(e.message, true); }
        b.textContent = '重新读'; b.disabled = false;
    });

    // 导出
    pane.querySelector('[data-act="export"]')?.addEventListener('click', () => {
        const fmt = pane.querySelector('[data-s="__fmt"]').value;
        const d = store.data();
        const name = getContext().name2 || 'diary';
        let blob, ext;
        if (fmt === 'md') {
            const body = store.sortedEntries().map(e =>
                `## ${e.date}　${e.title}\n\n${e.text}\n`).join('\n---\n\n');
            blob = new Blob([`# ${name} 的日记\n\n${body}`], { type: 'text/markdown' });
            ext = 'md';
        } else {
            blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
            ext = 'json';
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${name}-日记.${ext}`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // 导入
    pane.querySelector('[data-act="import"]')?.addEventListener('click', () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.json';
        inp.addEventListener('change', async () => {
            const file = inp.files?.[0];
            if (!file) return;
            try {
                const incoming = JSON.parse(await file.text());
                const d = store.data();
                let added = 0, skipped = 0;
                for (const e of incoming.entries || []) {
                    const clash = d.entries.find(x => x.date === e.date);
                    if (clash && !confirm(`${e.date} 已经有一篇「${clash.title}」。\n用导入的这篇覆盖吗？`)) {
                        skipped++; continue;
                    }
                    if (clash) store.removeEntry(clash.id);
                    store.addEntry({ ...e, id: store.newId() });
                    added++;
                }
                Object.assign(d.marks, incoming.marks || {});
                store.save();
                await store.saveChatFile();
                toast(`导入 ${added} 篇${skipped ? `，跳过 ${skipped} 篇` : ''}`);
                refresh();
            } catch (e) { toast('文件读不了：' + e.message, true); }
        });
        inp.click();
    });
}

export { refresh };
