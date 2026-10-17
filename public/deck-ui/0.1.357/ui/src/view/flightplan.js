// Flightplan (contract/flightplan.md): the Todos view (the lists rail, quick add with flightplan's parse as its live preview and its
// ask-back choices, Needs you, Overdue, Today, Upcoming by day, done today folded; each row's check and snooze) and Board (epics with
// done-of-total and a status bar, area chips, six columns: one at a time on a phone, a drag between them on a desktop; a card's drawer
// with its status and history). Every row is a title and one meta line; a row's title opens the drawer, the only place notes show
// (clamped, with More). The layout is the view's own, whatever page or panel mounts it. The rows, chips, buttons, drawer, facts, failures and placeholders are Deck's own (rows.js, drawer.js,
// failure.js, base.css); what is new is the board's columns, the epic cards, the snooze menu and the undo toast.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {ATTENTION, COLLAPSED, STATUSES, asksAction, createFlightplan, sourceOf, describeRepeat, dueText, historyOf, listDot, longDay, metaOf, needOf, prUrl, refOf, refUrl, snoozeChoices, statusLabel, whenText} from '../flightplan.js';
import {Drawer, Facts} from './drawer.js';
import {Failure} from './failure.js';
import {Block, Placeholders} from './rows.js';
import {ShellBar} from './shell-bar.js';
const html = htm.bind(h);

/** Redraws on every model change. */
function useModel(fp) {
  const [, redraw] = useState(0);
  useEffect(() => fp.subscribe(() => redraw(n => n + 1)), [fp]);
}

const open = (host, url) => ev => { ev?.preventDefault?.(); if (url) host.call('url.open', {url}).catch(() => {}); };

/** A row's one meta line: quiet words, a dot between them. */
function Meta({facts}) {
  return facts.length ? html`<span class="df-meta">${facts.map(f => html`<span class=${`df-m-${f.kind}`}>${f.text}</span>`)}</span>` : null;
}

function SnoozeMenu({fp, item, clock}) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const away = ev => { if (!ref.current?.contains(ev.target) && !ev.target.closest?.('.df-snz')) fp.openSnooze(item); };
    const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); fp.openSnooze(item); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
  }, [item.id]);
  return html`<div class="df-menu" role="menu" aria-label="Snooze until" ref=${ref}>${snoozeChoices(clock()).map(c => html`
    <button type="button" role="menuitem" data-snooze=${c.key} onClick=${() => fp.snooze(item, c)}>${c.label}<span>${c.hint}</span></button>`)}</div>`;
}

/** A row's title: one line, ellipsized; a click opens the item's drawer (its notes, history and status). */
const Title = ({fp, item}) => html`<button type="button" class="dp-title df-tt" title=${item.title} onClick=${() => fp.open(item)}>${item.title}</button>`;

function TodoRow({fp, item, clock, showList, done = false}) {
  const busy = fp.busy.has(item.id);
  return html`<div class=${`dp-row df-row${done ? ' done' : ''}`} role="listitem" data-id=${item.id} aria-busy=${busy ? 'true' : null}>
    <button type="button" class="df-check" disabled=${busy} aria-label=${`${done ? 'Mark open' : 'Done'}: ${item.title}`}
      onClick=${() => (done ? fp.reopen(item) : fp.done(item))}><${Glyph} name="check" size=${12} /></button>
    <span class="dp-lines"><${Title} fp=${fp} item=${item} /><${Meta} facts=${metaOf(item, fp.date, {lists: fp.lists, showList})} /></span>
    <span class="dp-end df-acts">${done ? null : html`<${Snooze} fp=${fp} item=${item} busy=${busy} />`}</span>
    ${fp.snoozing === item.id ? html`<${SnoozeMenu} fp=${fp} item=${item} clock=${clock} />` : null}
  </div>`;
}

/** Snooze: an icon, shown on hover or focus (always without a mouse). */
const Snooze = ({fp, item, busy}) => html`<button type="button" class="dk-btn df-snz" aria-haspopup="menu" aria-label=${`Snooze: ${item.title}`}
  aria-expanded=${fp.snoozing === item.id ? 'true' : 'false'} disabled=${busy} onClick=${() => fp.openSnooze(item)}><${Glyph} name="recent" size=${14} /></button>`;

/** A backend need in Needs you (Attention's actions: a page to open, its backend's need op, a command to copy): no check, its one
 *  button; the meta line its source and detail (a command: the command itself). */
