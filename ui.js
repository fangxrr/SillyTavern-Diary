/**
 * 界面层 —— 一台打字机 + 一墙便签
 *
 * 打字机是控制台，不是装饰：滚筒上的纸显示当前状态，
 * 四个键切换便签墙 / 日历 / 设置 / 补写。
 * 每篇日记是一张便签，点开摊成一整页。
 */

import { getContext } from '../../../extensions.js';
import * as store from './store.js';
import * as api from './api.js';
import * as ctxLib from './context.js';
import * as engine from './engine.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MON = ['—', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const cnDate = iso => {
    const [y, m, d] = String(iso || '').split('-');
    return y && m && d ? `${y} 年 ${+m} 月 ${+d} 日` : String(iso || '');
};

let root = null;
let view = 'wall';
let openId = null;   // 正在摊开的是哪一张
let calCursor = null;

function toast(msg, bad = false) {
    if (typeof toastr !== 'undefined') bad ? toastr.error(msg) : toastr.success(msg);
    else console.log('[日记本]', msg);
}

/* ══════════════ 入口 ══════════════ */

export function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('tw-wand')) return;
    const el = document.createElement('div');
    el.id = 'tw-wand';
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.tabIndex = 0;
    el.innerHTML = `<i class="fa-solid fa-keyboard"></i><span>日记本</span>`;
    el.addEventListener('click', () => open());
    menu.appendChild(el);
}

export function open() {
    if (!root) build();
    root.classList.add('tw-on');
    document.body.classList.add('tw-lock');
    go(view);
}

export function close() {
    root?.classList.remove('tw-on');
    document.body.classList.remove('tw-lock');
}

