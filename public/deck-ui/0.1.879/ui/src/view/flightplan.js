import {Changes} from './change.js';
import {todoPath} from '../flightplan-paths.js';
import {durationText} from '../quantity.js';
import {ago, countText, dateText, fieldLabel, joinText, plural} from '../format.js';
import {Button} from './controls.js';
import {PageHeader} from './page-header.js';
// Flightplan (contract/flightplan.md): the Todos view (the lists rail, quick add with flightplan's parse as its live preview and its
// ask-back choices, Needs you, Overdue, Today, Upcoming by day, done today folded; each row's check and snooze) and Board (epics with
// done-of-total and a status bar, area chips, six columns: one at a time on a phone, a drag between them on a desktop; a card's drawer
// with its status and history). Rows open the drawer for full Markdown notes, its way through the pipeline (its timeline's steps), related items and recorded agent sessions. The layout is the view's own, whatever page or panel mounts it. The rows, chips, buttons, drawer, facts, failures and placeholders are Deck's own (rows.js, drawer.js,
// failure.js, base.css); what is new is the board's columns and the epic cards (the snooze menu, chips and toast: menu.js, chip-group.js, toast.js).
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useId, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {ATTENTION, BOARD_BATCH, BOARD_DONE_DAYS, STATUSES, asksAction, needDetail, createFlightplan, describeRepeat, dueText, historyOf, listDot, pipelineOf, metaOf, needOf, prUrl, refOf, refUrl, snoozeChoices, statusLabel, whenText} from '../flightplan.js';
import {Drawer, Facts} from './drawer.js';
import {Failure} from './page-state.js';
import {PageState, StateBlock} from './page-state.js';
import {ShellBar} from './shell-bar.js';
import {useFlightplanMotion} from './flightplan-motion.js';
import {Markdown, itemRefs} from './markdown.js';
import {Menu} from './menu.js';
import {ChipGroup} from './chip-group.js';
import {Toast as SharedToast} from './toast.js';
const html = htm.bind(h);

const open = (host, url) => ev => { ev?.preventDefault?.(); if (url) host.call('url.open', {url}).catch(() => {}); };

/** A row's one meta line: quiet words, a dot between them. */
function Meta({facts}) {
  return facts.length ? html`<span class="df-meta">${facts.map(f => html`<span class=${`df-m-${f.kind}`}>${f.text}</span>`)}</span>` : null;
}

/** Snooze's menu: when to bring the item back. */
const SnoozeMenu = ({fp, item, clock}) => html`<${Menu} class="df-menu" label="Snooze until" onClose=${() => { if (fp.snoozing === item.id) fp.openSnooze(item); }}
  items=${snoozeChoices(clock()).map(c => ({key: c.key, label: c.label, hint: c.hint, run: () => fp.snooze(item, c)}))} />`;

/** A row's title: one line, ellipsized; a click opens the item's drawer (its notes, history and status). */
const Title = ({fp, item}) => item.needSource && !item.needSource.item ? html`<span class="dp-title df-tt">${item.title}</span>` : html`<${Button} type="button" class="dp-title df-tt" title=${item.title} onClick=${() => fp.open(item)}>${item.title}</${Button}>`;
const TodoPriority = ({item}) => {
  const priority = item.priority ?? item.needSource?.item?.priority;
  return /^P[0-3]$/.test(priority ?? '') ? html`<span class=${`df-priority df-todo-priority p-${priority.toLowerCase()}`} aria-label=${`Priority ${priority}`}>${priority}</span>` : null;
};

function TodoRow({fp, item, clock, showList, done = false}) {
  const busy = fp.busy.has(item.id);
  return html`<div class=${`dp-row df-row${done ? ' done' : ''}`} role="listitem" data-id=${item.id} data-revision=${item.revision ?? null} aria-busy=${busy ? 'true' : null}>
    <${Button} type="button" class="df-check" disabled=${busy} aria-label=${`${done ? 'Mark open' : 'Done'}: ${item.title}`}
      onClick=${() => (done ? fp.reopen(item) : fp.done(item))}><${Glyph} name="check" size=${12} /></${Button}>
    <span class="dp-lines"><span class="df-task-heading"><${Title} fp=${fp} item=${item} /><${TodoPriority} item=${item} /></span><${Meta} facts=${metaOf(item, fp.date, {lists: fp.lists, showList}).filter(f => f.kind !== 'priority')} /></span>
    <span class="dp-end df-acts">${done ? null : html`<${Snooze} fp=${fp} item=${item} busy=${busy} />`}</span>
    ${fp.snoozing === item.id ? html`<${SnoozeMenu} fp=${fp} item=${item} clock=${clock} />` : null}
  </div>`;
}

/** Snooze: an icon, shown on hover or focus (always without a mouse). */
const Snooze = ({fp, item, busy}) => html`<${Button} type="button" class="dk-btn df-snz" aria-haspopup="menu" aria-label=${`Snooze: ${item.title}`}
  aria-expanded=${fp.snoozing === item.id ? 'true' : 'false'} disabled=${busy} onClick=${ev => { ev.currentTarget.focus({preventScroll: true}); fp.openSnooze(item); }}><${Glyph} name="recent" size=${14} /></${Button}>`;