function NeedRow({fp, item, clock}) {
  const {detail, action} = needOf(item), busy = fp.busy.has(item.id);
  return html`<div class="dp-row df-row df-need" role="listitem" data-need=${item.id} aria-busy=${busy ? 'true' : null}>
    <span class="dp-lines"><${Title} fp=${fp} item=${item} /><span class="df-meta"><span>${sourceOf(item)}</span>${action.kind === 'command'
      ? html`<code class="df-cmd">${action.command}</code>` : detail ? html`<span>${detail}</span>` : null}</span></span>
    <span class="dp-end df-need-acts"><span class="df-acts"><${Snooze} fp=${fp} item=${item} busy=${busy} /></span>
      <button type="button" class="dk-btn df-go" data-action=${action.kind} disabled=${busy} onClick=${() => fp.act(item)}>${action.label}</button></span>
    ${fp.snoozing === item.id ? html`<${SnoozeMenu} fp=${fp} item=${item} clock=${clock} />` : null}
  </div>`;
}

function Section({label, count, tone, id, children}) {
  return html`<section class="df-sec" aria-label=${label} id=${id ?? null}><h3 class=${`df-sech${tone ? ` ${tone}` : ''}`}><span class="dk-label">${label}</span><span class="df-count">${count}</span></h3>${children}</section>`;
}
const Rows = ({children}) => html`<div class="dp-rows dp-plain df-rows" role="list">${children}</div>`;

function Capture({fp}) {
  const c = fp.capture, p = c.preview?.for === c.text.trim() ? c.preview : null, ask = c.choices ?? p?.ambiguous?.[0] ?? null;
  const landing = fp.lists.find(l => l.slug === fp.landing());
  return html`<form class="df-add" autocomplete="off" onSubmit=${ev => { ev.preventDefault(); fp.add(); }}>
    <div class="df-add-row"><span class="df-plus" aria-hidden="true">+</span>
      <input class="df-input" value=${c.text} aria-label="Add a todo" placeholder="Add a todo: try “call plumber friday at 5” or “water plants every sunday”"
        onInput=${ev => fp.type(ev.currentTarget.value)} />
      <button type="submit" class="dk-btn main" disabled=${!c.text.trim() || c.busy || !!ask}>Add</button></div>
    ${c.text.trim() ? html`<div class="df-parse" aria-live="polite">
      ${p ? html`<span class="df-pchip">${p.title || '(no title yet)'}</span>
        ${p.due && !ask ? html`<span class="df-pchip due">${dueText(p.due, fp.date)}</span>` : null}
        ${p.repeat ? html`<span class="df-pchip rep">↻ ${describeRepeat(p.repeat)}</span>` : null}
        ${p.remind ? html`<span class="df-pchip">Reminds ${whenText(p.remind)}</span>` : null}` : null}
      <span class="df-pchip"><span class=${`dp-dot dot-${listDot(fp.lists, fp.landing())}`} aria-hidden="true"></span>${landing?.title ?? fp.landing()}</span>
      ${ask ? html`<div class="df-ask" role="group" aria-label="Which one?"><p>“${ask.text}” reads two ways. Which one?</p>
        <div>${ask.choices.map(ch => html`<button type="button" class="dk-btn" disabled=${c.busy} onClick=${() => fp.add(ch)}>${ch.label}</button>`)}</div></div>` : null}
      ${c.error ? html`<p class="df-err" role="alert">${c.error}</p>` : null}
    </div>` : null}
  </form>`;
}

