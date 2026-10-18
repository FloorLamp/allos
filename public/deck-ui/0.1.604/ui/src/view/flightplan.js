// Flightplan (contract/flightplan.md): the Todos view (the lists rail, quick add with flightplan's parse as its live preview and its
// ask-back choices, Needs you, Overdue, Today, Upcoming by day, done today folded; each row's check and snooze) and Board (epics with
// done-of-total and a status bar, area chips, six columns: one at a time on a phone, a drag between them on a desktop; a card's drawer
// with its status and history). Rows open the drawer for full Markdown notes, related items and recorded agent sessions. The layout is the view's own, whatever page or panel mounts it. The rows, chips, buttons, drawer, facts, failures and placeholders are Deck's own (rows.js, drawer.js,
// failure.js, base.css); what is new is the board's columns, the epic cards, the snooze menu and the undo toast.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useId, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {ATTENTION, STATUSES, asksAction, createFlightplan, sourceOf, describeRepeat, dueText, historyOf, listDot, longDay, metaOf, needOf, prUrl, refOf, refUrl, snoozeChoices, statusLabel, whenText} from '../flightplan.js';
import {Drawer, Facts} from './drawer.js';
import {Failure} from './failure.js';
import {Block, Placeholders} from './rows.js';
import {ShellBar} from './shell-bar.js';
import {useFlightplanMotion} from './flightplan-motion.js';
import {Markdown} from './markdown.js';
const html = htm.bind(h);

const open = (host, url) => ev => { ev?.preventDefault?.(); if (url) host.call('url.open', {url}).catch(() => {}); };

/** A row's one meta line: quiet words, a dot between them. */
function Meta({facts}) {
  return facts.length ? html`<span class="df-meta">${facts.map(f => html`<span class=${`df-m-${f.kind}`}>${f.text}</span>`)}</span>` : null;
}

function SnoozeMenu({fp, item, clock}) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    ref.current?.querySelector('button')?.focus();
    const away = ev => { if (!ref.current?.contains(ev.target) && !ev.target.closest?.('.df-snz')) fp.openSnooze(item); };
    const key = ev => {
      if (!ref.current?.contains(ev.target)) return;
      const buttons = [...ref.current.querySelectorAll('[role="menuitem"]')], at = buttons.indexOf(document.activeElement);
      const next = {ArrowDown: (at + 1) % buttons.length, ArrowUp: (at + buttons.length - 1) % buttons.length, Home: 0, End: buttons.length - 1}[ev.key];
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); fp.openSnooze(item); opener?.focus({preventScroll: true}); }
      else if (next != null) { ev.preventDefault(); ev.stopPropagation(); buttons[next]?.focus(); }
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true); };
  }, [item.id]);
  return html`<div class="df-menu" role="menu" aria-label="Snooze until" ref=${ref}>${snoozeChoices(clock()).map(c => html`
    <button type="button" role="menuitem" data-snooze=${c.key} onClick=${() => fp.snooze(item, c)}>${c.label}<span>${c.hint}</span></button>`)}</div>`;
}

/** A row's title: one line, ellipsized; a click opens the item's drawer (its notes, history and status). */
const Title = ({fp, item}) => item.needSource && !item.needSource.item ? html`<span class="dp-title df-tt">${item.title}</span>` : html`<button type="button" class="dp-title df-tt" title=${item.title} onClick=${() => fp.open(item)}>${item.title}</button>`;
const TodoPriority = ({item}) => {
  const priority = item.priority ?? item.needSource?.item?.priority;
  return /^P[0-3]$/.test(priority ?? '') ? html`<span class=${`df-priority df-todo-priority p-${priority.toLowerCase()}`} aria-label=${`Priority ${priority}`}>${priority}</span>` : null;
};