/** Agent replies are saved by Flightplan for coordinator delivery. */
function Question({fp, item, host}) {
  const [text, setText] = useState(''), busy = fp.busy.has(item.id);
  const options = item.question.options ?? [], full = item.question.text;
  // Some requests repeat their exact structured choices as a trailing bullet list. Keep the original available.
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const repeated = options.length ? new RegExp(`\\s*[-*•]\\s*${options.map(escape).join('\\s*[-*•]\\s*')}\\s*$`, 'u') : null;
  const prompt = repeated ? full.replace(repeated, '').trim() || full : full;
  return html`<form class="df-question" aria-label="Reply to agent" aria-busy=${busy} onSubmit=${async ev => {
    ev.preventDefault();
    if (text.trim() && await fp.answer(item, {text: text.trim()})) setText('');
  }}>
    <div class="df-question-prompt df-notes-t"><${Markdown} text=${prompt} host=${host} repo=${item.repo} onItem=${id => fp.openRelated(id)} itemHref=${fp.itemHref} /></div>
    ${options.length ? html`<div class="df-question-choices" role="group" aria-label="Choose a reply">${options.map(option => html`<${Button} type="button" class="dk-btn df-choice" disabled=${busy}
      onClick=${() => fp.answer(item, {option})}>${option}</${Button}>`)}</div>` : null}
    ${prompt !== full ? html`<details class="df-question-original"><summary>Original request</summary><div class="df-notes-t"><${Markdown} text=${full} host=${host} repo=${item.repo} onItem=${id => fp.openRelated(id)} itemHref=${fp.itemHref} /></div></details>` : null}
    <div class="df-reply"><label class="df-field"><span>Your reply</span><textarea class="dk-field" rows="3" maxlength="4000" value=${text} disabled=${busy} placeholder="Write a reply in your own words…"
      onInput=${ev => setText(ev.currentTarget.value)} /></label>
    <${Button} type="submit" class="dk-btn main" disabled=${busy || !text.trim()}>${busy ? 'Sending…' : 'Send reply'}</${Button}></div>
  </form>`;
}

function NeedRow({fp, item, clock, host}) {
  const {detail, action} = needOf(item), busy = fp.busy.has(item.id), q = !!item.question;
  // A need reads as its problem, never the page that sent it; a question's reply form takes the card's whole width, its snooze in the heading.
  const meta = [item.due ? dueText(item.due, fp.date) : null, q ? null : needDetail(detail)].filter(Boolean);
  const acts = html`<span class="dp-end df-need-acts"><span class="df-acts">${!item.needSource || item.needSource.item ? html`<${Snooze} fp=${fp} item=${item} busy=${busy} />` : null}</span>
      ${!q && action.kind !== 'command' ? html`<${Button} type="button" class="dk-btn df-go" data-action=${action.kind} disabled=${busy} onClick=${() => fp.act(item)}>${action.label}</${Button}>` : null}</span>`;
  return html`<div class=${`dp-row df-row df-need${q ? ' df-need-question' : ''}`} role="listitem" data-need=${item.id} data-revision=${item.revision ?? item.needSource?.item?.revision ?? null} aria-busy=${busy ? 'true' : null}>
    <div class="dp-lines"><div class="df-task-heading"><${Title} fp=${fp} item=${item} /><${TodoPriority} item=${item} />${q ? acts : null}</div>${q ? html`<${Question} key=${item.revision} fp=${fp} item=${item} host=${host} />` : null}${meta.length ? html`<span class="df-meta">${meta.map(m => html`<span>${m}</span>`)}</span>` : null}
      ${action.kind === 'command' ? html`<details class="df-instructions"><summary>Instructions</summary><div><code class="df-cmd">${action.command}</code>
        <${Button} type="button" class="dk-btn" disabled=${busy} onClick=${() => fp.act(item)}>Copy instructions</${Button}></div></details>` : null}</div>
    ${q ? null : acts}
    ${fp.snoozing === item.id ? html`<${SnoozeMenu} fp=${fp} item=${item} clock=${clock} />` : null}
  </div>`;
}

function Section({label, count, tone, id, className = '', children}) {
  return html`<section class=${`df-sec${className ? ` ${className}` : ''}`} aria-label=${label} ...${id ? {id} : {}}><h3 class=${`df-sech${tone ? ` ${tone}` : ''}`}><span class="dk-label">${label}</span><span class="df-count">${count}</span></h3>${children}</section>`;
}
const Rows = ({children}) => html`<div class="dp-rows dp-plain df-rows" role="list">${children}</div>`;

function Capture({fp}) {
  const c = fp.capture, p = c.preview?.for === c.text.trim() ? c.preview : null, ask = c.choices ?? p?.ambiguous?.[0] ?? null;
  const landing = fp.lists.find(l => l.slug === fp.landing());
  return html`<form class="df-add" aria-busy=${c.busy} aria-label="New todo" autocomplete="off" onSubmit=${ev => { ev.preventDefault(); fp.add(); }}>
    <div class="df-add-row"><span class="df-plus" aria-hidden="true">+</span>
      <input class="df-input" disabled=${c.busy} value=${c.text} aria-label="Add a todo" placeholder="What needs doing?"
        onInput=${ev => fp.type(ev.currentTarget.value)} />
      <${Button} type="submit" class="dk-btn main" disabled=${!c.text.trim() || c.busy || !!ask}>${c.busy ? 'Adding…' : 'Add'}</${Button}></div>
    ${!c.text.trim() ? html`<p class="df-capture-hint">Add a date or repeat, like “call plumber Friday at 5”.</p>` : null}
    ${c.text.trim() ? html`<div class="df-parse" aria-live="polite">
      ${p ? html`<span class="df-pchip">${p.title || '(no title yet)'}</span>
        ${p.due && !ask ? html`<span class="df-pchip due">${dueText(p.due, fp.date)}</span>` : null}
        ${p.repeat ? html`<span class="df-pchip rep">↻ ${describeRepeat(p.repeat)}</span>` : null}
        ${p.remind ? html`<span class="df-pchip">Reminds ${whenText(p.remind)}</span>` : null}` : null}
      <span class="df-pchip"><span class=${`dp-dot dot-${listDot(fp.lists, fp.landing())}`} aria-hidden="true"></span>${landing?.title ?? fp.landing()}</span>
      ${ask ? html`<div class="df-ask" role="group" aria-label="Which one?"><p>“${ask.text}” reads two ways. Which one?</p>
        <div>${ask.choices.map(ch => html`<${Button} type="button" class="dk-btn" disabled=${c.busy} onClick=${() => fp.add(ch)}>${ch.label}</${Button}>`)}</div></div>` : null}
      ${c.error ? html`<p class="df-err" role="alert">${c.error}</p>` : null}
    </div>` : null}
  </form>`;
}

/** A row: a backend need's (no Flightplan item behind it) its need row, else a todo's. */
const rowOf = ({fp, host, clock, showList}) => (item, done) => item.needSource && !item.needSource.item ? html`<${NeedRow} key=${item.id} fp=${fp} item=${item} clock=${clock} host=${host} />`
  : html`<${TodoRow} key=${item.id} fp=${fp} item=${item} clock=${clock} showList=${showList} done=${done} />`;