function Todos({fp, host, clock}) {
  const rail = fp.rail(), current = rail.find(l => l.slug === fp.list), s = fp.sections(), all = fp.list === 'all';
  const row = (item, done) => html`<${TodoRow} key=${item.id} fp=${fp} item=${item} clock=${clock} showList=${all} done=${done} />`;
  let body;
  if (fp.loading) body = html`<div aria-busy="true" class="df-rows dp-rows"><${Placeholders} n=${5} /></div>`;
  else if (all) {
    const empty = !s.needs.length && !s.overdue.length && !s.today.length && !s.upcoming.length;
    body = html`
      ${s.needs.length ? html`<${Section} label="Needs you" id="needs" count=${s.needs.length} tone="warn"><${Rows}>${s.needs.map(item => asksAction(item) ? html`<${NeedRow} key=${item.id} fp=${fp} item=${item} clock=${clock} />` : row(item))}<//><//>` : null}
      ${s.overdue.length ? html`<${Section} label="Overdue" count=${s.overdue.length} tone="bad"><${Rows}>${s.overdue.map(i => row(i))}<//><//>` : null}
      ${s.today.length ? html`<${Section} label="Today" count=${s.today.length}><${Rows}>${s.today.map(i => row(i))}<//><//>` : null}
      ${s.upcoming.length ? html`<${Section} label="Upcoming" count=${`${s.upcomingCount} in the next 14 days`}>${s.upcoming.map(g => html`<div class="df-day" key=${g.day}>
        <div class="df-dayh">${g.label}</div><${Rows}>${g.items.map(i => row(i))}<//></div>`)}<//>` : null}
      ${empty ? html`<${Block} b=${{glyph: 'check', title: 'Nothing due', line: 'Nothing needs you, nothing is due in the next 14 days.'}} />` : null}`;
  } else {
    body = html`${s.items.length ? html`<${Rows}>${s.items.map(i => row(i))}<//>`
      : html`<${Block} b=${{glyph: 'check', title: `Nothing on ${current?.title ?? fp.list}`, line: 'Add one above; it lands here.'}} />`}`;
  }
  return html`<div class="df-todos">
    <nav class="df-rail" aria-label="Lists">
      <div class="dk-label">Flightplan</div>
      ${rail.map((l, i) => html`${i === 1 ? html`<hr /><div class="dk-label">Lists</div>` : null}<button type="button" key=${l.slug} aria-pressed=${String(fp.list === l.slug)} onClick=${() => fp.setList(l.slug)}>
        ${l.dot ? html`<span class=${`dp-dot dot-${l.dot}`} aria-hidden="true"></span>` : html`<${Glyph} name="recent" size=${14} />`}<span class="df-rail-t">${l.title}</span><span class="df-n">${l.n}</span></button>`)}
    </nav>
    <div class="df-col">
      <div class="df-title"><h2>${all ? 'Today' : current?.title ?? fp.list}</h2><span>${all ? longDay(fp.date) : `${s.items.length} open`}</span></div>
      <div class="df-listchips" role="group" aria-label="Lists">${rail.map(l => html`<button type="button" key=${l.slug} class=${`dk-chip${fp.list === l.slug ? ' on' : ''}`} aria-pressed=${String(fp.list === l.slug)}
        onClick=${() => fp.setList(l.slug)}><span>${l.short} ${l.n}</span></button>`)}</div>
      <${Capture} fp=${fp} />
      ${fp.error ? html`<${Failure} backend="flightplan" error=${fp.error} retry=${() => fp.refresh()} host=${host} />` : body}
      ${!fp.loading && s.done.length ? html`<button type="button" class="dk-btn text df-fold" aria-expanded=${String(fp.showDone)} onClick=${() => fp.toggleDone()}>${fp.showDone ? 'Hide' : 'Show'} ${s.done.length} done today</button>
        ${fp.showDone ? html`<${Section} label="Done today" count=${s.done.length}><${Rows}>${s.done.map(i => row(i, true))}<//><//>` : null}` : null}
    </div>
  </div>`;
}

const CHIP = {pr: 'ok', blocked: 'muted', stuck: 'bad'};
/** An epic's name on a card, short. */
const shortName = t => (t.length > 28 ? `${t.slice(0, 27).trimEnd()}…` : t);
/** A card: its reference (and its epic's short name while no epic filters), its title, at most one chip. */
function Card({fp, task, draggable}) {
  const epic = fp.epic == null ? fp.epicOf(task) : null, chips = fp.chips(task);
  return html`<div class=${`df-card st-${task.status}`} role="button" tabindex="0" data-id=${task.id} draggable=${draggable ? 'true' : 'false'}
    aria-label=${`${refOf(task)}: ${task.title}, ${statusLabel(task.status)}`}
    onClick=${() => fp.open(task)} onKeyDown=${ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fp.open(task); } }}
    onDragStart=${ev => { ev.dataTransfer.setData('text/plain', String(task.id)); ev.dataTransfer.effectAllowed = 'move'; ev.currentTarget.classList.add('dragging'); }}
    onDragEnd=${ev => { ev.currentTarget.classList.remove('dragging'); fp.setOver(null); }}>
    <div class="df-cardh"><span class="df-ref">${refOf(task)}</span>${epic ? html`<span class="df-epicname" title=${epic.title}>${shortName(epic.title)}</span>` : null}</div>
    <div class="df-card-t">${task.title}</div>
    ${chips.length ? html`<div class="df-chips">${chips.map(c => html`<span class=${`dp-note df-chip ${CHIP[c.kind]}`} data-chip=${c.kind}>${c.text}</span>`)}</div>` : null}
  </div>`;
}

function Epic({fp, e}) {
  const on = fp.epic === e.epic.id, pct = e.total ? Math.round(e.done / e.total * 100) : 0;
  const attention = ATTENTION.filter(([k]) => e.counts[k]);
  return html`<div class=${`df-epic${on ? ' on' : ''}`} data-epic=${e.epic.id}>
    <button type="button" class="df-epic-t" aria-pressed=${String(on)} onClick=${() => fp.setEpic(e.epic.id)}><b>${e.epic.title}</b><span class="df-ref">${e.ref}</span></button>
    ${!e.total ? html`<div class="df-legend">Not split yet</div>` : html`<div class="df-frac">${e.done} of ${e.total} done <span>· ${pct}%</span></div>
    <div class="df-seg" role="group" aria-label=${`${e.epic.title} by status`}>${STATUSES.slice().reverse().filter(s => e.counts[s.k]).map(s => html`
      <button type="button" class=${`dot-${s.tone}`} style=${`flex-grow:${e.counts[s.k]}`} title=${`${s.label}: ${e.counts[s.k]}`} aria-label=${`${s.label}: ${e.counts[s.k]}`}
        onClick=${() => fp.setEpic(e.epic.id, s.k)}></button>`)}</div>
    <div class="df-legend">${attention.length ? attention.map(([k, tone, label]) => html`<span><span class=${`dp-dot dot-${tone}`} aria-hidden="true"></span>${e.counts[k]} ${label}</span>`) : html`<span>Nothing in flight</span>`}</div>`}
  </div>`;
}

/** Only the columns fit the viewport below the shell bar; epics remain in document flow. */
function useFit() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      const bar = document.querySelector('.ds-bar');
      const barHeight = Math.max(0, bar?.getBoundingClientRect().height ?? 0);
      const top = Math.max(barHeight, el.getBoundingClientRect().top);
      el.style.setProperty('--df-bar', `${barHeight}px`);
      el.style.scrollMarginTop = `${barHeight}px`;
      el.style.setProperty('--df-top', `${Math.max(0, Math.round(top))}px`);
    };
    fit();
    globalThis.addEventListener('resize', fit);
    globalThis.addEventListener('scroll', fit, {passive: true});
    return () => { globalThis.removeEventListener('resize', fit); globalThis.removeEventListener('scroll', fit); };
  });
  return ref;
}

function Board({fp, host, wide}) {
  const b = fp.board, fit = useFit();
  const [allEpics, setAllEpics] = useState(false), [doneEpics, setDoneEpics] = useState(false);
  const [epicLimit, setEpicLimit] = useState(10);
  useEffect(() => {
    const el = fit.current;
    if (!el) return undefined;
    const measure = () => setEpicLimit(Math.max(1, Math.floor((el.clientWidth + 10) / 250)) * 2);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [b.loaded]);
  if (b.error) return html`<${Failure} backend="flightplan" error=${b.error} retry=${() => fp.refreshBoard()} host=${host} />`;
  if (b.loading && !b.loaded) return html`<div aria-busy="true" class="dp-rows"><${Placeholders} n=${4} /></div>`;
  const cols = fp.columns(), progress = fp.epics();
  const complete = e => e.epic.status === 'done' || e.total > 0 && e.done === e.total;
  const finished = progress.filter(complete), epics = progress.filter(e => !complete(e) || doneEpics);
  const drop = k => ev => { ev.preventDefault(); fp.setOver(null); const t = b.tasks.find(x => String(x.id) === ev.dataTransfer.getData('text/plain')); fp.move(t, k); };
  return html`<div class="df-board">
    <div class="df-board-h"><h2 class="dk-sr">Board</h2><div class="df-filters" role="group" aria-label="Area">${fp.areas().map(a => html`<button type="button" key=${a}
      class=${`dk-chip${fp.area === a ? ' on' : ''}`} aria-pressed=${String(fp.area === a)} onClick=${() => fp.setArea(a)}><span>${a}</span></button>`)}</div></div>
    ${epics.length ? html`<div class="df-epics">${(allEpics ? epics : epics.slice(0, epicLimit)).map(e => html`<${Epic} key=${e.epic.id} fp=${fp} e=${e} />`)}</div>` : null}
    <div class="df-epic-controls">
      ${epics.length > epicLimit ? html`<button type="button" class="dk-btn text" aria-expanded=${String(allEpics)} onClick=${() => setAllEpics(!allEpics)}>${allEpics ? 'Show fewer epics' : `Show all ${epics.length} epics`}</button>` : null}
      ${finished.length ? html`<button type="button" class="dk-btn text" aria-expanded=${String(doneEpics)} onClick=${() => { setDoneEpics(!doneEpics); setAllEpics(true); }}>${finished.length} done</button>` : null}
    </div>
    <div class="df-colpick" role="group" aria-label="Column">${cols.map(c => html`<button type="button" key=${c.k} class=${`dk-chip${fp.column === c.k ? ' on' : ''}`}
      aria-pressed=${String(fp.column === c.k)} onClick=${() => fp.setColumn(c.k)}><span class=${`dp-dot dot-${c.tone}`} aria-hidden="true"></span><span>${c.label}</span><span class="df-n">${c.all.length}</span></button>`)}</div>
    <div class="df-cols" ref=${fit}>${cols.map(c => html`<div key=${c.k} class=${`df-bcol${fp.column === c.k ? ' shown' : ''}${fp.over === c.k ? ' over' : ''}`} data-status=${c.k} aria-label=${c.label}
      onDragOver=${wide ? ev => { ev.preventDefault(); fp.setOver(c.k); } : null} onDragLeave=${wide ? ev => { if (!ev.currentTarget.contains(ev.relatedTarget)) fp.setOver(null); } : null} onDrop=${wide ? drop(c.k) : null}>
      <div class="df-bcol-h"><span class=${`dp-dot dot-${c.tone}`} aria-hidden="true"></span><span class="dk-label">${c.label}</span><span class="df-n">${c.all.length}</span></div>
      <div class="df-bcards">${c.cards.map(t => html`<${Card} key=${t.id} fp=${fp} task=${t} draggable=${wide} />`)}
        ${!c.all.length ? html`<div class="df-empty">Empty</div>` : null}
        ${c.hidden || fp.expanded.has(c.k) && (COLLAPSED[c.k] ?? c.all.length) < c.all.length ? html`<button type="button" class="dk-btn text df-showall" aria-expanded=${String(fp.expanded.has(c.k))}
          onClick=${() => fp.toggleColumn(c.k)}>${fp.expanded.has(c.k) ? 'Show fewer' : c.cards.length ? `Show all ${c.all.length}` : `Show ${c.all.length} done`}</button>` : null}</div>
    </div>`)}</div>
  </div>`;
}

/** An item's notes in the drawer: clamped to a few lines, More shows the rest. */
function Notes({text, label}) {
  const [all, setAll] = useState(false), long = text.length > 280 || text.split('\n').length > 5;
  useEffect(() => setAll(false), [text]);
  return html`<section class="df-notes" aria-label=${label}><h3 class="dk-label">${label}</h3>
    <p class=${`df-notes-t${long && !all ? ' clamp' : ''}`}>${text}</p>
    ${long ? html`<button type="button" class="dk-btn text df-more" aria-expanded=${String(all)} onClick=${() => setAll(!all)}>${all ? 'Less' : 'More'}</button>` : null}</section>`;
}

function Detail({fp, host}) {
  const d = fp.drawer, t = d?.item, epic = t ? fp.epicOf(t) : null, ref = t ? refUrl(t) : null;
  const link = (url, text) => url ? html`<a href=${url} onClick=${open(host, url)}>${text}</a>` : text;
  const byId = new Map(fp.board.tasks.map(x => [x.id, x]));
  return html`<${Drawer} open=${!!t} title=${t?.title ?? ''} sub=${t ? `${refOf(t)} · ${statusLabel(t.status)}` : null} onClose=${() => fp.close()} label=${t?.title ?? 'Item'}>
    ${t ? html`<div class="df-detail">
      <label class="df-field"><span>Status</span><select class="dk-field" aria-label="Status" value=${t.status} onChange=${ev => fp.move(t, ev.currentTarget.value)}>
        ${STATUSES.map(s => html`<option value=${s.k} selected=${s.k === t.status}>${s.label}</option>`)}</select></label>
      <${Facts} facts=${[
        ...(t.due ? [{label: 'Due', value: dueText(t.due, fp.date)}] : []),
        ...(t.repeat ? [{label: 'Repeats', value: describeRepeat(t.repeat)}] : []),
        ...(t.priority ? [{label: 'Priority', value: t.priority}] : []),
        ...(t.list ? [{label: 'List', value: fp.lists.find(l => l.slug === t.list)?.title ?? t.list}] : []),
        ...(epic ? [{label: 'Epic', value: `${epic.title} · ${refOf(epic)}`}] : []),
        ...(t.area ? [{label: 'Area', value: t.area}] : []),
        ...(t.repo ? [{label: 'Repo', value: t.repo}] : []),
        ...(t.labels?.length ? [{label: 'Labels', value: t.labels.join(', ')}] : []),
        ...(ref ? [{label: 'Link', value: link(ref, refOf(t))}] : []),
        ...(t.links ?? []).filter(l => l.type === 'pr').map(l => ({label: 'PR', value: link(prUrl(l), l.ref)})),
        ...(t.blockedBy ?? []).map(b => ({label: 'Blocked by', value: byId.get(b) ? `${refOf(byId.get(b))} (${byId.get(b).status === 'done' ? 'done' : 'open'})` : `#${b}`})),
      ]} />
      ${t.notes ? html`<${Notes} text=${t.notes} label=${t.status === 'stuck' ? 'Why stuck' : t.status === 'needs-you' ? 'What to do' : 'Notes'} />` : null}
      <h3 class="dk-label df-hist">History</h3>
      ${d.error ? html`<${Failure} backend="flightplan" error=${d.error} retry=${() => fp.open(t)} host=${host} />`
        : !d.events ? html`<p class="df-muted" role="status">Loading history…</p>`
        : html`<ul class="df-events">${historyOf(d.events).map((e, i) => html`<li key=${i} class=${e.owner ? 'owner' : ''}><div>${e.what}</div><div class="df-when">${whenText(e.at)} · ${e.by}</div></li>`)}</ul>`}
    </div>` : null}
  <//>`;
}