function TodoRow({fp, item, clock, showList, done = false}) {
  const busy = fp.busy.has(item.id);
  return html`<div class=${`dp-row df-row${done ? ' done' : ''}`} role="listitem" data-id=${item.id} data-revision=${item.revision ?? null} aria-busy=${busy ? 'true' : null}>
    <button type="button" class="df-check" disabled=${busy} aria-label=${`${done ? 'Mark open' : 'Done'}: ${item.title}`}
      onClick=${() => (done ? fp.reopen(item) : fp.done(item))}><${Glyph} name="check" size=${12} /></button>
    <span class="dp-lines"><span class="df-task-heading"><${Title} fp=${fp} item=${item} /><${TodoPriority} item=${item} /></span><${Meta} facts=${metaOf(item, fp.date, {lists: fp.lists, showList}).filter(f => f.kind !== 'priority')} /></span>
    <span class="dp-end df-acts">${done ? null : html`<${Snooze} fp=${fp} item=${item} busy=${busy} />`}</span>
    ${fp.snoozing === item.id ? html`<${SnoozeMenu} fp=${fp} item=${item} clock=${clock} />` : null}
  </div>`;
}

/** Snooze: an icon, shown on hover or focus (always without a mouse). */
const Snooze = ({fp, item, busy}) => html`<button type="button" class="dk-btn df-snz" aria-haspopup="menu" aria-label=${`Snooze: ${item.title}`}
  aria-expanded=${fp.snoozing === item.id ? 'true' : 'false'} disabled=${busy} onClick=${ev => { ev.currentTarget.focus({preventScroll: true}); fp.openSnooze(item); }}><${Glyph} name="recent" size=${14} /></button>`;

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
    <div class="df-question-prompt df-notes-t"><${Markdown} text=${prompt} host=${host} repo=${item.repo} onItem=${id => fp.openRelated(id)} /></div>
    ${options.length ? html`<div class="df-question-choices" role="group" aria-label="Choose a reply">${options.map(option => html`<button type="button" class="dk-btn df-choice" disabled=${busy}
      onClick=${() => fp.answer(item, {option})}>${option}</button>`)}</div>` : null}
    ${prompt !== full ? html`<details class="df-question-original"><summary>Original request</summary><div class="df-notes-t"><${Markdown} text=${full} host=${host} /></div></details>` : null}
    <div class="df-reply"><label class="df-field"><span>Your reply</span><textarea class="dk-field" rows="3" maxlength="4000" value=${text} disabled=${busy} placeholder="Write a reply in your own words…"
      onInput=${ev => setText(ev.currentTarget.value)} /></label>
    <button type="submit" class="dk-btn main" disabled=${busy || !text.trim()}>${busy ? 'Sending…' : 'Send reply'}</button></div>
  </form>`;
}

function NeedRow({fp, item, clock, host}) {
  const {detail, action} = needOf(item), busy = fp.busy.has(item.id);
  return html`<div class="dp-row df-row df-need" role="listitem" data-need=${item.id} data-revision=${item.revision ?? item.needSource?.item?.revision ?? null} aria-busy=${busy ? 'true' : null}>
    <div class="dp-lines"><div class="df-task-heading"><${Title} fp=${fp} item=${item} /><${TodoPriority} item=${item} /></div>${item.question ? html`<${Question} key=${item.revision} fp=${fp} item=${item} host=${host} />` : null}<span class="df-meta"><span>${sourceOf(item)}</span>${detail && !item.question ? html`<span>${detail}</span>` : null}</span>
      ${action.kind === 'command' ? html`<details class="df-instructions"><summary>Instructions</summary><div><code class="df-cmd">${action.command}</code>
        <button type="button" class="dk-btn" disabled=${busy} onClick=${() => fp.act(item)}>Copy instructions</button></div></details>` : null}</div>
    <span class="dp-end df-need-acts"><span class="df-acts">${!item.needSource || item.needSource.item ? html`<${Snooze} fp=${fp} item=${item} busy=${busy} />` : null}</span>
      ${!item.question && action.kind !== 'command' ? html`<button type="button" class="dk-btn df-go" data-action=${action.kind} disabled=${busy} onClick=${() => fp.act(item)}>${action.label}</button>` : null}</span>
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
  return html`<form class="df-add" aria-busy=${c.busy} aria-label="New todo" autocomplete="off" onSubmit=${ev => { ev.preventDefault(); fp.add(); }}>
    <div class="df-add-row"><span class="df-plus" aria-hidden="true">+</span>
      <input class="df-input" disabled=${c.busy} value=${c.text} aria-label="Add a todo" placeholder="What needs doing?"
        onInput=${ev => fp.type(ev.currentTarget.value)} />
      <button type="submit" class="dk-btn main" disabled=${!c.text.trim() || c.busy || !!ask}>${c.busy ? 'Adding…' : 'Add'}</button></div>
    ${!c.text.trim() ? html`<p class="df-capture-hint">Add a date or repeat, like “call plumber Friday at 5”.</p>` : null}
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
      ${(fp.needsFailures ?? []).map(failure => html`<${Failure} backend=${failure.backend} error=${failure.error} retry=${() => fp.needsSource.refresh({force: true})} />`)}
      ${s.needs.length ? html`<${Section} label="Needs you" id="needs" count=${s.needs.length} tone="warn"><${Rows}>${s.needs.map(item => asksAction(item) ? html`<${NeedRow} key=${item.id} fp=${fp} item=${item} clock=${clock} host=${host} />` : row(item))}<//><//>` : null}
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
      <div class="df-title"><div><p class="df-eyebrow">Your todos</p><h2>${all ? 'Today' : current?.title ?? fp.list}</h2></div><span>${all ? longDay(fp.date) : `${s.items.length} open`}</span></div>
      <div class="df-listchips" role="group" aria-label="Lists">${rail.map(l => html`<button type="button" key=${l.slug} class=${`dk-chip${fp.list === l.slug ? ' on' : ''}`} aria-pressed=${String(fp.list === l.slug)}
        onClick=${() => fp.setList(l.slug)}><span>${l.short} ${l.n}</span></button>`)}</div>
      <${Capture} fp=${fp} />
      ${fp.error ? html`<${Failure} backend="flightplan" error=${fp.error} retry=${() => fp.refresh()} host=${host} />` : null}${body}
      ${!fp.loading && s.done.length ? html`<button type="button" class="dk-btn text df-fold" aria-expanded=${String(fp.showDone)} onClick=${() => fp.toggleDone()}>${fp.showDone ? 'Hide' : 'Show'} ${s.done.length} done today</button>
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
    <div class="df-cardh"><span class="df-ref">${refOf(task)}</span>${task.priority ? html`<button type="button" class=${`df-priority p-${task.priority.toLowerCase()}`} aria-label=${`Filter priority ${task.priority}`} onClick=${ev => { ev.stopPropagation(); fp.setPriority(task.priority); }}>${task.priority}</button>` : null}</div>
    ${epic ? html`<span class="df-epicname" title=${epic.title}>${epic.title}</span>` : null}
    ${task.labels?.length ? html`<div class="df-card-labels">${task.labels.map(label => html`<button type="button" class="df-label-chip" aria-label=${`Filter label ${label}`} onClick=${ev => { ev.stopPropagation(); fp.setLabel(label); }}>${label}</button>`)}</div>` : null}
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
    <button type="button" class="dk-field df-project-trigger" ref=${trigger} aria-label="Choose project" aria-haspopup="listbox" aria-expanded=${expanded} aria-controls=${`${id}-options`}
      onClick=${() => { setExpanded(!expanded); setQuery(''); }}><span><span class="df-filter-label">Project</span><b>${current?.epic.title ?? 'All projects'}</b>${current ? html`<small>${current.ref}</small>` : null}</span><${Glyph} name="next" size=${14} /></button>
    ${expanded ? html`<div class="df-project-popover">
      <input class="dk-field" type="search" aria-label="Search projects" placeholder="Find a project, reference or repository" value=${query} ref=${search} onInput=${ev => setQuery(ev.currentTarget.value)} />
      <div class="df-project-options" id=${`${id}-options`} role="listbox" aria-label="Projects">
        <button type="button" role="option" aria-selected=${fp.epic == null} tabindex=${fp.epic == null ? 0 : -1} class="df-project-option" onClick=${() => choose(null)}><b>All projects</b><span>Work across every project</span></button>
        ${[...groups].map(([label, entries]) => html`<div role="group" aria-label=${label}><div class="df-project-group">${label}</div>${entries.map(e => html`<button type="button" role="option" aria-selected=${fp.epic === e.epic.id} tabindex=${fp.epic === e.epic.id ? 0 : -1} class="df-project-option" onClick=${() => choose(e.epic.id)}>
          <b>${e.epic.title}</b><span>${e.ref} · ${e.taskCount} ${e.taskCount === 1 ? 'task' : 'tasks'} · ${e.done} done</span></button>`)}</div>`)}
        ${!choices.length ? html`<p class="df-muted">No matching projects</p>` : null}
      </div>
      <button type="button" class="dk-btn text df-completed-projects" aria-pressed=${completed} onClick=${ev => { ev.currentTarget.focus({preventScroll: true}); setCompleted(!completed); }}>${completed ? 'Hide completed projects' : 'Include completed projects'}</button>
    </div>` : null}
  </div>`;
}