/** A Needs you item: one that asks for an action (a page, an op, a reply) as its need row, else its row. */
const needRowOf = props => (row => item => asksAction(item) ? html`<${NeedRow} key=${item.id} fp=${props.fp} item=${item} clock=${props.clock} host=${props.host} />` : row(item))(rowOf(props));

function Todos({fp, host, clock}) {
  const rail = fp.rail(), current = rail.find(l => l.slug === fp.list), s = fp.sections(), all = fp.list === 'all';
  const row = rowOf({fp, host, clock, showList: all}), needRow = needRowOf({fp, host, clock, showList: all});
  // a list opened by its URL shows its chip, wherever the scrolled chip row puts it
  const chips = useRef(null);
  useLayoutEffect(() => { const on = chips.current?.querySelector('[aria-pressed="true"]'); if (on && chips.current.scrollWidth > chips.current.clientWidth) chips.current.scrollLeft = Math.max(0, on.offsetLeft - chips.current.offsetLeft - 16); }, [fp.list, rail.length]);
  let body;
  if (fp.loading) body = html`<${PageState} state="loading" />`;
  else if (all) {
    const empty = !s.needs.length && !s.overdue.length && !s.today.length && !s.upcoming.length;
    body = html`
      ${(fp.needsFailures ?? []).map(failure => html`<${Failure} backend=${failure.backend} error=${failure.error} retry=${() => fp.needsSource.refresh({force: true})} />`)}
      ${s.needs.length ? html`<${Section} label="Needs you" id="needs" className="df-needs" count=${s.needs.length} tone="warn"><${Rows}>${s.needs.map(needRow)}<//><//>` : null}
      ${s.overdue.length ? html`<${Section} label="Overdue" count=${s.overdue.length} tone="bad"><${Rows}>${s.overdue.map(i => row(i))}<//><//>` : null}
      ${s.today.length ? html`<${Section} label="Today" count=${s.today.length}><${Rows}>${s.today.map(i => row(i))}<//><//>` : null}
      ${s.upcoming.length ? html`<${Section} label="Upcoming" count=${`${s.upcomingCount} in the next 14 days`}>${s.upcoming.map(g => html`<div class="df-day" key=${g.day}>
        <div class="df-dayh">${g.label}</div><${Rows}>${g.items.map(i => row(i))}<//></div>`)}<//>` : null}
      ${empty ? html`<${PageState} state="empty" hint="Nothing needs you, nothing is due in the next 14 days." />` : null}`;
  } else {
    body = html`${s.items.length ? html`<${Rows}>${s.items.map(i => row(i))}<//>`
      : html`<${PageState} state="empty" hint=${`Add a todo above to ${current?.title ?? fp.list}.`} />`}`;
  }
  return html`<div class="df-todos">
    <nav class="df-rail" aria-label="Lists">
      ${rail.map((l, i) => html`${i === 1 ? html`<hr /><div class="dk-label">Lists</div>` : null}<${Button} type="button" key=${l.slug} aria-pressed=${String(fp.list === l.slug)} onClick=${() => fp.setList(l.slug)}>
        ${l.dot ? html`<span class=${`dp-dot dot-${l.dot}`} aria-hidden="true"></span>` : html`<${Glyph} name="recent" size=${14} />`}<span class="df-rail-t">${l.title}</span>${fp.error ? null : html`<span class="df-n">${l.n}</span>`}</${Button}>`)}
    </nav>
    <div class="df-col">
      <div class="df-title"><div><h2>${all ? 'Today' : current?.title ?? fp.list}</h2></div><span>${all ? dateText(fp.date, {weekday: true, now: fp.date}) : `${countText(s.items.length)} open`}</span></div>
      <${ChipGroup} class="df-listchips" label="Lists" groupRef=${chips} value=${fp.list} onChange=${slug => fp.setList(slug)}
        options=${rail.map(l => ({value: l.slug, label: html`<span>${fp.error ? l.short : `${l.short} ${l.n}`}</span>`}))} />
      <${Capture} fp=${fp} />
      <${PageState} named=${true} title="Todos unavailable" backend="flightplan" error=${fp.error} retry=${() => fp.refresh()} host=${host}>${body}<//>
      ${!fp.loading && s.done.length ? html`<${Button} type="button" class="dk-btn text df-fold" aria-expanded=${String(fp.showDone)} onClick=${() => fp.toggleDone()}>${fp.showDone ? 'Hide' : 'Show'} ${s.done.length} done today</${Button}>
        ${fp.showDone ? html`<${Section} label="Done today" count=${s.done.length}><${Rows}>${s.done.map(i => row(i, true))}<//><//>` : null}` : null}
    </div>
  </div>`;
}

const CHIP = {pr: 'ok', blocked: 'muted', stuck: 'bad'};
/** A card: its reference (and its epic's short name while no epic filters), its title, at most one chip. */
function Card({fp, task, draggable}) {
  const epic = fp.epic == null ? fp.epicOf(task) : null, chips = fp.chips(task);
  return html`<div class=${`df-card st-${task.status}`} aria-busy=${fp.busy.has(task.id) ? 'true' : null} role="button" tabindex="0" data-id=${task.id} data-revision=${task.revision ?? null} draggable=${draggable ? 'true' : 'false'}
    aria-label=${`${refOf(task)}: ${task.title}, ${statusLabel(task.status)}`}
    onClick=${() => fp.open(task)} onKeyDown=${ev => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); fp.open(task); } }}
    onDragStart=${ev => { ev.dataTransfer.setData('text/plain', String(task.id)); ev.dataTransfer.effectAllowed = 'move'; ev.currentTarget.classList.add('dragging'); }}
    onDragEnd=${ev => { ev.currentTarget.classList.remove('dragging'); fp.setOver(null); }}>
    <div class="df-card-t">${task.title}</div>
    <div class="df-cardh"><span class="df-ref">${refOf(task)}</span>${task.priority ? html`<${Button} type="button" class=${`df-priority p-${task.priority.toLowerCase()}`} aria-label=${`Filter priority ${task.priority}`} onClick=${ev => { ev.stopPropagation(); fp.setPriority(task.priority); }}>${task.priority}</${Button}>` : null}</div>
    ${epic ? html`<span class="df-epicname" title=${epic.title}>${epic.title}</span>` : null}
    ${task.labels?.length ? html`<div class="df-card-labels">${task.labels.map(label => html`<${Button} type="button" class="df-label-chip" title=${label} aria-label=${`Filter label ${label}`} onClick=${ev => { ev.stopPropagation(); fp.setLabel(label); }}>${label}</${Button}>`)}</div>` : null}
    ${chips.length ? html`<div class="df-chips">${chips.map(c => html`<span class=${`dp-note df-chip ${CHIP[c.kind]}`} data-chip=${c.kind}>${c.text}</span>`)}</div>` : null}
  </div>`;
}

function Epic({fp, e}) {
  const on = fp.epic === e.epic.id, pct = e.total ? Math.round(e.done / e.total * 100) : 0;
  const attention = ATTENTION.filter(([k]) => e.counts[k]);
  return html`<div class=${`df-epic${on ? ' on' : ''}`} data-epic=${e.epic.id}>
    <${Button} type="button" class="df-epic-t" aria-pressed=${String(on)} onClick=${() => fp.setEpic(e.epic.id)}><b>${e.epic.title}</b><span class="df-ref">${e.ref}</span></${Button}>
    ${!e.total ? html`<div class="df-legend">Not split yet</div>` : html`<div class="df-frac">${e.done} of ${e.total} done <span>· ${pct}%</span></div>
    <div class="df-seg" role="group" aria-label=${`${e.epic.title} by status`}>${STATUSES.slice().reverse().filter(s => e.counts[s.k]).map(s => html`
      <${Button} type="button" class=${`dot-${s.tone}`} style=${`flex-grow:${e.counts[s.k]}`} title=${`${s.label}: ${e.counts[s.k]}`} aria-label=${`${s.label}: ${e.counts[s.k]}`}
        onClick=${() => fp.setEpic(e.epic.id, s.k)}></${Button}>`)}</div>
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
      // Keep drop targets stable while the browser scrolls an active drag into view.
      if (el.querySelector('.df-card.dragging')) return;
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

/** Search the backend's real projects; full titles and references remain readable. */
function ProjectPicker({fp, id, hidden}) {
  const [expanded, setExpanded] = useState(false), [query, setQuery] = useState(''), [completed, setCompleted] = useState(false);
  const root = useRef(null), search = useRef(null), trigger = useRef(null);
  const current = fp.epics().find(e => e.epic.id === fp.epic);
  const includeDone = completed || !!query.trim() || fp.column === 'done';
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const choices = fp.projects({completed: includeDone}).filter(e => terms.every(term =>
    `${e.epic.title} ${e.ref} ${e.epic.repo ?? ''} ${e.epic.area ?? ''}`.toLowerCase().includes(term)));
  const groups = new Map();
  for (const e of choices) {
    const key = `${e.verdict === 'done' ? 'Completed · ' : ''}${e.epic.repo ?? 'Without a repository'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const close = () => { setExpanded(false); trigger.current?.focus({preventScroll: true}); };
  const choose = project => { if (fp.epic !== project) fp.setEpic(project); close(); };
  useLayoutEffect(() => { if (expanded) search.current?.focus({preventScroll: true}); }, [expanded]);
  useEffect(() => {
    if (!expanded) return undefined;
    const away = ev => { if (!root.current?.contains(ev.target)) setExpanded(false); };
    const escape = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', escape, true); };
  }, [expanded]);
  const keys = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    const options = [...root.current.querySelectorAll('[role="option"]')], at = options.indexOf(ev.target);
    const next = {ArrowDown: at < 0 ? 0 : (at + 1) % options.length, ArrowUp: at < 0 ? options.length - 1 : (at + options.length - 1) % options.length,
      ...(at >= 0 ? {Home: 0, End: options.length - 1} : {})}[ev.key];
    if (next != null) { ev.preventDefault(); options[next]?.focus({preventScroll: true}); options[next]?.scrollIntoView({block: 'nearest'}); }
  };
  return html`<div class="df-project-chooser" id=${id} hidden=${hidden} ref=${root} onKeyDown=${keys}>
    <${Button} type="button" class="dk-field dk-select df-project-trigger" buttonRef=${trigger} aria-label="Choose project" aria-haspopup="listbox" aria-expanded=${expanded} aria-controls=${`${id}-options`}
      onClick=${() => { setExpanded(!expanded); setQuery(''); }}><span><span class="df-filter-label">Project</span><b>${current?.epic.title ?? 'All projects'}</b>${current ? html`<small>${current.ref}</small>` : null}</span></${Button}>
    ${expanded ? html`<div class="df-project-popover">
      <input class="dk-field" type="search" aria-label="Search projects" placeholder="Find a project, reference or repository" value=${query} ref=${search} onInput=${ev => setQuery(ev.currentTarget.value)} />
      <div class="df-project-options" id=${`${id}-options`} role="listbox" aria-label="Projects">
        <${Button} type="button" role="option" aria-selected=${fp.epic == null} tabindex=${fp.epic == null ? 0 : -1} class="df-project-option" onClick=${() => choose(null)}><b>All projects</b><span>Work across every project</span></${Button}>
        ${[...groups].map(([label, entries]) => html`<div role="group" aria-label=${label}><div class="df-project-group">${label}</div>${entries.map(e => html`<${Button} type="button" role="option" aria-selected=${fp.epic === e.epic.id} tabindex=${fp.epic === e.epic.id ? 0 : -1} class="df-project-option" onClick=${() => choose(e.epic.id)}>
          <b>${e.epic.title}</b><span>${joinText([e.ref, e.taskCount ? [plural(e.taskCount, 'task'), `${countText(e.done)} done`] : 'Not split yet'])}</span></${Button}>`)}</div>`)}
        ${!choices.length ? html`<p class="df-muted">No matching projects</p>` : null}
      </div>
      <${Button} type="button" class="dk-btn text df-completed-projects" aria-pressed=${completed} onClick=${ev => { ev.currentTarget.focus({preventScroll: true}); setCompleted(!completed); }}>${completed ? 'Hide completed projects' : 'Include completed projects'}</${Button}>
    </div>` : null}
  </div>`;
}

/** Each status owns its scroll sentinel; filters and live delivery keep the model's batches. */
function BoardColumn({fp, column: c, wide, several, drop}) {
  const sentinel = useRef(null), body = useRef(null), shown = fp.column === c.k;
  useEffect(() => {
    // Older done work loads on scroll only once Done holds a full batch: a short Done column would otherwise read the whole history at once.
    const more = c.hidden || c.older && !c.loadingOlder && c.cards.length >= BOARD_BATCH;
    if (!more || !sentinel.current || !wide && !several && !shown || !globalThis.IntersectionObserver) return undefined;
    const target = sentinel.current;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.unobserve(target);
      fp.loadMoreColumn(c.k);
    }, {root: wide ? body.current : null, rootMargin: '0px 0px 160px 0px'});
    observer.observe(target);
    return () => observer.disconnect();
  }, [c.k, c.hidden, c.older, c.loadingOlder, c.cards.length, wide, several, shown, fp.query, fp.priority, fp.label, fp.area, fp.epic]);
  return html`<div class=${`df-bcol${shown ? ' shown' : ''}${fp.over === c.k ? ' over' : ''}`} data-status=${c.k} aria-label=${c.label}
    onDragOver=${wide ? ev => { ev.preventDefault(); fp.setOver(c.k); } : null} onDragLeave=${wide ? ev => { if (!ev.currentTarget.contains(ev.relatedTarget)) fp.setOver(null); } : null} onDrop=${wide ? drop(c.k) : null}>
    <div class="df-bcol-h"><span class=${`dp-dot dot-${c.tone}`} aria-hidden="true"></span><span class="dk-label">${c.label}</span><span class="df-n">${c.all.length}</span></div>
    <div class="df-bcards" data-column=${c.k} ref=${body}>${c.cards.map(t => html`<${Card} key=${t.id} fp=${fp} task=${t} draggable=${wide} />`)}
      ${!c.all.length ? html`<${PageState} state="empty" hint=${`No ${c.label.toLowerCase()} items.`} />` : null}
      ${c.hidden ? html`<div class="df-load-more" data-column=${c.k} ref=${sentinel}><span class="df-muted">${c.cards.length} of ${c.all.length}</span><${Button} type="button" class="dk-btn text" onClick=${() => fp.loadMoreColumn(c.k)}>Load more ${c.label}</${Button}></div>`
        : c.older ? html`<div class="df-load-more" data-column=${c.k} ref=${sentinel}><span class="df-muted">Done in the last ${BOARD_DONE_DAYS} days</span><${Button} type="button" class="dk-btn text" disabled=${c.loadingOlder} onClick=${() => fp.loadMoreColumn(c.k)}>${c.loadingOlder ? 'Loading older Done…' : 'Load older Done'}</${Button}></div>` : null}
    </div>
  </div>`;
}