function Toast({fp}) {
  const t = fp.toast;
  return html`<div class=${`df-toast${t ? ' on' : ''}${t?.bad ? ' bad' : ''}`} role="status">${t ? html`<span>${t.text}</span>${t.undo ? html`<button type="button" class="dk-btn text" onClick=${() => fp.undo()}>Undo</button>` : null}${t.signIn ? html`<button type="button" class="dk-btn text" onClick=${() => fp.signIn()}>Sign in to save</button>` : null}` : null}</div>`;
}

/** Whether the screen is wide enough for six columns and a drag between them (as the CSS's 1100 px). */
function useWide() {
  const q = globalThis.matchMedia?.('(min-width: 1100px) and (hover: hover)');
  const [wide, setWide] = useState(!!q?.matches);
  useEffect(() => { if (!q) return undefined; const f = () => setWide(q.matches); q.addEventListener?.('change', f); return () => q.removeEventListener?.('change', f); }, []);
  return wide;
}

/** Flightplan: opts `nav`, `brand`, `current` (the nav bar, on its own page), `clock`. */
export function Flightplan({model: fp, host, opts = {}}) {
  useModel(fp);
  const wide = useWide(), clock = opts.clock ?? Date.now;
  const bar = opts.nav ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} backends=${host.backends ?? []} current=${opts.current ?? 'flightplan'} />` : null;
  return html`<div class="df-page">${bar}<main class="df" aria-label="Flightplan">
    <header class="df-head"><h1>Flightplan</h1>
      <div class="df-tabs" role="tablist" aria-label="View">${[['todos', 'Todos'], ['board', 'Board']].map(([k, label]) => html`<button type="button" role="tab" key=${k}
        aria-selected=${String(fp.tab === k)} onClick=${() => fp.setTab(k)}>${label}</button>`)}</div></header>
    ${fp.tab === 'todos' ? html`<${Todos} fp=${fp} host=${host} clock=${clock} />` : html`<${Board} fp=${fp} host=${host} wide=${wide} />`}
    <${Detail} fp=${fp} host=${host} />
  </main><${Toast} fp=${fp} /></div>`;
}

/** In the palette (`flightplan`, `todos`): Flightplan over the host's flightplan ops. */
export function PaletteFlightplan({host, opts}) {
  const [model] = useState(() => createFlightplan(host, {clock: opts?.clock}));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Flightplan} model=${model} host=${host} opts=${opts ?? {}} />`;
}
