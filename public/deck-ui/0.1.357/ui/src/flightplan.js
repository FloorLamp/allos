import {describeFailure} from './failure.js';
// Flightplan (contract/flightplan.md): the owner's todos and the fleet's work from flightplan's API, through the host's
// registry ops (`flightplan.<op>`: the device credential on a shell, the site's session on the web). Todos (the owner's own: items with no
// `repo`, read with `repo=none`): Needs you, Overdue, Today, Upcoming by day (14 days), one list at a time, done today folded; quick add
// with flightplan's own parse as its preview. Board (work: items with a `repo`, and epics): epics with their progress, six status
// columns, a card's history. A row is a title and one line; notes only in the drawer. No DOM here (view/flightplan.js draws it); days are New York's, as
// flightplan's views are.

export const OPEN = ['backlog', 'ready', 'in-progress', 'stuck', 'needs-you'];
/** The board's columns, in order; `tone` a dot class (foundation.css `dot-*`). */
export const STATUSES = [
  {k: 'backlog', label: 'Backlog', tone: 'muted'}, {k: 'ready', label: 'Ready', tone: 'accent'},
  {k: 'in-progress', label: 'In progress', tone: 'sent'}, {k: 'stuck', label: 'Stuck', tone: 'bad'},
  {k: 'needs-you', label: 'Needs you', tone: 'warn'}, {k: 'done', label: 'Done', tone: 'ok'}];