function BoardTools({fp, wide, filtersOpen, setFiltersOpen, filtersId, filterCount}) {
  return html`<div class="df-board-tools">
    <label class="df-work-search"><${Glyph} name="find" size=${16} /><input class="dk-field" type="search" aria-label="Search work" placeholder="Search work" value=${fp.query} onInput=${ev => fp.setQuery(ev.currentTarget.value)} /></label>
    ${!wide ? html`<${Button} type="button" class="dk-btn df-filter-toggle" aria-expanded=${filtersOpen} aria-controls=${`${filtersId}-project ${filtersId}-filters`} onClick=${() => setFiltersOpen(!filtersOpen)}>Filters${filterCount ? ` (${filterCount})` : ''}</${Button}>` : null}
    <${ProjectPicker} fp=${fp} id=${`${filtersId}-project`} hidden=${!wide && !filtersOpen} />
  </div>`;
}

function Board({fp, host, wide, filtersOpen, filtersId, filterCount}) {
  const b = fp.board, fit = useFit(), several = useMedia(SEVERAL);
  useEffect(() => {
    if (!b.loaded) return;
    const columns = fp.columns();
    if (!columns.find(column => column.k === fp.column)?.all.length) {
      const first = columns.find(column => column.all.length);
      if (first) fp.setColumn(first.k);
    }
  }, [b.loaded, fp.query, fp.area, fp.epic, fp.priority, fp.label]);
  if (b.error && !b.loaded) return html`<div class="df-board"><${PageState} named=${true} backend="flightplan" error=${b.error} retry=${() => fp.refreshBoard()} host=${host} /></div>`;
  if (b.loading && !b.loaded) return html`<div class="df-board"><${PageState} state="loading" /></div>`;
  const cols = fp.columns(), current = fp.epics().find(e => e.epic.id === fp.epic);
  const total = cols.reduce((n, c) => n + c.all.length, 0), count = status => cols.find(c => c.k === status)?.all.length ?? 0;
  const filtered = !!fp.query.trim() || !!filterCount;
  const clear = () => { fp.setQuery(''); fp.setArea('All'); fp.setEpic(null); fp.setPriority(''); fp.setLabel(''); };
  const drop = k => ev => { ev.preventDefault(); fp.setOver(null); const t = b.tasks.find(x => String(x.id) === ev.dataTransfer.getData('text/plain')); if (t) fp.move(t, k); };
  return html`<div class="df-board">
    <${PageState} named=${true} backend="flightplan" error=${b.error} retry=${() => fp.refreshBoard()} host=${host}>
    <div class="df-board-controls"><div class="df-board-filters" id=${`${filtersId}-filters`} hidden=${!wide && !filtersOpen}>
      <div class="df-filter-row"><span class="df-filter-label">Priority</span><${ChipGroup} class="df-filters" label="Priority" value=${fp.priority} onChange=${value => fp.setPriority(value)}
        options=${[['', 'All priorities'], ...fp.priorities().map(p => [p, p === 'none' ? 'No priority' : p])].map(([value, label]) => ({value, label, class: `df-priority-filter${value && value !== 'none' ? ` p-${value.toLowerCase()}` : ''}`}))} /></div>
      <div class="df-filter-row"><span class="df-filter-label">Area</span><${ChipGroup} class="df-filters" label="Area" value=${fp.area} onChange=${area => fp.setArea(area)} options=${fp.areas().map(area => ({value: area, label: area}))} /></div>
      <div class="df-filter-row"><label class="df-label-picker"><span class="df-filter-label">Label</span><select class="dk-field" aria-label="Label" value=${fp.label} onChange=${ev => fp.setLabel(ev.currentTarget.value)}><option value="">All labels</option>${fp.labels().map(label => html`<option value=${label}>${label}</option>`)}</select></label>
      ${filtered ? html`<${Button} type="button" class="dk-btn text df-clear" onClick=${clear}>Clear filters</${Button}>` : null}</div>
    </div><p class="df-summary" role="status">${filtered ? `${total} matching items` : `${total - count('done')} open · ${count('needs-you')} tasks need you · ${count('stuck')} stuck`}</p></div>
    ${current ? html`<section class="df-current-project" aria-label="Selected project"><${Epic} fp=${fp} e=${current} /></section>` : null}
    <${ChipGroup} class="df-colpick" label="Column" value=${fp.column} onChange=${k => fp.setColumn(k)}
      options=${cols.map(c => ({value: c.k, label: html`<span class=${`dp-dot dot-${c.tone}`} aria-hidden="true"></span><span>${c.label}</span><span class="df-n">${c.all.length}</span>`}))} />
    ${filtered && !total ? html`<${StateBlock} glyph="find" title="No matches" line="No work matches this search and these filters." action="Clear filters" onAction=${clear} />` : null}
    <div class="df-cols" ref=${fit} hidden=${filtered && !total}>${cols.map(c => html`<${BoardColumn} key=${c.k} fp=${fp} column=${c} wide=${wide} several=${several} drop=${drop} />`)}</div>
  <//></div>`;
}