function build() {
    // 扩展热重载时可能留下上一轮的节点，先清干净
    document.getElementById('tw-root')?.remove();

    root = document.createElement('div');
    root.id = 'tw-root';
    root.innerHTML = `
      <div class="tw-room">
        <button class="tw-shut" title="收起">&times;</button>
        <div class="tw-wall"></div>
        <div class="tw-machine">
          <div class="tw-feed"><span class="tw-feed__dot"></span><span class="tw-feed__t"></span></div>
          <div class="tw-platen"></div>
          <div class="tw-deck">
            <div class="tw-brand"></div>
            <div class="tw-keys">
              <button class="tw-key" data-k="wall">便签 <b></b></button>
              <button class="tw-key" data-k="cal">日历</button>
              <button class="tw-key" data-k="set">设置</button>
              <button class="tw-key tw-key--ribbon" data-k="new">补写</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.querySelector('.tw-shut').addEventListener('click', close);

    root.addEventListener('click', ev => {
        const key = ev.target.closest('[data-k]');
        if (key) { go(key.dataset.k); return; }
        const slip = ev.target.closest('.tw-slip[data-id]');
        if (slip) { spread(slip.dataset.id); return; }
    });

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !root?.classList.contains('tw-on')) return;
        view === 'page' ? go('wall') : close();
    });
}

function go(k) {
    view = k;
    const lit = k === 'page' ? 'wall' : k;
    root.querySelectorAll('.tw-key[data-k]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.k === lit)));

    const ctx = getContext();
    let brand = String(ctx.name2 || '').trim();
    if (!brand || /^silly\s*tavern/i.test(brand)) brand = 'DIARY';
    root.querySelector('.tw-brand').textContent = brand.split('').join(' ');
    root.querySelector('.tw-key[data-k="wall"] b').textContent = store.data().entries.length;

    const wall = root.querySelector('.tw-wall');
    wall.scrollTop = 0;
    ({ wall: viewWall, cal: viewCal, set: viewSet, new: viewNew, page: viewPage }[k] || viewWall)(wall);
}

function feed(html) { root.querySelector('.tw-feed__t').innerHTML = html; }

export function refresh() {
    if (root?.classList.contains('tw-on')) go(view);
}

/* ══════════════ 便签墙 ══════════════ */

function viewWall(wall) {
    const list = store.sortedEntries();
    const latest = [...list].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
    feed(list.length
        ? `共 <b>${list.length}</b> 张 · 最近 ${esc(latest?.date || '')}`
        : '还没有写过');

    wall.className = 'tw-wall';
    wall.innerHTML = list.length
        ? list.map(slipHtml).join('')
        : `<div class="tw-nothing">墙 上 还 是 空 的<br><br>
             玩下去它会自己动笔<br>或者按「补写」自己开一张</div>`;
}

function slipHtml(e, i) {
    const [, m, d] = String(e.date || '').split('-');
    return `
      <div class="tw-slip${i % 3 === 1 ? ' tw-slip--tape' : ''}" data-id="${e.id}" tabindex="0">
        <div class="tw-slip__date">
          <span>${esc(String(e.date || '').replace(/-/g, '.'))}</span>
          <span class="tw-slip__no">${MON[+m] || ''} ${d || ''}</span>
        </div>
        <div class="tw-slip__title">${esc(e.title || '(无标题)')}</div>
        <div class="tw-slip__body">${esc(String(e.text).replace(/\n+/g, ' '))}</div>
        ${e.pinned ? '<span class="tw-slip__pin">钉住</span>' : ''}
      </div>`;
}

/* ══════════════ 摊开一页 ══════════════ */
/*
 * 直接画在便签墙的位置上，不用浮层。
 * 酒馆的主题常给外层容器加 transform，那会让 position:fixed 相对容器定位
 * 而不是视口，浮层就会跑到内容后面去。视图切换没有这个问题。
 */

function spread(id) {
    openId = id;
    go('page');
}

function viewPage(wall) {
    const e = store.data().entries.find(x => x.id === openId);
    if (!e) { go('wall'); return; }

    const a = store.indexOfUid(e.startUid), b = store.indexOfUid(e.endUid);
    const alive = a >= 0 && b >= a;
    feed(`在读 · ${esc(e.date || '')}`);

    wall.className = 'tw-wall tw-wall--solo';
    wall.innerHTML = `
      <div class="tw-pagewrap">
        <button class="tw-back" data-k="wall">← 回到墙上</button>
        <div class="tw-page">
          <div class="tw-page__head">
            <span>${esc(String(e.date || '').replace(/-/g, ' . '))}</span>
            <span>${alive ? `第 ${a}–${b} 层` : '源楼层已删'} · ${e.source === 'manual' ? '手动' : '自动'}</span>
          </div>
          <div class="tw-page__title">${esc(e.title || '(无标题)')}</div>
          <div class="tw-page__text" data-role="text">${esc(e.text)}</div>
          <div class="tw-page__foot">
            ${e.spanFrom ? `<span class="tw-pbtn" style="cursor:default">含 ${esc(e.spanFrom)} 起</span>` : ''}
            <button class="tw-pbtn" data-e="pin" style="margin-left:auto">${e.pinned ? '取下' : '钉住'}</button>
            <button class="tw-pbtn" data-e="edit">改写</button>
            ${alive ? '<button class="tw-pbtn" data-e="rewrite">重写</button>' : ''}
            <button class="tw-pbtn tw-pbtn--ribbon" data-e="del">撕掉</button>
          </div>
        </div>
      </div>`;

    const page = wall.querySelector('.tw-page');
    page.querySelectorAll('[data-e]').forEach(btn => btn.addEventListener('click', async ev => {
        ev.stopPropagation();
        const act = btn.dataset.e;

        if (act === 'pin') {
            store.updateEntry(id_of(e), { pinned: !e.pinned });
            await store.saveChatFile();
            go('wall');
        }
        if (act === 'del') {
            if (!confirm('撕掉这张？撕了就没了。')) return;
            store.removeEntry(id_of(e));
            await store.saveChatFile();
            toast('撕掉了');
            go('wall');
        }
        if (act === 'edit') {
            const box = page.querySelector('[data-role="text"]');
            if (box.tagName === 'TEXTAREA') return;
            const ta = document.createElement('textarea');
            ta.className = 'tw-editor';
            ta.dataset.role = 'text';
            ta.value = e.text;
            box.replaceWith(ta);
            ta.focus();
            // 改写时把其他按钮收起来，只留「存下」和「不改了」，
            // 免得手滑点到旁边的「撕掉」
            page.querySelectorAll('.tw-page__foot [data-e]').forEach(x => {
                if (x !== btn) x.style.display = 'none';
            });
            const cancel = document.createElement('button');
            cancel.className = 'tw-pbtn';
            cancel.textContent = '不改了';
            cancel.addEventListener('click', ev2 => { ev2.stopPropagation(); go('page'); });
            btn.after(cancel);
            btn.textContent = '存下';
            btn.dataset.e = 'save';
        }
        if (act === 'save') {
            store.updateEntry(id_of(e), { text: page.querySelector('textarea[data-role="text"]').value });
            await store.saveChatFile();
            toast('存好了');
            go('page');
        }
        if (act === 'rewrite') {
            btn.textContent = '打字中'; btn.disabled = true;
            try {
                await engine.rewrite(id_of(e));
                await store.saveChatFile();
                toast('重写好了');
                go('page');
            } catch (err) {
                toast(err.message, true);
                btn.textContent = '重写'; btn.disabled = false;
            }
        }
    }));
}

const id_of = e => e.id;

/* ══════════════ 日历 ══════════════ */

function viewCal(wall) {
    const d = store.data();
    if (!calCursor) {
        const latest = [...d.entries].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1);
        const src = latest?.date || d.startDate || new Date().toISOString().slice(0, 10);
        const [y, m] = src.split('-').map(Number);
        calCursor = { y: y || new Date().getFullYear(), m: m || 1 };
    }
    const { y, m } = calCursor;
    const first = new Date(y, m - 1, 1).getDay();
    const days = new Date(y, m, 0).getDate();
    const prefix = `${y}-${String(m).padStart(2, '0')}`;
    feed(`${y} 年 ${m} 月 · <b>${d.entries.filter(e => String(e.date).startsWith(prefix)).length}</b> 天写过`);

    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div class="tw-cell"></div>';
    for (let n = 1; n <= days; n++) {
        const key = `${prefix}-${String(n).padStart(2, '0')}`;
        const has = d.entries.some(e => e.date === key);
        cells += `<div class="tw-cell tw-cell--in${has ? ' tw-cell--has' : ''}${d.marks[key] ? ' tw-cell--mark' : ''}"
                    data-d="${key}" title="${esc(d.marks[key] || '')}">${n}</div>`;
    }

    wall.className = 'tw-wall tw-wall--center';
    wall.innerHTML = `
      <div class="tw-calwrap">
        <div class="tw-cal__nav">
          <button class="tw-arrow" data-c="-1">&lt;</button>
          <div class="tw-cal__label">${y} 年 ${m} 月</div>
          <button class="tw-arrow" data-c="1">&gt;</button>
        </div>
        <div class="tw-grid">
          ${'日一二三四五六'.split('').map(x => `<div class="tw-wd">${x}</div>`).join('')}
          ${cells}
        </div>
        <div class="tw-cal__out"></div>
      </div>`;

    wall.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', () => {
        let mm = calCursor.m + Number(b.dataset.c);
        if (mm < 1) { mm = 12; calCursor.y--; }
        if (mm > 12) { mm = 1; calCursor.y++; }
        calCursor.m = mm;
        viewCal(wall);
    }));

    wall.querySelector('.tw-grid').addEventListener('click', ev => {
        const cell = ev.target.closest('.tw-cell--in');
        if (!cell) return;
        wall.querySelectorAll('.tw-cell--sel').forEach(x => x.classList.remove('tw-cell--sel'));
        cell.classList.add('tw-cell--sel');
        showDay(wall.querySelector('.tw-cal__out'), cell.dataset.d);
    });
}

function showDay(out, date) {
    const hit = store.entryOnDate(date);
    const mark = store.data().marks[date] || '';

    out.innerHTML = (hit.length
        ? `<div class="tw-daylist">${hit.map((e, i) => slipHtml(e, i)).join('')}</div>`
        : `<div class="tw-nothing">${esc(cnDate(date))}<br>这天没有写<br><br>
             <button class="tw-key" data-k="new">为这天补一张</button></div>`)
        + `<div class="tw-markbar">
             <input type="text" data-mk="i" placeholder="给这天记一笔，比如 她生日" value="${esc(mark)}">
             <button class="tw-pbtn tw-pbtn--dim" data-mk="save">记下</button>
           </div>`;

    out.querySelector('[data-mk="save"]')?.addEventListener('click', () => {
        store.setMark(date, out.querySelector('[data-mk="i"]').value.trim());
        toast('记下了');
        viewCal(root.querySelector('.tw-wall'));
    });
}

/* ══════════════ 补写 ══════════════ */

function viewNew(wall) {
    feed('补写 · 选好范围按「动笔」');
    const len = (getContext().chat?.length || 1) - 1;

    wall.className = 'tw-wall tw-wall--center';
    wall.innerHTML = `
      <div class="tw-spec" style="max-width:460px">
        <div class="tw-spec__h">补 写 一 张</div>
        <div class="tw-f"><span>范围</span>
          <input type="number" data-n="a" value="${Math.max(0, len - 9)}" style="width:78px">
          <span style="min-width:0">到</span>
          <input type="number" data-n="b" value="${len}" style="width:78px"></div>
        <div class="tw-f"><span>记在</span>
          <input type="text" data-n="d" placeholder="留空自动检测" style="width:152px"></div>
        <p class="tw-tiny">跨天的记在最后一天。</p>
        <div style="margin-top:20px;display:flex;gap:9px;flex-wrap:wrap">
          <button class="tw-key tw-key--ribbon" data-n="run" style="padding:11px 24px">动笔</button>
          <button class="tw-key" data-k="wall" style="padding:11px 24px">取消</button>
        </div>
      </div>`;

    wall.querySelector('[data-n="run"]').addEventListener('click', async ev => {
        const b = ev.currentTarget;
        b.textContent = '打字中'; b.disabled = true;
        try {
            await engine.writeRange(
                Number(wall.querySelector('[data-n="a"]').value),
                Number(wall.querySelector('[data-n="b"]').value),
                wall.querySelector('[data-n="d"]').value.trim(),
            );
            await store.saveChatFile();
            toast('写好了');
            go('wall');
        } catch (e) {
            toast(e.message, true);
            b.textContent = '动笔'; b.disabled = false;
        }
    });
}

/* ══════════════ 设置 ══════════════ */

async function viewSet(wall) {
    feed('设置 · 改动即时生效');
    const s = store.settings();
    const d = store.data();
    const rules = store.charRules();
    const books = await ctxLib.listBooks();
    const profiles = api.tavernProfiles();

    wall.className = 'tw-wall tw-wall--solo';
    wall.innerHTML = `
      <div class="tw-spec">
        <div class="tw-spec__h">A ─ 动 笔</div>
        <div class="tw-r"><div class="tw-r__t"><label>自动</label></div>
          <div class="tw-r__c"><input type="checkbox" class="tw-tog" data-s="auto" ${s.auto ? 'checked' : ''}></div></div>
        <div class="tw-auto" ${s.auto ? '' : 'data-off'}>
          <div class="tw-r"><div class="tw-r__t"><label>触发</label><div class="tw-sub">
            <div class="tw-ln"><input type="checkbox" class="tw-tog" data-s="trigger.newDay" ${s.trigger.newDay ? 'checked' : ''}><span>新一天</span></div>
            <div class="tw-ln"><input type="checkbox" class="tw-tog" data-s="trigger.everyN" ${s.trigger.everyN ? 'checked' : ''}><span>每</span>
              <input type="number" data-s="trigger.n" value="${s.trigger.n}"><span>层楼</span></div>
          </div></div></div>
          <div class="tw-r"><div class="tw-r__t"><label>等下一条消息再动笔</label></div>
            <div class="tw-r__c"><input type="checkbox" class="tw-tog" data-s="waitNext" ${s.waitNext ? 'checked' : ''}></div></div>
          <div class="tw-r"><div class="tw-r__t"><label>第一篇包含开场白</label></div>
            <div class="tw-r__c"><input type="checkbox" class="tw-tog" data-s="includeGreeting" ${s.includeGreeting ? 'checked' : ''}></div></div>
        </div>

        ${apiBlock('B ─ 看 时 间 的 模 型', 'apiTime', s.apiTime, profiles)}
        ${apiBlock('C ─ 写 日 记 的 模 型', 'apiWrite', s.apiWrite, profiles)}

        <div class="tw-spec__h">D ─ 给 它 看 什 么</div>
        <div class="tw-book">
          <div class="tw-book__h"><span class="tw-book__n">世界观设定</span>
            <input type="checkbox" class="tw-tog" data-s="world.enabled" ${s.world.enabled ? 'checked' : ''}></div>
          ${books.length ? books.map(b => `
            <label class="tw-wb"><input type="checkbox" data-book="${esc(b.name)}"
              ${s.world.books.includes(b.name) ? 'checked' : ''}>${esc(b.name)}
              ${b.bound ? '<span>角色绑定</span>' : ''}</label>`).join('')
            : '<p class="tw-tiny">没有找到世界书</p>'}
          <label class="tw-wb tw-wb--sep"><input type="checkbox" data-s="world.constantOnly"
            ${s.world.constantOnly ? 'checked' : ''}>只取常驻条目</label>
        </div>
        <div class="tw-book">
          <div class="tw-book__h"><span class="tw-book__n">前情 · 记忆插件</span>
            <input type="checkbox" class="tw-tog" data-s="memory.enabled" ${s.memory.enabled ? 'checked' : ''}></div>
          <div class="tw-f" style="margin:0">
            <select data-s="memory.book"><option value="">（选一本）</option>
              ${books.map(b => `<option ${s.memory.book === b.name ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            </select>
            <span style="min-width:0">最近</span><input type="number" data-s="memory.recent" value="${s.memory.recent}">
            <span style="min-width:0">条</span></div>
        </div>

        <div class="tw-spec__h">E ─ 只 看 正 文</div>
        <p class="tw-tiny" style="margin:0 0 12px">下面两条正则只对当前这张卡生效，换角色互不影响。</p>
        <div class="tw-r"><div class="tw-r__t"><label>剥掉思考和杂标签</label>
          <p>thinking / reasoning / slate / draft / 状态栏</p></div>
          <div class="tw-r__c"><input type="checkbox" class="tw-tog" data-s="clean" ${s.clean ? 'checked' : ''}></div></div>
        <div class="tw-r"><div class="tw-r__t"><label>只读角色楼层</label>
          <p>写日记时不看你的输入。角色回复里通常已经复述过那一轮，
             两边都喂等于同一件事说两遍。<br>
             如果你的卡不复述、你的输入里有角色不知道的关键动作，就关掉它。</p></div>
          <div class="tw-r__c"><input type="checkbox" class="tw-tog" data-s="onlyCharContent" ${s.onlyCharContent ? 'checked' : ''}></div></div>
        <div class="tw-r"><div class="tw-r__t"><label>正文在哪</label>
          <p>填了就只取匹配的部分；留空用上面的默认清洗。</p>
          <input type="text" data-rule="contentRegex" value="${esc(rules.contentRegex)}"
            placeholder="&lt;content&gt;([\\s\\S]*?)&lt;/content&gt;" style="width:100%;margin-top:8px">
          <div class="tw-probe"><button class="tw-pbtn tw-pbtn--dim" data-act="probeContent">让它读一条，猜猜看</button>
            <span data-out="content"></span></div>
          <pre class="tw-peek" data-peek="content"></pre></div></div>
        <div class="tw-r"><div class="tw-r__t"><label>时间在哪</label>
          <p>填了就只从这一小段读日期，不必把整段正文喂给模型，省很多。</p>
          <input type="text" data-rule="timeRegex" value="${esc(rules.timeRegex)}"
            placeholder="&lt;Ti&gt;([^&lt;]*)&lt;/Ti&gt;" style="width:100%;margin-top:8px">
          <div class="tw-probe"><button class="tw-pbtn tw-pbtn--dim" data-act="tryTime">试一下</button>
            <button class="tw-pbtn tw-pbtn--dim" data-act="probeTime">让它读一条，猜猜看</button>
            <span data-out="time"></span></div></div></div>
        <div class="tw-r"><div class="tw-r__t"><label>故事从哪天开始</label></div>
          <div class="tw-r__c"><input type="text" data-s="__start" value="${esc(d.startDate)}"
            placeholder="YYYY-MM-DD" style="width:118px">
            <button class="tw-pbtn tw-pbtn--dim" data-act="redetect">重新读</button></div></div>
        <div class="tw-r"><div class="tw-r__t"><label>重算所有日期</label>
          <p>忘掉之前判过的日期，下次写日记时按当前的正则和起始日重新算一遍。
             改了正则或起始日之后点一次。</p>
          <div class="tw-probe"><button class="tw-pbtn tw-pbtn--dim" data-act="clearDates">忘掉重算</button>
            <span data-out="dates"></span></div></div></div>

        <div class="tw-spec__h">F ─ 怎 么 写</div>
        <textarea data-s="writePrompt">${esc(s.writePrompt)}</textarea>
        <p class="tw-tiny">可用 <code>{{char}}</code> <code>{{user}}</code> <code>{{date}}</code>
          <code>{{content}}</code> <code>{{world}}</code> <code>{{memory}}</code>
          <button class="tw-pbtn tw-pbtn--dim" data-reset="writePrompt">恢复默认</button></p>
        <details class="tw-log" style="margin-top:10px"><summary>看时间用的提示词</summary>
          <div class="tw-fold">
            <textarea data-s="timePrompt">${esc(s.timePrompt)}</textarea>
            <p class="tw-tiny">可用 <code>{{start}}</code> <code>{{content}}</code>。必须让它只回 JSON。
              <button class="tw-pbtn tw-pbtn--dim" data-reset="timePrompt">恢复默认</button></p>
          </div></details>

        <div class="tw-spec__h">G ─ 运 行 日 志</div>
        <p class="tw-tiny" style="margin:0 0 10px">日记写得不对时看这里：它读了哪几楼、日期怎么判的、实际喂进去什么。</p>
        ${logsHtml()}
        <div class="tw-probe"><button class="tw-pbtn tw-pbtn--dim" data-act="copyLogs">复制全部</button>
          <button class="tw-pbtn tw-pbtn--dim" data-act="clearLogs">清空</button></div>

        <div class="tw-spec__h">H ─ 日 记 本 身</div>
        <div class="tw-f"><span>导出</span>
          <select data-s="__fmt" style="max-width:112px"><option value="json">JSON</option><option value="md">Markdown</option></select>
          <button class="tw-pbtn tw-pbtn--dim" data-act="export">导出</button>
          <button class="tw-pbtn tw-pbtn--dim" data-act="import">导入</button></div>
      </div>`;

    bindSettings(wall);
}

function apiBlock(title, key, cfg, profiles) {
    const tav = cfg.mode === 'tavern';
    return `
      <div class="tw-spec__h">${title}</div>
      <div data-api="${key}">
        <div class="tw-f"><span>连接</span>
          <select data-c="mode">
            <option value="standalone" ${tav ? '' : 'selected'}>独立 API</option>
            <option value="tavern" ${tav ? 'selected' : ''}>酒馆当前</option>
          </select></div>
        <div class="tw-standalone" ${tav ? 'style="display:none"' : ''}>
          <div class="tw-f"><span>地址</span><input type="text" data-c="url" value="${esc(cfg.url)}" placeholder="https://api.example.com/v1"></div>
          <div class="tw-f"><span>密钥</span><input type="password" data-c="key" value="${esc(cfg.key)}"></div>
          <div class="tw-f"><span>模型</span>
            <select data-c="model">${cfg.model ? `<option selected>${esc(cfg.model)}</option>` : '<option value="">（先拉取）</option>'}</select>
            <button class="tw-pbtn tw-pbtn--dim" data-act="pull">拉取</button></div>
        </div>
        <div class="tw-tavern" ${tav ? '' : 'style="display:none"'}>
          <div class="tw-f"><span>配置</span>
            <select data-c="profile"><option value="">（用当前正连着的）</option>
              ${profiles.map(p => `<option value="${esc(p.id)}" ${cfg.profile === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select></div>
        </div>
        <div class="tw-f"><span>参数</span>
          <span style="min-width:0">温度</span><input type="number" step="0.1" data-c="temp" value="${cfg.temp}" style="width:60px">
          <span style="min-width:0">上限</span><input type="number" data-c="max" value="${cfg.max}" style="width:74px">
          <button class="tw-pbtn tw-pbtn--dim" data-act="test">测试连接</button></div>
      </div>`;
}

/* ────────── 日志 ────────── */

function logsHtml() {
    const logs = store.data().logs || [];
    if (!logs.length) return '<p class="tw-tiny">还没有记录。写过一张之后这里才有东西。</p>';

    return logs.map(L => {
        const t = new Date(L.at);
        const p2 = n => String(n).padStart(2, '0');
        const when = `${p2(t.getMonth() + 1)}.${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
        const head = L.kind === '日期已修正' ? `${L.count} 处` : `${L.date} · 楼层 ${L.楼层}`;
        return `<details class="tw-log">
            <summary>[${esc(L.kind)}] ${esc(when)} · ${esc(head)}</summary>
            <pre>${esc(JSON.stringify(L, null, 2))}</pre>
          </details>`;
    }).join('');
}

/* ────────── 设置绑定 ────────── */

function setDeep(obj, path, val) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts.at(-1)] = val;
}