/** How many cards a column shows until Show all: Backlog's and Ready's top 5 by priority, Done none (its count); the rest all. */
export const COLLAPSED = {backlog: 5, ready: 5, done: 0};
/** The board's columns left to right: what needs a look first, then what waits, Done last. */
export const BOARD = ['needs-you', 'stuck', 'in-progress', 'ready', 'backlog', 'done'];
const byPriority = (a, b) => (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9') || a.id - b.id;
export const statusLabel = k => STATUSES.find(s => s.k === k)?.label ?? (k === 'dropped' ? 'Dropped' : k);
/** A list's dot, by its position in flightplan's list order (tokens only). */
const DOTS = ['accent', 'ok', 'sent', 'warn', 'received', 'bad', 'muted'];
export const flightplanQuery = q => /^(flightplan|todos?)$/i.test(String(q).trim());
const ZONE = 'America/New_York';
const WORK = new Set(['task', 'epic']);
/** The owner's own lists: in the rail even when empty. Any other list (deck, fleet, …) shows only while it holds the owner's items. */
export const CORE_LISTS = ['personal', 'household', 'kids', 'errands', 'house-walk'];
/** Todos are the owner's own (`repo=none`); the Board is work (`repo=any`, and every epic): flightplan CONTRACT.md *Items*. */
const MINE = {repo: 'none'};
/** A row's one line from free text: its first line, at most `max` characters (an issue body never fills a row). */
export function oneLine(text, max = 140) {
  const line = String(text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// ---------- New York days and times ----------
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = n => String(n).padStart(2, '0');
const utc = day => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const dayOf = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
export const addDays = (day, n) => dayOf(utc(day) + n * 864e5);
const weekday = day => new Date(utc(day)).getUTCDay();
/** New York's wall clock at `ms`: {day: 'YYYY-MM-DD', h, m, offset (minutes ahead of UTC)}. */
export function newYork(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`, h = Number(p.hour) % 24, m = Number(p.minute);
  return {day, h, m, offset: Math.round((utc(day) + (h * 60 + m) * 60000 - Math.floor(ms / 60000) * 60000) / 60000)};
}
/** `9 AM`, `5:30 PM`. */
export const clockText = (h, m) => `${((h + 11) % 12) + 1}${m ? `:${pad(m)}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
/** A day as the rows say it, from `today`: Today, Tomorrow, Yesterday, a weekday this week, else `Sat Oct 24`. */
export function dayName(day, today) {
  const n = Math.round((utc(day) - utc(today)) / 864e5);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return WD[weekday(day)];
  return `${WD[weekday(day)].slice(0, 3)} ${MO[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}
/** A due (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, New York) in words: `Today, 4 PM`, `Sat Oct 24`. */
export function dueText(due, today) {
  const [day, time] = due.split('T');
  return dayName(day, today) + (time ? `, ${clockText(Number(time.slice(0, 2)), Number(time.slice(3, 5)))}` : '');
}
/** `Friday, October 16`. */
export const longDay = day => `${WD[weekday(day)]}, ${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const NTH = {1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last', '-2': 'second to last'};
const DAYCODE = {SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6};
const andList = xs => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
/** flightplan's RRULE subset (CONTRACT.md *Item*) in words: `every day`, `every other Tuesday`, `every month on the second Tuesday`. */
export function describeRepeat(rule) {
  const p = Object.fromEntries(String(rule).split(';').map(kv => kv.split('=')));
  const n = Number(p.INTERVAL || 1), every = unit => n === 1 ? `every ${unit}` : n === 2 ? `every other ${unit}` : `every ${n} ${unit}s`;
  const days = (p.BYDAY || '').split(',').filter(Boolean);
  const month = p.BYMONTH ? MO[Number(p.BYMONTH) - 1] : null;
  const monthDay = p.BYMONTHDAY === '-1' ? 'the last day' : p.BYMONTHDAY ? `the ${ordinal(Number(p.BYMONTHDAY))}` : null;
  const nth = days.map(d => { const m = /^(-?\d)?([A-Z]{2})$/.exec(d); return m ? `${m[1] ? `the ${NTH[m[1]] ?? ordinal(Number(m[1]))} ` : ''}${WD[DAYCODE[m[2]]]}` : d; });
  if (p.FREQ === 'DAILY') return n === 1 ? 'every day' : `every ${n} days`;
  if (p.FREQ === 'WEEKLY') {
    if (!days.length) return every('week');
    if (n === 1 && days.join() === 'MO,TU,WE,TH,FR') return 'every weekday';
    if (n === 1 && days.join() === 'SA,SU') return 'every weekend';
    return n === 1 ? `every ${andList(nth)}` : n === 2 ? `every other ${andList(nth)}` : `every ${n} weeks on ${andList(nth)}`;
  }
  if (p.FREQ === 'MONTHLY') {
    if (n === 1 && p.BYMONTHDAY === '1' && !days.length) return 'first of the month';
    if (n === 1 && p.BYMONTHDAY === '-1' && !days.length) return 'last day of the month';
    const on = monthDay ?? (days.length ? andList(nth) : null);
    return on ? `${every('month')} on ${on}` : every('month');
  }
  if (p.FREQ === 'YEARLY') {
    const on = month && p.BYMONTHDAY && p.BYMONTHDAY !== '-1' ? `${month} ${Number(p.BYMONTHDAY)}` : month ? `${monthDay ?? (days.length ? andList(nth) : 'in')}${monthDay || days.length ? ' of' : ''} ${month}` : null;
    return on ? `${every('year')} on ${on}`.replace(' on in ', ' in ') : every('year');
  }
  return 'repeats';
}
/** Snooze's choices from New York's `now`: [{key, label, until, hint}] (in 1 hour; tonight, before 8 PM; tomorrow, Monday, next week at 9). */
export function snoozeChoices(ms) {
  const now = newYork(ms), later = newYork(ms + 3600e3), at = (day, h, m = 0) => `${day}T${pad(h)}:${pad(m)}`;
  const monday = addDays(now.day, ((8 - weekday(now.day)) % 7) || 7);
  return [
    {key: 'hour', label: 'In 1 hour', until: at(later.day, later.h, later.m)},
    ...(now.h < 20 ? [{key: 'tonight', label: 'Tonight', until: at(now.day, 20)}] : []),
    {key: 'tomorrow', label: 'Tomorrow', until: at(addDays(now.day, 1), 9)},
    {key: 'monday', label: 'Monday', until: at(monday, 9)},
    {key: 'week', label: 'Next week', until: at(addDays(now.day, 7), 9)},
  ].map(c => ({...c, hint: dueText(c.until, now.day).replace(/^(Today|Tomorrow), /, '')}));
}

// ---------- items as the views show them ----------
/** A GitHub reference shown short: `FloorLamp/spaceport#652` → `spaceport#652`. */
const shortRef = ref => String(ref).replace(/^[^/#\s]+\//, '');
const github = ref => { const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref ?? ''); return m ? {repo: m[1], n: m[2]} : null; };
/** An item's reference: its issue link, else its GitHub key, else `#id`. */
export function refOf(item) {
  const issue = item.links?.find(l => l.type === 'issue')?.ref ?? (/^github:(.+)$/.exec(item.key ?? '')?.[1]);
  return issue ? shortRef(issue) : `#${item.id}`;
}
/** Where an item's reference opens: its issue link's url, else GitHub's issue page. */
export function refUrl(item) {
  const link = item.links?.find(l => l.type === 'issue'), ref = link?.ref ?? /^github:(.+)$/.exec(item.key ?? '')?.[1];
  if (link?.url) return link.url;
  const g = github(ref);
  return g ? `https://github.com/${g.repo}/issues/${g.n}` : null;
}
/** A PR link's url: its own, else GitHub's pull page. */
export const prUrl = link => link.url ?? (github(link.ref) ? `https://github.com/${github(link.ref).repo}/pull/${github(link.ref).n}` : null);
/** What a Needs you item asks of the owner (the needs poller writes `notes` as `<detail>\n<label>: …`; flightplan README *Needs*):
 *  {detail, action: {kind: 'url', url, label} | {kind: 'op', backend, id, label} | {kind: 'command', command, label} | {kind: 'done', label}}.
 *  `detail`: a backend need's (kind `need`) one line, else null: any other item's notes stay in the drawer. */
export function needOf(item) {
  const lines = (item.notes ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  // the how line alone: a need with no detail (`Sign in: in Deck's Needs you`)
  const need = item.links?.find(l => l.type === 'need'), how = lines.length > 1 || (need && lines.length) ? /^(.{1,40}?): (.+)$/.exec(lines.at(-1)) : null;
  const detail = item.kind === 'need' ? oneLine(how ? lines.slice(0, -1).join(' · ') : lines.join(' · ')) || null : null;
  const url = need?.url ?? item.links?.find(l => ['pr', 'issue', 'url'].includes(l.type) && l.url)?.url ?? (item.links?.find(l => l.type === 'issue') ? refUrl(item) : null);
  if (url) return {detail, action: {kind: 'url', url, label: how?.[1] ?? 'Open'}};
  if (need && how && how[2] === "in Deck's Needs you") {
    const [backend, ...id] = need.ref.split(':');
    return {detail, action: {kind: 'op', backend, id: id.join(':'), label: how[1]}};
  }
  if (need && how) return {detail, action: {kind: 'command', command: how[2], label: how[1]}};
  return {detail, action: {kind: 'done', label: 'Done'}};
}
/** Where a backend need comes from, as a row's quiet meta word: bridge's by its source (`bills`, `messages`), else the backend
 *  (`purser`, `rover`). */
export function sourceOf(item) {
  const ref = item.links?.find(l => l.type === 'need')?.ref ?? '', parts = ref.split(':');
  return (parts[0] === 'bridge' && parts.length > 2 ? parts[1] : parts[0]) || item.area || 'flightplan';
}
/** Whether a Needs you item is a backend need with its own action (a page, an op, a command): its row has that button and no
 *  check; anything else (the owner's own items, a need with nothing to run) is a todo row with its check. */
export const asksAction = item => item.kind === 'need' && needOf(item).action.kind !== 'done';
/** A todo row's facts: [{kind: late | due | repeat | priority | list, text, tone?}]. */
export function metaOf(item, today, {lists = [], showList = true} = {}) {
  const out = [];
  if (item.due) {
    const late = item.due.slice(0, 10) < today;
    out.push({kind: late ? 'late' : 'due', text: `${late ? 'Overdue · ' : ''}${dueText(item.due, today)}`});
  }
  if (item.repeat) out.push({kind: 'repeat', text: `↻ ${describeRepeat(item.repeat)}`});
  if (item.priority) out.push({kind: 'priority', text: item.priority});
  if (showList && item.list) out.push({kind: 'list', text: lists.find(l => l.slug === item.list)?.title ?? item.list, dot: listDot(lists, item.list)});
  return out;
}
export const listDot = (lists, slug) => DOTS[Math.max(0, lists.findIndex(l => l.slug === slug)) % DOTS.length];
/** Upcoming in day groups: [{day, label, items}]. */
export function byDay(items, today) {
  const groups = new Map();
  for (const it of items) { const day = it.due.slice(0, 10); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(it); }
  return [...groups].map(([day, xs]) => ({day, label: dayName(day, today), items: xs}));
}
/** History lines from `/v1/items/<id>/events`, newest first: [{at, what, by, owner}]. */
export function historyOf(events = []) {
  return events.map(e => {
    const fields = Object.keys(e.changes ?? {}), created = fields.length && fields.every(f => e.changes[f][0] === null) && !e.occurrence && !e.ignored;
    const st = e.changes?.status;
    const what = created ? 'Created' : e.occurrence ? `Done for ${e.occurrence}` : st ? `${st[1] === 'done' ? 'Done' : `Moved from ${statusLabel(st[0])} to ${statusLabel(st[1])}`}${e.ignored ? ' (not applied: the owner’s move wins)' : ''}`
      : `Changed ${fields.join(', ') || 'nothing'}`;
    return {at: e.at, what, by: [e.actor, e.source].filter(Boolean).join(' · '), owner: e.source === 'owner'};
  }).reverse();
}
/** `Oct 16, 10:41` in New York. */
export const whenText = iso => new Intl.DateTimeFormat('en-US', {timeZone: ZONE, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(iso));

/** An epic's progress over its children: {epic, ref, why, total, done, counts: {status: n}}. */
export function progressOf(epic, kids) {
  const counts = Object.fromEntries(STATUSES.map(s => [s.k, kids.filter(t => t.status === s.k).length]));
  return {epic, ref: refOf(epic), why: oneLine(epic.notes) || null, total: kids.length, done: counts.done, counts};
}
/** What an epic's progress calls out, in order: [status, tone, words]. */
export const ATTENTION = [['stuck', 'bad', 'stuck'], ['needs-you', 'warn', 'needs you'], ['in-progress', 'sent', 'in progress']];
/** `5 of 8 done · 1 stuck · 1 needs you · 1 in progress`. */
export const progressLine = p => [`${p.done} of ${p.total} done`, ...ATTENTION.filter(([k]) => p.counts[k]).map(([k, , words]) => `${p.counts[k]} ${words}`)].join(' · ');

// ---------- in Deck's find (palette SPEC.md, *Flightplan in Find*) ----------
/** A found row's kind for an item: `epic`, `task`, else `todo` (a need, a chore, a house-walk item too). */
export const findKind = item => item.kind === 'epic' || item.kind === 'task' ? item.kind : 'todo';
/** The snooze choices a found row offers: in 1 hour, tonight (before 8 PM), tomorrow at 9. */
export const quickSnooze = ms => snoozeChoices(ms).filter(c => ['hour', 'tonight', 'tomorrow'].includes(c.key));
const byDue = (a, b) => (a.due ?? '9').localeCompare(b.due ?? '9');
/** An item as Deck's find gives it (bridge's result shape, kind `todo`, `task` or `epic`): its status where it says something (a
 *  task's and an epic's always), its due, repeat, priority and list in words, a task's or an epic's reference; the item, its issue's
 *  `url` (Mod+Enter) and, while open, the snooze choices at `now`. */
export function findResult(item, {date, lists = [], now = Date.now()} = {}) {
  const kind = findKind(item), work = kind !== 'todo', open = OPEN.includes(item.status);
  const status = work || !['ready', 'backlog'].includes(item.status) ? statusLabel(item.status) : null;
  return {kind, title: item.title, subtitle: [status, ...metaOf(item, date ?? newYork(now).day, {lists}).map(m => m.text), work ? refOf(item) : null].filter(Boolean).join(' · '),
    item, url: refUrl(item), ...(open ? {snooze: quickSnooze(now)} : {})};
}
/** A line to read in the found rows (bridge's `none` kind): nothing due, nothing on a list. */
const noneRow = title => ({kind: 'none', title, subtitle: 'Flightplan'});

/** A word search's matches beside bridge's: the owner's open todos (no `repo`, no epic) whose title holds the words, at most `limit`;
 *  never work items, never a notes match. `call(op, args)`: the host's `flightplan.<op>`. */
export async function planSearch(call, q, {now = Date.now(), lists = [], limit = 3} = {}) {
  const r = await call('items', {query: {q, status: OPEN.join(','), ...MINE, limit: 25}});
  const words = String(q).toLowerCase();
  return (r?.items ?? []).filter(i => !i.repo && i.kind !== 'epic' && i.title.toLowerCase().includes(words)).slice(0, limit).map(item => findResult(item, {lists, now}));
}

/** bridge's results with flightplan's beside them: flightplan's in the found rows' last nav when bridge fills them (model MAX.found). */
export function mergeFound(bridge = [], plan = [], max = 8) {
  if (!plan.length) return bridge;
  const keep = Math.max(0, max - plan.length);
  return [...bridge.slice(0, keep), ...plan, ...bridge.slice(keep)];
}

/** A find rule's answer from flightplan (lookups.js `planQuery`), no bridge or model call: {results}, or null when an epic's status
 *  names no epic (bridge's find then). `call(op, args)`: the host's `flightplan.<op>`. */
export async function planAnswer(call, rule, {now = Date.now(), lists = []} = {}) {
  const r = await answer(call, rule, {now, lists});
  // each result marked as the rules' (the palette's Ask then follows them: SPEC.md, *Flightplan in Find*)
  return r && {results: r.results.map(x => ({...x, rule: true}))};
}
async function answer(call, rule, {now, lists}) {
  const rows = (items, date) => items.map(item => findResult(item, {date, lists, now}));
  switch (rule.kind) {
    case 'today': {
      const r = await call('today');
      return {results: r?.items?.length ? rows(r.items, r.date) : [noneRow('Nothing due today')]};
    }
    case 'week': {
      const [t, u] = await Promise.all([call('today'), call('upcoming', {query: {days: 7}})]);
      const seen = new Set(), items = [...(t?.items ?? []), ...(u?.items ?? [])].filter(i => !seen.has(i.id) && seen.add(i.id));
      return {results: items.length ? rows(items, t?.date) : [noneRow('Nothing due this week')]};
    }
    case 'needs-you': {
      const r = await call('needs-you');
      return {results: r?.items?.length ? rows(r.items) : [noneRow('Nothing needs you')]};
    }
    case 'open': case 'list': {
      const r = await call('items', {query: {...(rule.kind === 'list' ? {list: rule.slug} : {kind: 'todo'}), status: OPEN.join(','), limit: 100}});
      const items = (r?.items ?? []).slice().sort(byDue);
      return {results: items.length ? rows(items) : [noneRow(rule.kind === 'list' ? `Nothing on ${rule.title}` : 'No open todos')]};
    }
    case 'epic': {
      const found = (await call('items', {query: {kind: 'epic', q: rule.words, status: [...OPEN, 'done'].join(','), limit: 20}}))?.items ?? [];
      const named = found.filter(e => e.title.toLowerCase().includes(rule.words.toLowerCase()));
      const epic = [...named, ...found].find(e => e.status !== 'done') ?? named[0] ?? found[0];
      if (!epic) return null;
      const kids = (await call('items', {query: {parent: String(epic.id), status: [...OPEN, 'done'].join(','), limit: 500}}))?.items ?? [];
      const head = {...findResult(epic, {lists, now}), subtitle: progressLine(progressOf(epic, kids))};
      return {results: [head, ...rows(kids.filter(k => k.status === 'stuck')), ...rows(kids.filter(k => k.status === 'needs-you'))]};
    }
  }
  return null;
}

// ---------- the model ----------
/** host: Deck's host; opts `clock`, `timers`, `toastMs` (the undo toast, 3.5 s), `parseMs` (the preview's pause after typing),
 *  `reload` what a write reads again after it (default the todos view, `refresh`; the palette: its find), `page` the name Sign in to
 *  save keeps a write under (`host.resume`; the palette's find: `find`). */
export function createFlightplan(host, {clock = Date.now, timers = globalThis, toastMs = 3500, parseMs = 150, reload = null, page = 'flightplan'} = {}) {
  const subscribers = new Set();
  let stopped = false, todosGen = 0, boardGen = 0, parseGen = 0, parseTimer = null, toastTimer = null, eventsGen = 0, resumeAsked = false;
  const changed = () => { if (!stopped) for (const fn of subscribers) fn(fp); };
  const call = (op, args = {}) => host.call(`flightplan.${op}`, args);
  const id = item => ({query: {id: String(item.id)}});
  const again = () => (reload ?? fp.refresh)();
  /** Every page of a list read (`next`), at most `pages`. */
  async function all(query, pages = 4) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < pages; i++) {
      const r = await call('items', {query: {...query, limit: 500, ...(cursor ? {cursor} : {})}});
      out.push(...(r?.items ?? []));
      if (!r?.next) break;
      cursor = r.next;
    }
    return out;
  }
  const fp = {
    tab: 'todos', list: 'all', showDone: false,
    lists: [], date: newYork(clock()).day, today: [], upcoming: [], needs: [], openItems: [], doneToday: [], listItems: null,
    loading: true, error: null,
    board: {epics: [], tasks: [], loading: false, loaded: false, error: null}, area: 'All', epic: null, column: 'needs-you', over: null, expanded: new Set(),
    drawer: null, toast: null, busy: new Set(), snoozing: null,
    capture: {text: '', preview: null, error: null, busy: false, choices: null},
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    stop() { stopped = true; timers.clearTimeout(parseTimer); timers.clearTimeout(toastTimer); subscribers.clear(); },
    setTab(tab) { fp.tab = tab; if (tab === 'board' && !fp.board.loaded) fp.refreshBoard(); changed(); },
    async setList(slug) { fp.list = slug; fp.listItems = slug === 'all' ? null : fp.openItems.filter(i => i.list === slug); changed(); if (slug !== 'all') await loadList(); },
    toggleDone() { fp.showDone = !fp.showDone; changed(); },

    /** Todos: today (overdue and due today), the next 14 days, Needs you, the lists, open items (the rail's counts), done today. */
    async refresh() {
      await fp.resume();
      const gen = ++todosGen, now = newYork(clock());
      const midnight = new Date(utc(now.day) - now.offset * 60000).toISOString();
      try {
        const [today, upcoming, needs, lists, open, done] = await Promise.all([call('today', {query: MINE}), call('upcoming', {query: {days: 14, ...MINE}}),
          call('needs-you', {query: MINE}), call('lists'), all({status: OPEN.join(','), ...MINE}, 2), all({status: 'done', updatedSince: midnight, ...MINE}, 1)]);
        if (stopped || gen !== todosGen) return;
        Object.assign(fp, {date: today?.date ?? now.day, today: today?.items ?? [], upcoming: upcoming?.items ?? [], needs: needs?.items ?? [],
          lists: lists?.lists ?? [], openItems: open, doneToday: done.filter(i => i.doneAt && i.doneAt >= midnight), error: null, loading: false});
        if (fp.list !== 'all') await loadList();
      } catch (e) {
        if (stopped || gen !== todosGen) return;
        Object.assign(fp, {error: describeFailure('flightplan', e), loading: false});
      }
      changed();
    },
    /** The todos view's sections: {needs, overdue, today, upcoming (day groups), done} ('all'), or {items, done} (one list). */
    sections() {
      const needIds = new Set(fp.needs.map(i => i.id));
      if (fp.list !== 'all') {
        const items = (fp.listItems ?? []).slice().sort((a, b) => (a.due ?? '9').localeCompare(b.due ?? '9'));
        return {items, done: fp.doneToday.filter(i => i.list === fp.list)};
      }
      const dated = fp.today.filter(i => !needIds.has(i.id));
      return {needs: fp.needs, overdue: dated.filter(i => i.due && i.due.slice(0, 10) < fp.date), today: dated.filter(i => !i.due || i.due.slice(0, 10) >= fp.date),
        upcoming: byDay(fp.upcoming.filter(i => !needIds.has(i.id) && i.due), fp.date), upcomingCount: fp.upcoming.filter(i => !needIds.has(i.id) && i.due).length,
        done: fp.doneToday.filter(i => !WORK.has(i.kind))};
    },
    /** The rail: 'all' (today and upcoming, with Needs you) then each list with the owner's open count; a list outside CORE_LISTS
     *  only while it holds some (or is open). */
    rail() {
      const s = fp.list === 'all' ? fp.sections() : null;
      const n = s ? s.needs.length + s.overdue.length + s.today.length + s.upcomingCount
        : fp.needs.length + fp.today.length + fp.upcoming.length;
      return [{slug: 'all', title: 'Today and upcoming', short: 'Today', n},
        ...fp.lists.map(l => ({...l, short: l.title, n: fp.openItems.filter(i => i.list === l.slug).length, dot: listDot(fp.lists, l.slug)}))
          .filter(l => l.n || CORE_LISTS.includes(l.slug) || l.slug === fp.list)];
    },

    /** The write Sign in to save kept (host.resume; contract/flightplan.md, *Sign in to save*), retried once on return; asked once,
     *  before the first refresh. A second 401 is an error: no second trip. */
    async resume() {
      if (resumeAsked || !host.resume) return null;
      resumeAsked = true;
      try {
        const r = await host.resume(page);
        if (r) { say('Saved'); if (fp.board.loaded || fp.board.loading) fp.refreshBoard(); }
        return r;
      } catch (e) { say(describeFailure('flightplan', e).message, null, true); return null; }
    },

    // ---------- writes, each with an undo ----------
    async done(item) {
      return write(item, async () => {
        const after = await call('done', id(item));
        if (item.repeat && after?.due && after.status !== 'done' && after.due !== item.due)
          say(`Done. Next: ${dueText(after.due, fp.date)}`, () => write(item, () => call('snooze', {...id(item), body: {until: item.due}})));
        else say(`Done: ${item.title}`, () => write(item, () => call('update', {...id(item), body: {status: item.status === 'done' ? 'ready' : item.status}})));
      });
    },
    async reopen(item) { return write(item, () => call('update', {...id(item), body: {status: 'ready'}})); },
    openSnooze(item) { fp.snoozing = fp.snoozing === item.id ? null : item.id; changed(); },
    async snooze(item, choice) {
      fp.snoozing = null;
      return write(item, async () => {
        await call('snooze', {...id(item), body: {until: choice.until}});
        say(`Snoozed to ${dueText(choice.until, fp.date)}`, () => write(item, () => item.due ? call('snooze', {...id(item), body: {until: item.due}}) : call('update', {...id(item), body: {due: null}})));
      });
    },
    /** A need's action: open its page, run its backend's op, copy its command, or mark it done. */
    async act(item) {
      const {action} = needOf(item);
      try {
        if (action.kind === 'url') return await host.call('url.open', {url: action.url});
        if (action.kind === 'command') { await host.call('clipboard.copy', {text: action.command}); return say(`Copied: ${action.command}`); }
        if (action.kind === 'done') return fp.done(item);
        const op = action.backend === 'bridge' && !host.backends?.includes('bridge') ? 'bridge.need' : `${action.backend}.need`;
        const r = await host.call(op, {id: action.id});
        say(r?.message ?? 'Started');
      } catch (e) { failed(e, action.backend ?? 'flightplan'); }
    },

    // ---------- capture ----------
    type(text) {
      fp.capture = {...fp.capture, text, choices: null, error: null};
      timers.clearTimeout(parseTimer);
      const gen = ++parseGen;
      if (!text.trim()) { fp.capture.preview = null; changed(); return; }
      changed();
      parseTimer = timers.setTimeout(async () => {
        try {
          const preview = await call('parse', {body: {text: text.trim()}});
          if (!stopped && gen === parseGen) { fp.capture.preview = {...preview, for: text.trim()}; changed(); }
        } catch (e) { if (!stopped && gen === parseGen) { fp.capture.preview = null; changed(); } }
      }, parseMs);
    },
    /** The list a capture lands on: the open list, else flightplan's default (personal). */
    landing() { return fp.list !== 'all' ? fp.list : 'personal'; },
    /** Adds the line (or with one ambiguous choice's due, repeat, remind); a 422 `ambiguous` shows the choices flightplan's parse reads. */
    async add(choice = null) {
      const text = fp.capture.text.trim();
      if (!text || fp.capture.busy) return null;
      const asked = fp.capture.preview?.for === text ? fp.capture.preview.ambiguous : null;
      if (!choice && asked?.length) { fp.capture = {...fp.capture, choices: asked[0]}; changed(); return null; }
      fp.capture = {...fp.capture, busy: true, error: null};
      changed();
      try {
        const body = {text, ...(fp.list !== 'all' ? {list: fp.list} : {}), ...(choice ? {due: choice.due ?? null, repeat: choice.repeat ?? null, remind: choice.remind ?? null} : {})};
        const item = await call('add', {body});
        timers.clearTimeout(parseTimer);
        parseGen++;
        fp.capture = {text: '', preview: null, error: null, busy: false, choices: null};
        say(`Added to ${fp.lists.find(l => l.slug === item?.list)?.title ?? item?.list ?? 'Flightplan'}${item?.due ? `, ${dueText(item.due, fp.date)}` : ''}`,
          item?.id != null ? () => write(item, () => call('update', {...id(item), body: {status: 'dropped'}})) : null);
        await again();
        return item;
      } catch (e) {
        if (e?.status === 422) {
          const preview = await call('parse', {body: {text}}).catch(() => null);
          fp.capture = {...fp.capture, busy: false, preview: preview ? {...preview, for: text} : fp.capture.preview, choices: preview?.ambiguous?.[0] ?? null,
            error: preview?.ambiguous?.length ? null : 'Flightplan reads this more than one way; add a day or time.'};
        } else if (e?.renew) { fp.capture = {...fp.capture, busy: false}; failed(e); }
        else fp.capture = {...fp.capture, busy: false, error: describeFailure('flightplan', e).message};
        changed();
        return null;
      }
    },

    // ---------- the board ----------
    async refreshBoard() {
      const gen = ++boardGen;
      fp.board = {...fp.board, loading: true, error: null};
      changed();
      try {
        const status = [...OPEN, 'done'].join(',');
        const [epics, work] = await Promise.all([all({kind: 'epic', status}), all({repo: 'any', status})]);
        await Promise.all(work.filter(t => t.status === 'stuck').map(async t => {
          try { t.timeline = (await call('timeline', id(t)))?.timeline ?? []; } catch { t.timeline = []; }
        }));
        if (stopped || gen !== boardGen) return;
        fp.board = {epics, tasks: work.filter(t => t.kind !== 'epic'), loading: false, loaded: true, error: null};
      } catch (e) {
        if (stopped || gen !== boardGen) return;
        fp.board = {...fp.board, loading: false, error: describeFailure('flightplan', e)};
      }
      changed();
    },
    areas() { return ['All', ...[...new Set(fp.board.tasks.map(t => t.area).filter(Boolean))].sort()]; },
    setArea(a) { fp.area = a; changed(); },
    setEpic(epicId, status = null) { fp.epic = fp.epic === epicId && !status ? null : epicId; if (status) fp.column = status; changed(); },
    setColumn(k) { fp.column = k; changed(); },
    /** Each epic's progress: {epic, ref, why, total, done, counts: {status: n}}. */
    epics() {
      return fp.board.epics.map(epic => progressOf(epic, fp.board.tasks.filter(t => t.parent === epic.id))).sort((a, b) => (a.epic.status === 'done') - (b.epic.status === 'done') || a.epic.id - b.epic.id);
    },
    /** The columns (area and epic filters), by priority: {…status, all (every card), cards (those shown: Backlog's and Ready's
     *  top 5, Done's none, until Show all), hidden (how many not)}. */
    columns() {
      const shown = fp.board.tasks.filter(t => (fp.area === 'All' || t.area === fp.area) && (fp.epic == null || t.parent === fp.epic));
      return BOARD.map(k => STATUSES.find(s => s.k === k)).map(s => {
        const all = shown.filter(t => t.status === s.k).sort(byPriority), n = fp.expanded.has(s.k) ? all.length : COLLAPSED[s.k] ?? all.length;
        return {...s, all, cards: all.slice(0, n), hidden: Math.max(0, all.length - n)};
      });
    },
    /** A collapsed column's Show all, again its top. */
    toggleColumn(k) { if (fp.expanded.has(k)) fp.expanded.delete(k); else fp.expanded.add(k); changed(); },
    /** A card's one chip, if any: why it is stuck, else an open blocker, else its PR. */
    chips(task) {
      if (task.status === 'stuck') return [{kind: 'stuck', text: oneLine(task.timeline?.filter(e => e.detail).sort((a, b) => b.at.localeCompare(a.at))[0]?.detail, 100) || 'stuck'}];
      const byId = new Map(fp.board.tasks.map(t => [t.id, t]));
      const b = (task.blockedBy ?? []).find(id => byId.get(id)?.status !== 'done');
      if (b != null) return [{kind: 'blocked', text: `blocked by ${byId.get(b) ? refOf(byId.get(b)) : `#${b}`}`}];
      const pr = task.links?.find(x => x.type === 'pr');
      return pr ? [{kind: 'pr', text: `PR ${shortRef(pr.ref)}`}] : [];
    },
    epicOf(task) { return fp.board.epics.find(e => e.id === task.parent) ?? null; },
    /** The owner's move (a drag, the drawer's select): PATCH {status}; undo moves it back. */
    async move(task, status) {
      if (!task || task.status === status) return;
      const was = task.status;
      const apply = s => { fp.board = {...fp.board, tasks: fp.board.tasks.map(t => t.id === task.id ? {...t, status: s} : t)}; if (fp.drawer?.item.id === task.id) fp.drawer = {...fp.drawer, item: {...fp.drawer.item, status: s}}; };
      apply(status);
      changed();
      try {
        await call('update', {...id(task), body: {status}});
        say(`Moved to ${statusLabel(status)}. Your move wins over the coordinator’s rules.`, async () => {
          apply(was); changed();
          try { await call('update', {...id(task), body: {status: was}}); } catch (e) { apply(status); failed(e); }
          if (fp.drawer?.item.id === task.id) loadEvents(task);
        });
        if (fp.drawer?.item.id === task.id) loadEvents(task);
        if (!fp.board.tasks.some(t => t.id === task.id)) await again();
      } catch (e) {
        apply(was);
        failed(e);
      }
    },
    setOver(k) { if (fp.over !== k) { fp.over = k; changed(); } },
    open(task) { fp.drawer = {item: task, events: null, error: null}; changed(); loadEvents(task); },
    close() { fp.drawer = null; eventsGen++; changed(); },
    dismiss() { timers.clearTimeout(toastTimer); fp.toast = null; changed(); },
    /** The toast's Sign in to save: the session landing, which returns here for `resume`. */
    signIn() { const go = fp.toast?.signIn; fp.dismiss(); go?.(); },
    async undo() { const u = fp.toast?.undo; fp.dismiss(); await u?.(); },
  };
  async function loadList() {
    const slug = fp.list;
    try {
      const items = await all({list: slug, status: OPEN.join(','), ...MINE}, 2);
      if (!stopped && fp.list === slug) { fp.listItems = items; changed(); }
    } catch (e) { if (!stopped && fp.list === slug) { fp.error = describeFailure('flightplan', e); changed(); } }
  }
  async function loadEvents(task) {
    const gen = ++eventsGen;
    try {
      const r = await call('events', id(task));
      if (!stopped && gen === eventsGen && fp.drawer) { fp.drawer = {...fp.drawer, events: r?.events ?? []}; changed(); }
    } catch (e) { if (!stopped && gen === eventsGen && fp.drawer) { fp.drawer = {...fp.drawer, error: describeFailure('flightplan', e)}; changed(); } }
  }
  /** One write on a todo: the row busy meanwhile, then the views read again; a failure says why. */
  async function write(item, fn) {
    if (fp.busy.has(item.id)) return;
    fp.busy.add(item.id);
    changed();
    try { await fn(); } catch (e) { failed(e); }
    fp.busy.delete(item.id);
    await again();
  }
  /** A write's failure: a 401 the backend's session landing renews is one Sign in to save action (contract/flightplan.md), not an
   *  error; anything else says why. */
  function failed(e, backend = 'flightplan') {
    if (e?.renew) say('Not saved yet', null, false, () => e.renew(page));
    else say(describeFailure(backend, e).message, null, true);
  }
  /** The toast: a line and an optional Undo, for toastMs; with Sign in to save (`signIn`) until it is used or replaced. */
  function say(text, undo = null, bad = false, signIn = null) {
    timers.clearTimeout(toastTimer);
    const t = fp.toast = {text, undo, bad, signIn};
    if (!signIn) toastTimer = timers.setTimeout(() => { if (fp.toast === t) { fp.toast = null; changed(); } }, toastMs);
    changed();
  }
  return fp;
}