/** Full Markdown notes; titles and metadata remain plain text. */
function Notes({text, label, repo, host, onItem, itemHref}) {
  return html`<section class="df-notes" aria-label=${label}><h3 class="dk-label">${label}</h3>
    <div class="df-notes-t"><${Markdown} text=${text} host=${host} repo=${repo} onItem=${onItem} itemHref=${itemHref} /></div></section>`;
}
const itemLink = l => l.url ?? (l.type === 'pr' ? prUrl(l) : l.type === 'issue' ? refUrl({links: [l]}) : l.type === 'sortie' ? `https://sortie.wang.team/v1/jobs/${l.ref.replace(/^sortie:/, '')}` : null);

function Related({fp, host}) {
  const related = fp.drawer?.related;
  if (!related) return null;
  const groups = [['Parent', related.parent ? [related.parent] : []], ['Children', related.children], ['Blocked by', related.blockedBy], ['Blocking', related.blocking]];
  if (!related.loading && !related.error && !groups.some(([, items]) => items?.length)) return null;
  return html`<section class="df-related" aria-label="Related items"><h3 class="dk-label">Related items</h3>
    ${related.loading ? html`<p class="df-muted" role="status">Loading related items…</p>` : null}
    ${related.error ? html`<${Failure} named=${true} backend="flightplan" error=${related.error} retry=${() => fp.openRelated(fp.drawer.item.id)} host=${host} />` : null}
    ${groups.filter(([, items]) => items?.length).map(([label, items]) => html`<div class="df-related-group"><h4>${label}</h4>${items.map(item => html`<a href=${fp.itemHref(item.id)} aria-label=${`Open related item ${refOf(item)}: ${item.title ?? `FP-${item.id}`}`} onClick=${ev => { ev.preventDefault(); fp.openRelated(item.id); }}><b>${item.title ?? `FP-${item.id}`}</b><span>${refOf(item)}${item.status ? ` · ${statusLabel(item.status)}` : ''}${item.missing ? ' · unavailable' : ''}</span><${Glyph} name="next" size=${14} /></a>`)}</div>`)}
  </section>`;
}