/** Each status owns its scroll sentinel; filters and live delivery keep the model's batches. */
function BoardColumn({fp, column: c, wide, drop}) {
  const sentinel = useRef(null), body = useRef(null), shown = fp.column === c.k;
  useEffect(() => {
    if (!c.hidden || !sentinel.current || !wide && !shown || !globalThis.IntersectionObserver) return undefined;
    const target = sentinel.current;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.unobserve(target);
      fp.loadMoreColumn(c.k);
    }, {root: wide ? body.current : null, rootMargin: '0px 0px 160px 0px'});
    observer.observe(target);
    return () => observer.disconnect();
  }, [c.k, c.hidden, c.cards.length, wide, shown, fp.query, fp.priority, fp.label, fp.area, fp.epic]);
  return html`<div class=${`df-bcol${shown ? ' shown' : ''}${fp.over === c.k ? ' over' : ''}`} data-status=${c.k} aria-label=${c.label}
    onDragOver=${wide ? ev => { ev.preventDefault(); fp.setOver(c.k); } : null} onDragLeave=${wide ? ev => { if (!ev.currentTarget.contains(ev.relatedTarget)) fp.setOver(null); } : null} onDrop=${wide ? drop(c.k) : null}>
    <div class="df-bcol-h"><span class=${`dp-dot dot-${c.tone}`} aria-hidden="true"></span><span class="dk-label">${c.label}</span><span class="df-n">${c.all.length}</span></div>
    <div class="df-bcards" data-column=${c.k} ref=${body}>${c.cards.map(t => html`<${Card} key=${t.id} fp=${fp} task=${t} draggable=${wide} />`)}
      ${!c.all.length ? html`<div class="df-empty">No ${c.label.toLowerCase()} items</div>` : null}
      ${c.hidden ? html`<div class="df-load-more" data-column=${c.k} ref=${sentinel}><span class="df-muted">${c.cards.length} of ${c.all.length}</span><button type="button" class="dk-btn text" onClick=${() => fp.loadMoreColumn(c.k)}>Load more ${c.label}</button></div>` : null}
    </div>
  </div>`;
}