function runPreview(wall) {
    const out = wall.querySelector('[data-out="content"]');
    const peek = wall.querySelector('[data-peek="content"]');
    if (!out || !peek) return;

    const chat = getContext().chat || [];
    const msg = [...chat].reverse().find(m => !m.is_user && String(m.mes || '').trim());
    if (!msg) { out.textContent = '聊天里还没有角色回复'; return; }

    const r = ctxLib.previewExtract(msg);
    const n = msg.mes.length;
    out.textContent = {
        regex: `正则命中 ${r.hits} 处，${n} → ${r.afterRegex} 字，清洗后 ${r.text.length} 字`,
        miss: `正则一处都没匹配到，已退回默认清洗（${n} → ${r.text.length} 字）`,
        bad: `正则写错了：${r.error}`,
        clean: `没填正则，用默认清洗，${n} → ${r.text.length} 字`,
    }[r.mode];

    const LIMIT = 3000;
    const over = r.text.length - LIMIT;
    peek.textContent = over > 0
        ? r.text.slice(0, LIMIT) + `\n\n…… 这里只是预览，后面还有 ${over} 字，实际会全部用上`
        : r.text;
    peek.setAttribute('data-on', '');
}

function bindSettings(wall) {
    const s = store.settings();

    wall.querySelectorAll('[data-s]').forEach(el => {
        const path = el.dataset.s;
        if (path.startsWith('__')) return;
        el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
            const v = el.type === 'checkbox' ? el.checked
                : el.type === 'number' ? Number(el.value) : el.value;
            setDeep(s, path, v);
            store.saveSettings();
            if (path === 'auto') wall.querySelector('.tw-auto')?.toggleAttribute('data-off', !el.checked);
        });
    });

    wall.querySelectorAll('[data-rule]').forEach(el =>
        el.addEventListener('input', () => store.saveCharRules({ [el.dataset.rule]: el.value })));

    wall.querySelector('[data-s="__start"]')?.addEventListener('input', e => {
        store.data().startDate = e.target.value.trim();
        store.save();
    });

    wall.querySelectorAll('[data-book]').forEach(cb => cb.addEventListener('change', () => {
        const list = s.world.books;
        const i = list.indexOf(cb.dataset.book);
        if (cb.checked && i < 0) list.push(cb.dataset.book);
        if (!cb.checked && i >= 0) list.splice(i, 1);
        store.saveSettings();
    }));

    wall.querySelectorAll('[data-api]').forEach(card => {
        const cfg = s[card.dataset.api];
        card.querySelectorAll('[data-c]').forEach(el => {
            el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
                cfg[el.dataset.c] = el.type === 'number' ? Number(el.value) : el.value;
                store.saveSettings();
                if (el.dataset.c === 'mode') {
                    card.querySelector('.tw-standalone').style.display = cfg.mode === 'tavern' ? 'none' : '';
                    card.querySelector('.tw-tavern').style.display = cfg.mode === 'tavern' ? '' : 'none';
                }
            });
        });
        card.querySelector('[data-act="pull"]')?.addEventListener('click', async ev => {
            const b = ev.currentTarget;
            b.textContent = '…'; b.disabled = true;
            try {
                const models = await api.fetchModels(cfg.url, cfg.key);
                card.querySelector('[data-c="model"]').innerHTML =
                    models.map(m => `<option ${m === cfg.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
                if (!cfg.model && models[0]) { cfg.model = models[0]; store.saveSettings(); }
                toast(`拉到 ${models.length} 个模型`);
            } catch (e) { toast(e.message, true); }
            b.textContent = '拉取'; b.disabled = false;
        });
        card.querySelector('[data-act="test"]')?.addEventListener('click', async ev => {
            const b = ev.currentTarget;
            b.textContent = '…'; b.disabled = true;
            try { toast(await api.testConnection(cfg)); }
            catch (e) { toast(e.message, true); }
            b.textContent = '测试连接'; b.disabled = false;
        });
    });

    wall.querySelector('[data-act="probeContent"]')?.addEventListener('click', async ev => {
        const b = ev.currentTarget, out = wall.querySelector('[data-out="content"]');
        b.textContent = '读…'; b.disabled = true; out.textContent = '';
        try {
            const r = await engine.probeContentRegex();
            wall.querySelector('[data-rule="contentRegex"]').value = r.regex;
            store.saveCharRules({ contentRegex: r.regex });
            runPreview(wall);
            if (r.note) out.textContent = `${r.note}　|　${out.textContent}`;
        } catch (e) { out.textContent = e.message; }
        b.textContent = '让它读一条，猜猜看'; b.disabled = false;
    });

    // 试一下时间正则：纯本地，不发请求
    wall.querySelector('[data-act="tryTime"]')?.addEventListener('click', () => {
        const out = wall.querySelector('[data-out="time"]');
        const chat = getContext().chat || [];
        const msg = [...chat].reverse().find(m => !m.is_user && String(m.mes || '').trim());
        if (!msg) { out.textContent = '聊天里还没有角色回复'; return; }

        const frag = ctxLib.extractTime(msg);
        if (!frag) {
            out.textContent = '抠不到。检查标签名对不对，以及有没有写捕获组 ( )';
            return;
        }
        const date = engine.tryParseDate(frag);
        out.textContent = date
            ? `抠到「${frag.slice(0, 30)}」→ ${date}，本地就能算，不花钱`
            : `抠到「${frag.slice(0, 30)}」，但认不出格式，会交给模型判断`;
    });

    wall.querySelector('[data-act="probeTime"]')?.addEventListener('click', async ev => {
        const b = ev.currentTarget, out = wall.querySelector('[data-out="time"]');
        b.textContent = '读…'; b.disabled = true; out.textContent = '';
        try {
            const r = await engine.probeTimeRegex();
            wall.querySelector('[data-rule="timeRegex"]').value = r.regex;
            store.saveCharRules({ timeRegex: r.regex });
            out.textContent = r.sample ? `抓到：${r.sample.slice(0, 44)}` : '已填入，确认一下';
        } catch (e) { out.textContent = e.message; }
        b.textContent = '让它读一条，猜猜看'; b.disabled = false;
    });

    wall.querySelector('[data-act="clearDates"]')?.addEventListener('click', () => {
        const n = Object.keys(store.data().dateIndex || {}).length;
        if (!confirm(`忘掉已经判过的 ${n} 条日期记录？\n已经写好的日记不受影响。`)) return;
        store.clearDateIndex();
        wall.querySelector('[data-out="dates"]').textContent = `已忘掉 ${n} 条，下次写日记会重新算`;
        toast('已清空日期缓存');
    });

    wall.querySelector('[data-act="redetect"]')?.addEventListener('click', async ev => {
        const b = ev.currentTarget;
        b.textContent = '读…'; b.disabled = true;
        try {
            const date = await engine.detectStartDate(true);
            wall.querySelector('[data-s="__start"]').value = date || '';
            toast(date ? `读到 ${date}` : '没读出来，手填一个吧', !date);
        } catch (e) { toast(e.message, true); }
        b.textContent = '重新读'; b.disabled = false;
    });

    wall.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', () => {
        const key = btn.dataset.reset;
        const def = key === 'timePrompt' ? store.DEFAULT_TIME_PROMPT : store.DEFAULT_WRITE_PROMPT;
        if (!confirm('用默认的覆盖掉现在这份？')) return;
        s[key] = def;
        store.saveSettings();
        const ta = wall.querySelector(`textarea[data-s="${key}"]`);
        if (ta) ta.value = def;
        toast('已恢复默认');
    }));

    wall.querySelector('[data-act="copyLogs"]')?.addEventListener('click', async () => {
        const text = JSON.stringify(store.data().logs || [], null, 2);
        try { await navigator.clipboard.writeText(text); toast('已复制'); }
        catch { toast('复制不了，去浏览器控制台看 [日记本] 开头那几行', true); }
    });

    wall.querySelector('[data-act="clearLogs"]')?.addEventListener('click', () => {
        if (!confirm('清空日志？')) return;
        store.clearLogs();
        refresh();
    });

    wall.querySelector('[data-act="export"]')?.addEventListener('click', () => {
        const fmt = wall.querySelector('[data-s="__fmt"]').value;
        const name = getContext().name2 || 'diary';
        let blob, ext;
        if (fmt === 'md') {
            const body = store.sortedEntries().map(e => `## ${e.date}　${e.title}\n\n${e.text}\n`).join('\n---\n\n');
            blob = new Blob([`# ${name} 的日记\n\n${body}`], { type: 'text/markdown' });
            ext = 'md';
        } else {
            blob = new Blob([JSON.stringify(store.data(), null, 2)], { type: 'application/json' });
            ext = 'json';
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${name}-日记.${ext}`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    wall.querySelector('[data-act="import"]')?.addEventListener('click', () => {
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
                    if (clash && !confirm(`${e.date} 已经有一张「${clash.title}」。\n用导入的这张覆盖吗？`)) {
                        skipped++; continue;
                    }
                    if (clash) store.removeEntry(clash.id);
                    store.addEntry({ ...e, id: store.newId() });
                    added++;
                }
                Object.assign(d.marks, incoming.marks || {});
                store.save();
                await store.saveChatFile();
                toast(`导入 ${added} 张${skipped ? `，跳过 ${skipped} 张` : ''}`);
                refresh();
            } catch (e) { toast('文件读不了：' + e.message, true); }
        });
        inp.click();
    });
}

export { toast as notify };