/** Where the item went through the pipeline (its timeline: the agent, the PR, the batch, merged, live) and how long each step took;
 *  the last line is where it is now. None until its first step. */
function Pipeline({fp, host}) {
  const steps = pipelineOf(fp.drawer?.timeline ?? []);
  if (!steps.length) return null;
  return html`<section class="df-related df-pipeline" aria-label="Pipeline"><h3 class="dk-label">Pipeline</h3>
    <ol class="df-steps">${steps.map((s, i) => html`<li key=${i} class=${`${i === steps.length - 1 ? 'now' : ''}${s.bad ? ' bad' : ''}`}>
      <span class="df-step-what">${s.url ? html`<a href=${s.url} onClick=${open(host, s.url)}>${s.what}</a>` : s.what}</span>
      <span class="df-when" title=${whenText(s.at)}>${whenText(s.at)}${s.took == null ? '' : ` · +${durationText(s.took / 1000)}`}</span></li>`)}</ol>
  </section>`;
}

function AgentSessions({fp, host}) {
  const d = fp.drawer, sessions = d?.agentSessions ?? [];
  if (!sessions.length && !d?.sessionError) return null;
  const roles = {created: 'Created this item', workedOn: 'Worked on this item', assigned: 'Currently assigned'};
  return html`<section class="df-related df-agent-sessions" aria-label="Agent sessions"><h3 class="dk-label">Agent sessions</h3>
    ${d.sessionError ? html`<${Failure} named=${true} backend="flightplan" error=${d.sessionError} retry=${() => fp.open(d.item)} host=${host} />` : null}
    <div class="df-related-group">${sessions.map(session => html`<a href=${session.url} onClick=${open(host, session.url)}><b>Job #${session.id}</b><span>${roles[session.role] ?? 'Worked on this item'}${session.actor ? ` · Writer: ${session.actor}` : ''}${session.source ? ` · Source: ${session.source}` : ''}${session.at ? ` · ${whenText(session.at)}` : ''}</span><${Glyph} name="next" size=${14} /></a>`)}</div>
  </section>`;
}

/** A link's name in the drawer, and the order its links keep whatever order the item lists them in. */
const LINK = {issue: 'Issue', pr: 'PR', sortie: 'Agent session'}, LINK_ORDER = Object.keys(LINK);
const linkRank = l => (i => i < 0 ? LINK_ORDER.length : i)(LINK_ORDER.indexOf(l.type));

function Detail({fp, host}) {
  const t = fp.drawer?.item;
  const refsOpts = {onItem: id => fp.openRelated(id), itemHref: fp.itemHref};
  return html`<${Drawer} open=${!!t} title=${t ? html`<span class="df-detail-title" title=${t.title}>${itemRefs(t.title, refsOpts)}</span>` : ''} sub=${t?.changeOnly ? 'Change' : t ? `${refOf(t)} · ${statusLabel(t.status)}` : null} onClose=${() => fp.close()} label=${t?.title ?? 'Item'}>
    <${DetailBody} fp=${fp} host=${host} />
  <//>`;
}