function BoardTools({fp, wide, filtersOpen, setFiltersOpen, filtersId, filterCount}) {
  return html`<div class="df-board-tools">
    <label class="df-work-search"><${Glyph} name="find" size=${16} /><input class="dk-field" type="search" aria-label="Search work" placeholder="Search titles, projects or references" value=${fp.query} onInput=${ev => fp.setQuery(ev.currentTarget.value)} /></label>
    ${!wide ? html`<button type="button" class="dk-btn df-filter-toggle" aria-expanded=${filtersOpen} aria-controls=${`${filtersId}-project ${filtersId}-filters`} onClick=${() => setFiltersOpen(!filtersOpen)}>Filters${filterCount ? ` (${filterCount})` : ''}</button>` : null}
    <${ProjectPicker} fp=${fp} id=${`${filtersId}-project`} hidden=${!wide && !filtersOpen} />
  </div>`;
}

function Board({fp, host, wide, filtersOpen, filtersId, filterCount}) {
  const b = fp.board, fit = useFit();
  useEffect(() => {
    if (!b.loaded) return;
    const columns = fp.columns();
    if (!columns.find(column => column.k === fp.column)?.all.length) {
      const first = columns.find(column => column.all.length);
      if (first) fp.setColumn(first.k);
    }
  }, [b.loaded, fp.query, fp.area, fp.epic, fp.priority, fp.label]);
  if (b.error && !b.loaded) return html`<div class="df-board"><${Failure} backend="flightplan" error=${b.error} retry=${() => fp.refreshBoard()} host=${host} /></div>`;
  if (b.loading && !b.loaded) return html`<div class="df-board"><div aria-busy="true" class="dp-rows"><${Placeholders} n=${4} /></div></div>`;
  const cols = fp.columns(), current = fp.epics().find(e => e.epic.id === fp.epic);
  const total = cols.reduce((n, c) => n + c.all.length, 0), count = status => cols.find(c => c.k === status)?.all.length ?? 0;
  const filtered = !!fp.query.trim() || !!filterCount;
  const clear = () => { fp.setQuery(''); fp.setArea('All'); fp.setEpic(null); fp.setPriority(''); fp.setLabel(''); };
  const drop = k => ev => { ev.preventDefault(); fp.setOver(null); const t = b.tasks.find(x => String(x.id) === ev.dataTransfer.getData('text/plain')); if (t) fp.move(t, k); };
  return html`<div class="df-board">
    ${b.error ? html`<${Failure} backend="flightplan" error=${b.error} retry=${() => fp.refreshBoard()} host=${host} />` : null}
    <p class="df-summary" role="status">${filtered ? `${total} matching items` : `${total - count('done')} open · ${count('needs-you')} tasks need you · ${count('stuck')} stuck`}</p>
    <div class="df-board-filters" id=${`${filtersId}-filters`} hidden=${!wide && !filtersOpen}>
      <div class="df-filter-row"><span class="df-filter-label">Priority</span><div class="df-filters" role="group" aria-label="Priority">${[['', 'All priorities'], ...fp.priorities().map(p => [p, p === 'none' ? 'No priority' : p])].map(([value, label]) => html`<button type="button" class=${`dk-chip df-priority-filter${value && value !== 'none' ? ` p-${value.toLowerCase()}` : ''}${fp.priority === value ? ' on' : ''}`} aria-pressed=${fp.priority === value} onClick=${() => fp.setPriority(value)}>${label}</button>`)}</div></div>
      <div class="df-filter-row"><span class="df-filter-label">Area</span><div class="df-filters" role="group" aria-label="Area">${fp.areas().map(area => html`<button type="button" class=${`dk-chip${fp.area === area ? ' on' : ''}`} aria-pressed=${fp.area === area} onClick=${() => fp.setArea(area)}>${area}</button>`)}</div></div>
      <div class="df-filter-row"><label class="df-label-picker"><span class="df-filter-label">Label</span><select class="dk-field" aria-label="Label" value=${fp.label} onChange=${ev => fp.setLabel(ev.currentTarget.value)}><option value="">All labels</option>${fp.labels().map(label => html`<option value=${label}>${label}</option>`)}</select></label>
      ${filtered ? html`<button type="button" class="dk-btn text df-clear" onClick=${clear}>Clear filters</button>` : null}</div>
    </div>
    ${current ? html`<section class="df-current-project" aria-label="Selected project"><${Epic} fp=${fp} e=${current} /></section>` : null}
    <div class="df-colpick" role="group" aria-label="Column">${cols.map(c => html`<button type="button" class=${`dk-chip${fp.column === c.k ? ' on' : ''}`} aria-pressed=${fp.column === c.k} onClick=${() => fp.setColumn(c.k)}><span class=${`dp-dot dot-${c.tone}`} aria-hidden="true"></span><span>${c.label}</span><span class="df-n">${c.all.length}</span></button>`)}</div>
    ${filtered && !total ? html`<${Block} b=${{glyph: 'find', title: 'No matching work', line: 'Try another title, project or reference, or clear the filters.'}} />` : null}
    <div class="df-cols" ref=${fit} hidden=${filtered && !total}>${cols.map(c => html`<${BoardColumn} key=${c.k} fp=${fp} column=${c} wide=${wide} drop=${drop} />`)}</div>
  </div>`;
}