/** What the drawer shows of its item or change: the item's controls, facts, pipeline, changes, related items and history; a change's
 *  record. */
function DetailBody({fp, host}) {
  const d = fp.drawer, t = d?.item, epic = t ? fp.epicOf(t) : null;
  const links = (t?.links ?? []).slice().sort((a, b) => linkRank(a) - linkRank(b));
  const link = (url, text) => url ? html`<a href=${url} onClick=${open(host, url)}>${text}</a>` : text;
  // an FP-<n> in its title or history opens that item here, as its notes' do
  const refsOpts = {onItem: id => fp.openRelated(id), itemHref: fp.itemHref};
  return t?.changeOnly ? html`<div class="df-detail df-detail-change"><${Changes} state=${d} host=${host} standalone=${true} /></div>` : t ? html`<div class="df-detail">
      ${t.question ? html`<${Question} key=${`${t.id}:${t.revision}`} fp=${fp} item=${t} host=${host} />` : null}
      <section class="df-detail-controls" aria-label="Update item" aria-busy=${fp.busy.has(t.id)}>
      <label class="df-field"><span>Status</span><select class="dk-field" disabled=${fp.busy.has(t.id)} aria-label="Status" value=${t.status} onChange=${ev => fp.move(t, ev.currentTarget.value)}>
        ${STATUSES.map(s => html`<option value=${s.k} selected=${s.k === t.status}>${s.label}</option>`)}</select></label>
      <div class="df-detail-actions">
        ${fp.busy.has(t.id) ? html`<span class="df-saving" role="status">Saving…</span>` : null}
        <${Button} class="dk-btn main" type="button" disabled=${fp.busy.has(t.id)} onClick=${() => t.status === 'done' ? fp.reopen(t) : fp.done(t)}>${t.status === 'done' ? 'Reopen' : 'Done'}</${Button}>
        <${Button} class="dk-btn df-snz" type="button" aria-haspopup="menu" aria-expanded=${fp.snoozing === t.id} disabled=${fp.busy.has(t.id)} onClick=${ev => { ev.currentTarget.focus({preventScroll: true}); fp.openSnooze(t); }}>Snooze</${Button}>
        ${fp.snoozing === t.id ? html`<${SnoozeMenu} fp=${fp} item=${t} clock=${Date.now} />` : null}
      </div>
      </section>
      <div class="df-detail-fields">${[['Priority', 'priority', ['', 'None'], ...['P0', 'P1', 'P2', 'P3'].map(p => [p, p])],
         ['List', 'list', ...fp.lists.map(l => [l.slug, l.title])]].map(([label, field, ...choices]) => html`<label class="df-field"><span>${label}</span><select class="dk-field" disabled=${fp.busy.has(t.id)} aria-label=${label} value=${t[field] ?? ''} onChange=${ev => fp.edit(t, {[field]: ev.currentTarget.value || null})}>${choices.map(([value, text]) => html`<option value=${value} selected=${value === (t[field] ?? '')}>${text}</option>`)}</select></label>`)}</div>
      ${t.notes ? html`<${Notes} repo=${t.repo} host=${host} onItem=${id => fp.openRelated(id)} itemHref=${fp.itemHref} text=${t.notes} label=${t.status === 'stuck' ? 'Why stuck' : t.status === 'needs-you' ? 'What to do' : 'Notes'} />` : null}
      <${Facts} facts=${[
        ...(t.due ? [{label: 'Due', value: dueText(t.due, fp.date)}] : []),
        ...(t.repeat ? [{label: 'Repeats', value: describeRepeat(t.repeat)}] : []),
        {label: 'Kind', value: fieldLabel(t.kind)},
        ...['createdAt', 'updatedAt'].filter(k => t[k]).map(k => ({label: k === 'createdAt' ? 'Created' : 'Updated', value: html`<span title=${whenText(t[k])}>${ago(t[k])}</span>`})),
        ...(epic ? [{label: 'Epic', value: html`<a href=${fp.itemHref(epic.id)} onClick=${ev => { ev.preventDefault(); fp.openRelated(epic.id); }}>${epic.title} · ${refOf(epic)}</a>`}] : []),
        ...(t.area ? [{label: 'Area', value: t.area}] : []),
        ...(t.repo ? [{label: 'Repo', value: t.repo}] : []),
        ...(t.labels?.length ? [{label: 'Labels', value: html`<span class="df-drawer-labels">${t.labels.map(label => html`<${Button} type="button" class="df-label-chip" title=${label} aria-label=${`Filter label ${label}`} onClick=${() => fp.showLabel(label)}>${label}</${Button}>`)}</span>`}] : []),
        ...links.map(l => ({label: LINK[l.type] ?? l.type, value: link(itemLink(l), `${l.ref}${l.type === 'pr' ? ` · ${l.state ?? 'state unavailable'}` : ''}`)})),
      ]} />

      <${Pipeline} fp=${fp} host=${host} />
      <${Changes} state=${d} host=${host} />
      <${Related} fp=${fp} host=${host} />
      <${AgentSessions} fp=${fp} host=${host} />
      <h3 class="dk-label df-hist">History</h3>
      ${d.error ? html`<${Failure} named=${true} backend="flightplan" error=${d.error} retry=${() => fp.open(t)} host=${host} />`
        : !d.events ? html`<p class="df-muted" role="status">Loading history…</p>`
        : html`<ul class="df-events">${historyOf(d.events).map((e, i) => html`<li key=${i} class=${e.owner ? 'owner' : ''}><div>${typeof e.what === 'string' ? itemRefs(e.what, refsOpts) : e.what}</div><div class="df-when">${whenText(e.at)} · ${e.by}</div></li>`)}</ul>`}
    </div>` : null;
}