/** Full Markdown notes; titles and metadata remain plain text. */
function Notes({text, label, repo, host, onItem}) {
  return html`<section class="df-notes" aria-label=${label}><h3 class="dk-label">${label}</h3>
    <div class="df-notes-t"><${Markdown} text=${text} host=${host} repo=${repo} onItem=${onItem} /></div></section>`;
}
const relative = iso => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
};
const itemLink = l => l.url ?? (l.type === 'pr' ? prUrl(l) : l.type === 'issue' ? refUrl({links: [l]}) : l.type === 'sortie' ? `https://sortie.wang.team/v1/jobs/${l.ref.replace(/^sortie:/, '')}` : null);

function Related({fp, host}) {
  const related = fp.drawer?.related;
  if (!related) return null;
  const groups = [['Parent', related.parent ? [related.parent] : []], ['Children', related.children], ['Blocked by', related.blockedBy], ['Blocking', related.blocking]];
  if (!related.loading && !related.error && !groups.some(([, items]) => items?.length)) return null;
  return html`<section class="df-related" aria-label="Related items"><h3 class="dk-label">Related items</h3>
    ${related.loading ? html`<p class="df-muted" role="status">Loading related items…</p>` : null}
    ${related.error ? html`<${Failure} backend="flightplan" error=${related.error} retry=${() => fp.openRelated(fp.drawer.item.id)} host=${host} />` : null}
    ${groups.filter(([, items]) => items?.length).map(([label, items]) => html`<div class="df-related-group"><h4>${label}</h4>${items.map(item => html`<a href=${`#${fp.tab}/${item.id}`} aria-label=${`Open related item ${refOf(item)}: ${item.title ?? `Item ${item.id}`}`} onClick=${ev => { ev.preventDefault(); fp.openRelated(item.id); }}><b>${item.title ?? `Item ${item.id}`}</b><span>${refOf(item)}${item.status ? ` · ${statusLabel(item.status)}` : ''}${item.missing ? ' · unavailable' : ''}</span><${Glyph} name="next" size=${14} /></a>`)}</div>`)}
  </section>`;
}

function AgentSessions({fp, host}) {
  const d = fp.drawer, sessions = d?.agentSessions ?? [];
  if (!sessions.length && !d?.sessionError) return null;
  const roles = {created: 'Created this item', workedOn: 'Worked on this item', assigned: 'Currently assigned'};
  return html`<section class="df-related df-agent-sessions" aria-label="Agent sessions"><h3 class="dk-label">Agent sessions</h3>
    ${d.sessionError ? html`<${Failure} backend="flightplan" error=${d.sessionError} retry=${() => fp.open(d.item)} host=${host} />` : null}
    <div class="df-related-group">${sessions.map(session => html`<a href=${session.url} onClick=${open(host, session.url)}><b>Job #${session.id}</b><span>${roles[session.role] ?? 'Worked on this item'}${session.actor ? ` · Writer: ${session.actor}` : ''}${session.source ? ` · Source: ${session.source}` : ''}${session.at ? ` · ${whenText(session.at)}` : ''}</span><${Glyph} name="next" size=${14} /></a>`)}</div>
  </section>`;
}

function Detail({fp, host}) {
  const d = fp.drawer, t = d?.item, epic = t ? fp.epicOf(t) : null;
  const link = (url, text) => url ? html`<a href=${url} onClick=${open(host, url)}>${text}</a>` : text;
  return html`<${Drawer} open=${!!t} title=${t ? html`<span class="df-detail-title" title=${t.title}>${t.title}</span>` : ''} sub=${t ? `${refOf(t)} · ${statusLabel(t.status)}` : null} onClose=${() => fp.close()} label=${t?.title ?? 'Item'}>
    ${t ? html`<div class="df-detail">
      ${t.question ? html`<${Question} key=${`${t.id}:${t.revision}`} fp=${fp} item=${t} host=${host} />` : null}
      <section class="df-detail-controls" aria-label="Update item" aria-busy=${fp.busy.has(t.id)}>
      <label class="df-field"><span>Status</span><select class="dk-field" disabled=${fp.busy.has(t.id)} aria-label="Status" value=${t.status} onChange=${ev => fp.move(t, ev.currentTarget.value)}>
        ${STATUSES.map(s => html`<option value=${s.k} selected=${s.k === t.status}>${s.label}</option>`)}</select></label>
      <div class="df-detail-actions">
        ${fp.busy.has(t.id) ? html`<span class="df-saving" role="status">Saving…</span>` : null}
        <button class="dk-btn main" type="button" disabled=${fp.busy.has(t.id)} onClick=${() => t.status === 'done' ? fp.reopen(t) : fp.done(t)}>${t.status === 'done' ? 'Reopen' : 'Done'}</button>
        <button class="dk-btn df-snz" type="button" aria-haspopup="menu" aria-expanded=${fp.snoozing === t.id} disabled=${fp.busy.has(t.id)} onClick=${ev => { ev.currentTarget.focus({preventScroll: true}); fp.openSnooze(t); }}>Snooze</button>
        ${fp.snoozing === t.id ? html`<${SnoozeMenu} fp=${fp} item=${t} clock=${Date.now} />` : null}
        ${(t.links ?? []).filter(l => ['pr', 'issue'].includes(l.type)).map(l => link(itemLink(l), `Open ${l.type === 'pr' ? 'PR' : 'issue'}`))}
      </div>
      </section>
      <div class="df-detail-fields">${[['Priority', 'priority', ['', 'None'], ...['P0', 'P1', 'P2', 'P3'].map(p => [p, p])],
         ['List', 'list', ...fp.lists.map(l => [l.slug, l.title])]].map(([label, field, ...choices]) => html`<label class="df-field"><span>${label}</span><select class="dk-field" disabled=${fp.busy.has(t.id)} aria-label=${label} value=${t[field] ?? ''} onChange=${ev => fp.edit(t, {[field]: ev.currentTarget.value || null})}>${choices.map(([value, text]) => html`<option value=${value} selected=${value === (t[field] ?? '')}>${text}</option>`)}</select></label>`)}</div>
      ${t.notes ? html`<${Notes} repo=${t.repo} host=${host} onItem=${id => fp.openRelated(id)} text=${t.notes} label=${t.status === 'stuck' ? 'Why stuck' : t.status === 'needs-you' ? 'What to do' : 'Notes'} />` : null}
      <${Facts} facts=${[
        ...(t.due ? [{label: 'Due', value: dueText(t.due, fp.date)}] : []),
        ...(t.repeat ? [{label: 'Repeats', value: describeRepeat(t.repeat)}] : []),
        {label: 'Kind', value: t.kind},
        ...['createdAt', 'updatedAt'].filter(k => t[k]).map(k => ({label: k === 'createdAt' ? 'Created' : 'Updated', value: html`<span title=${whenText(t[k])}>${relative(t[k])}</span>`})),
        ...(epic ? [{label: 'Epic', value: html`<a href=${`#${fp.tab}/${epic.id}`} onClick=${ev => { ev.preventDefault(); fp.openRelated(epic.id); }}>${epic.title} · ${refOf(epic)}</a>`}] : []),
        ...(t.area ? [{label: 'Area', value: t.area}] : []),
        ...(t.repo ? [{label: 'Repo', value: t.repo}] : []),
        ...(t.labels?.length ? [{label: 'Labels', value: html`<span class="df-drawer-labels">${t.labels.map(label => html`<button type="button" class="df-label-chip" aria-label=${`Filter label ${label}`} onClick=${() => { fp.setLabel(label); fp.setTab('board'); fp.close(); }}>${label}</button>`)}</span>`}] : []),
        ...(t.links ?? []).map(l => ({label: l.type === 'pr' ? 'PR' : l.type === 'sortie' ? 'Agent session' : l.type, value: link(itemLink(l), `${l.ref}${l.type === 'pr' ? ` · ${l.state ?? 'state unavailable'}` : ''}`)})),
      ]} />

      <${Related} fp=${fp} host=${host} />
      <${AgentSessions} fp=${fp} host=${host} />
      <h3 class="dk-label df-hist">History</h3>
      ${d.error ? html`<${Failure} backend="flightplan" error=${d.error} retry=${() => fp.open(t)} host=${host} />`
        : !d.events ? html`<p class="df-muted" role="status">Loading history…</p>`
        : html`<ul class="df-events">${historyOf(d.events).map((e, i) => html`<li key=${i} class=${e.owner ? 'owner' : ''}><div>${e.what}</div><div class="df-when">${whenText(e.at)} · ${e.by}</div></li>`)}</ul>`}
    </div>` : null}
  <//>`;
}

function Toast({fp}) {
  const t = fp.toast;
  return html`<div class=${`df-toast${t ? ' on' : ''}${t?.bad ? ' bad' : ''}`} role="status">${t ? html`<span>${t.text}</span>${t.action ? html`<button type="button" class="dk-btn text" onClick=${() => { fp.dismiss(); t.action.run(); }}>${t.action.label}</button>` : null}${t.undo ? html`<button type="button" class="dk-btn text" onClick=${() => fp.undo()}>Undo</button>` : null}${t.signIn ? html`<button type="button" class="dk-btn text" onClick=${() => fp.signIn()}>Sign in to save</button>` : null}` : null}</div>`;
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
  const motion = useFlightplanMotion(fp);
  const wide = useWide(), clock = opts.clock ?? Date.now, id = useId(), pendingTabFocus = useRef(null);
  const [filtersOpen, setFiltersOpen] = useState(false), filtersId = `${id}-board`;
  const filterCount = Number(fp.epic != null) + Number(fp.area !== 'All') + Number(!!fp.priority) + Number(!!fp.label);
  const tabs = [['todos', 'Todos'], ['board', 'Board']];
  const tabKey = (event, index) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const next = {ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1}[event.key];
    if (next == null) return;
    event.preventDefault();
    const key = tabs[next][0];
    if (key !== fp.tab) pendingTabFocus.current = key;
    fp.setTab(key);
  };
  useLayoutEffect(() => {
    const key = pendingTabFocus.current;
    pendingTabFocus.current = null;
    if (key === fp.tab) motion.root.current?.querySelector(`[id="${id}-tab-${key}"]`)?.focus({preventScroll: true});
  }, [fp.tab]);
  const activateTab = (key, event) => {
    if (event.detail === 0 && key !== fp.tab) pendingTabFocus.current = key;
    fp.setTab(key);
  };
  const tabNav = html`<div class="df-tabs" role="tablist" aria-label="View">${tabs.map(([key, label], index) => html`<button type="button" role="tab" key=${key}
    id=${`${id}-tab-${key}`} aria-controls=${`${id}-panel-${key}`} aria-selected=${String(fp.tab === key)} tabindex=${fp.tab === key ? 0 : -1}
    onKeyDown=${event => tabKey(event, index)} onClick=${event => activateTab(key, event)}>${label}</button>`)}</div>`;
  const bar = opts.nav ? html`<${ShellBar} brand=${opts.brand} nav=${opts.nav} backends=${host.backends ?? []} current=${opts.current ?? 'flightplan'} needs=${{count: fp.needsSource.count, label: 'Needs', href: '/flightplan#needs'}} />` : null;
  return html`<div class="df-page">${bar}<main class="df" aria-label="Flightplan" ref=${motion.root}>
    <header class="df-head df-mode-head"><div class="df-mode-switch"><h1>Flightplan</h1>${tabNav}</div>
      ${fp.tab === 'board' ? html`<${BoardTools} fp=${fp} wide=${wide} filtersOpen=${filtersOpen} setFiltersOpen=${setFiltersOpen} filtersId=${filtersId} filterCount=${filterCount} />` : null}</header>
    ${fp.liveError ? html`<${Failure} backend="flightplan" error=${fp.liveError} retry=${() => fp.checkUpdates()} host=${host} />` : null}
    ${tabs.map(([k]) => html`<section key=${k} id=${`${id}-panel-${k}`} role="tabpanel" aria-labelledby=${`${id}-tab-${k}`} hidden=${fp.tab !== k} tabindex="-1">
      ${fp.tab !== k ? null : k === 'todos' ? html`<${Todos} fp=${fp} host=${host} clock=${clock} />` : html`<${Board} fp=${fp} host=${host} wide=${wide} filtersOpen=${filtersOpen} filtersId=${filtersId} filterCount=${filterCount} />`}
    </section>`)}
    <div class="df-motion-layer" aria-hidden="true" inert ref=${motion.layer}></div>
    <${Detail} fp=${fp} host=${host} />
  </main><${Toast} fp=${fp} /></div>`;
}

/** In the palette (`flightplan`, `todos`): Flightplan over the host's flightplan ops. */
export function PaletteFlightplan({host, opts}) {
  const [model] = useState(() => createFlightplan(host, {clock: opts?.clock}));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Flightplan} model=${model} host=${host} opts=${opts ?? {}} />`;
}