/** An item or a change an exact id named in Find (palette SPEC.md, *Identifiers*), in a desktop's viewer pane: the drawer's content
 *  on its own, its writes (status, Done, Snooze, priority, list) as the drawer's, its toast. `plan`: {item} or {change: {repo, pr}}. */
export function PlanDetail({host, plan}) {
  const [fp] = useState(() => createFlightplan(host, {reload: () => Promise.resolve(), page: 'find'}));
  const [, redraw] = useState(0);
  useEffect(() => {
    const off = fp.subscribe(() => redraw(n => n + 1));
    if (plan.change) { const [owner, repo] = String(plan.change.repo).split('/'); fp.openChange(owner, repo, plan.change.pr); }
    else if (plan.item) fp.open(plan.item);
    // the drawer's List choices
    host.call('flightplan.lists', {}).then(r => { if (Array.isArray(r?.lists)) { fp.lists = r.lists; redraw(n => n + 1); } }, () => {});
    return () => { off(); fp.stop(); };
  }, [fp]);
  return html`<div class="df dv-plan"><${DetailBody} fp=${fp} host=${host} /><${Toast} fp=${fp} /></div>`;
}

/** The model's toast: its line, then View (its `action`), Undo or Sign in to save. */
function Toast({fp}) {
  const t = fp.toast;
  return html`<${SharedToast} outcome=${t ? {text: t.text, bad: t.bad, actions: [
    t.action ? {label: t.action.label, run: () => { fp.dismiss(); t.action.run(); }} : null,
    t.undo ? {label: 'Undo', run: () => fp.undo()} : null,
    t.signIn ? {label: 'Sign in to save', run: () => fp.signIn()} : null].filter(Boolean)} : null} />`;
}

/** Whether a media query matches, kept current. */
function useMedia(query) {
  const q = globalThis.matchMedia?.(query);
  const [on, setOn] = useState(!!q?.matches);
  useEffect(() => { if (!q) return undefined; const f = () => setOn(q.matches); q.addEventListener?.('change', f); return () => q.removeEventListener?.('change', f); }, [query]);
  return on;
}
/** Wide enough for six columns and a drag between them (as the CSS's 1100 px); else from 600 px several columns side by side,
 *  scrolled sideways (no drag); a phone shows one column at a time behind its picker. */
const WIDE = '(min-width: 1100px) and (hover: hover)', SEVERAL = '(min-width: 600px)';
const useWide = () => useMedia(WIDE);

/** The bar over a page of its own (opts `nav`, `brand`); the Needs badge opens Todo. */
const PageBar = ({fp, host, opts, current}) => opts.nav ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} backends=${host.backends ?? []} current=${opts.current ?? current}
  needs=${{count: fp.needsSource.count, label: 'Needs', href: todoPath()}} />` : null;

/** Flightplan, the Board (`/flightplan`): opts `nav`, `brand`, `current` (the nav bar, on its own page), `clock`. */
export function Flightplan({model: fp, host, opts = {}}) {
  const motion = useFlightplanMotion(fp);
  const wide = useWide(), id = useId();
  const [filtersOpen, setFiltersOpen] = useState(false), filtersId = `${id}-board`;
  const filterCount = Number(fp.epic != null) + Number(fp.area !== 'All') + Number(!!fp.priority) + Number(!!fp.label);
  return html`<div class="df-page">${html`<${PageBar} fp=${fp} host=${host} opts=${opts} current="flightplan" />`}<main class="df dk-page dk-page-wide df-board-page" aria-label="Flightplan" ref=${motion.root}>
    <${PageHeader} title="Flightplan" description="Projects and work." actions=${html`<${BoardTools} fp=${fp} wide=${wide} filtersOpen=${filtersOpen} setFiltersOpen=${setFiltersOpen} filtersId=${filtersId} filterCount=${filterCount} />`} />
    ${fp.liveError ? html`<${Failure} named=${true} backend="flightplan" error=${fp.liveError} retry=${() => fp.checkUpdates()} host=${host} />` : null}
    <${Board} fp=${fp} host=${host} wide=${wide} filtersOpen=${filtersOpen} filtersId=${filtersId} filterCount=${filterCount} />
    <div class="df-motion-layer" aria-hidden="true" inert ref=${motion.layer}></div>
    <${Detail} fp=${fp} host=${host} />
  </main><${Toast} fp=${fp} /></div>`;
}

/** Todo (`/todo`): Needs you, overdue, today and upcoming, the lists, quick add; opts as Flightplan's. */
export function Todo({model: fp, host, opts = {}}) {
  const motion = useFlightplanMotion(fp), clock = opts.clock ?? Date.now;
  return html`<div class="df-page">${html`<${PageBar} fp=${fp} host=${host} opts=${opts} current="todo" />`}<main class="df dk-page df-todo-page" aria-label="Todo" ref=${motion.root}>
    <${PageHeader} title="Todo" description="What needs you, what is due and your lists." />
    ${fp.liveError ? html`<${Failure} named=${true} backend="flightplan" error=${fp.liveError} retry=${() => fp.checkUpdates()} host=${host} />` : null}
    <${Todos} fp=${fp} host=${host} clock=${clock} />
    <div class="df-motion-layer" aria-hidden="true" inert ref=${motion.layer}></div>
    <${Detail} fp=${fp} host=${host} />
  </main><${Toast} fp=${fp} /></div>`;
}

/** In the palette: Todo (`todo`, `todos`) or the Board (`flightplan`) over the host's flightplan ops. */
export function PaletteFlightplan({host, opts, view = 'todos'}) {
  const [model] = useState(() => createFlightplan(host, {clock: opts?.clock}));
  useEffect(() => { if (view === 'board') model.setTab('board'); else model.refresh(); return () => model.stop(); }, [model]);
  return view === 'board' ? html`<${Flightplan} model=${model} host=${host} opts=${opts ?? {}} />` : html`<${Todo} model=${model} host=${host} opts=${opts ?? {}} />`;
}
