import {createNeeds, needsFor} from './needs.js';
import {describeFailure, failurePage} from './failure.js';
import {boardUrl} from './projects.js';
import {watchFlightplan} from './flightplan-live.js';
// Flightplan (contract/flightplan.md): the owner's todos and the fleet's work from flightplan's API, through the host's
// registry ops (`flightplan.<op>`: the device credential on a shell, the site's session on the web). Todos (the owner's own: items with no
// `repo`, read with `repo=none`): Needs you, Overdue, Today, Upcoming by day (14 days), one list at a time, done today folded; quick add
// with flightplan's own parse as its preview. Board (work: items with a `repo`, and epics): epics with their progress, six status
// columns, a card's history. A row is a title and one line; notes only in the drawer. No DOM here (view/flightplan.js draws it); days are New York's, as
// flightplan's views are.

export const OPEN = ['backlog', 'ready', 'in-progress', 'stuck', 'needs-you'];
/** Status labels; `tone` is a dot class (foundation.css `dot-*`). */
export const STATUSES = [
  {k: 'backlog', label: 'Backlog', tone: 'muted'}, {k: 'ready', label: 'Ready', tone: 'accent'},
  {k: 'in-progress', label: 'In progress', tone: 'sent'}, {k: 'stuck', label: 'Stuck', tone: 'bad'},
  {k: 'needs-you', label: 'Needs you', tone: 'warn'}, {k: 'done', label: 'Done', tone: 'ok'}];
/* Initial render and each scroll delivery use the same bounded batch, including completed work. */
export const BOARD_BATCH = 20;
/** Board columns left to right, shared with the phone column picker. */
export const BOARD = ['backlog', 'needs-you', 'stuck', 'ready', 'in-progress', 'done'];
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
/** An item's reference, distinct from its linked GitHub issue. */
export function refOf(item) {
  return `FP-${item.id}`;
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
  if (item.question) return {detail: item.question.text, action: {kind: 'answer', label: 'Reply'}};
  if (item.needSource) {
    const need = item.needSource;
    return {detail: need.detail, action: {...(need.action ?? {kind: 'done', label: 'Done'}), backend: need.backend, id: need.id}};
  }
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
/** The product a need comes from, as a row's quiet metadata. */
export function sourceOf(item) {
  const backend = item.needSource?.backend ?? item.links?.find(l => l.type === 'need')?.ref?.split(':')[0];
  return failurePage(backend || 'flightplan');
}
/** Whether a Needs you item is a backend need with its own action (a page, an op, a command): its row has that button and no
 *  check; anything else (the owner's own items, a need with nothing to run) is a todo row with its check. */
export const asksAction = item => !!item.question || item.kind === 'need' && needOf(item).action.kind !== 'done';
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
const historyField = {title: 'title', notes: 'notes', list: 'list', kind: 'type', priority: 'priority', area: 'area',
  due: 'due date', repeat: 'repeat schedule', remind: 'reminder', urgent: 'urgency', parent: 'parent item', children: 'child items',
  blockedBy: 'dependencies', links: 'links', repo: 'repository', labels: 'labels', check: 'verification', actor: 'next actor',
  actorRef: 'assignment reference', since: 'assignment start', actorDue: 'assignment deadline', question: 'question',
  source: 'source', key: 'reference', revision: 'revision', createdAt: 'creation time', updatedAt: 'update time',
  doneAt: 'completion time', reminded: 'reminder delivery', answered: 'reply'};
/** Each pipeline step's line on an item's timeline (flightplan CONTRACT.md *Timeline*); `answered` is History's. */
const STEP = {job: e => (e.detail?.startsWith('agent task on ') ? `Agent on ${e.detail.slice(14)}` : 'Agent task started'),
  pr: e => `PR ${/#\d+$/.exec(e.ref ?? '')?.[0] ?? ''} opened`.replace('  ', ' '), batch: e => `In ${/batch \d+$/.exec(e.ref ?? '')?.[0] ?? 'a batch'}`,
  merged: () => 'Merged', release: e => `Released${e.ref ? ` ${e.ref}` : ''}`, live: () => 'Live', verified: () => 'Verified',
  'check-failed': e => `Check failed${e.ref ? `: ${e.ref}` : ''}`};
/** The item's way through the pipeline, oldest first (owner, 2026-10-19): [{at, what, took, url, bad}] from `/v1/items/<id>/timeline`;
 *  `took`: ms since the step before (null for the first), `bad` a failed check. */
export function pipelineOf(timeline = []) {
  const steps = timeline.filter(e => STEP[e.type]).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return steps.map((e, i) => ({at: e.at, what: STEP[e.type](e), took: i ? Date.parse(e.at) - Date.parse(steps[i - 1].at) : null, url: e.url ?? null, bad: e.type === 'check-failed'}));
}
/** History lines from `/v1/items/<id>/events`, newest first: [{at, what, by, owner}]. */
export function historyOf(events = []) {
  const rows = events.map(e => {
    // Creation assigns the required title; later writes can also fill previously null fields.
    const fields = Object.keys(e.changes ?? {}), created = e.changes?.title?.[0] === null && fields.every(f => e.changes[f][0] === null) && !e.occurrence && !e.ignored;
    const st = e.changes?.status, links = e.changes?.links;
    const added = (links?.[1] ?? []).filter(l => !(links?.[0] ?? []).some(old => old.type === l.type && old.ref === l.ref));
    const name = l => `${l.type === 'pr' ? 'PR' : l.type === 'sortie' ? 'agent session' : l.type} ${shortRef(l.ref).replace(/^sortie:/, '')}`;
    const removed = (links?.[0] ?? []).filter(l => !(links?.[1] ?? []).some(next => next.type === l.type && next.ref === l.ref));
    const states = (links?.[1] ?? []).filter(l => l.type === 'pr' && l.state && (links?.[0] ?? []).some(old => old.type === l.type && old.ref === l.ref && old.state !== l.state));
    const words = [...added.map(l => l.type === 'sortie' ? `Agent session ${l.ref.replace(/^sortie:/, '')} started` : `Linked ${name(l)}`),
      ...removed.map(l => `Unlinked ${name(l)}`), ...states.map(l => `${name(l)} ${l.state}`)];
    const what = created ? 'Created' : e.occurrence ? `Done for ${e.occurrence}` : [
      ...(st ? [st[1] === 'done' ? 'Done' : `Moved from ${statusLabel(st[0])} to ${statusLabel(st[1])}`] : []), ...words,
      ...fields.filter(f => f !== 'status' && (f !== 'links' || !words.length)).map(f => `Changed ${historyField[f] ?? 'details'}`)
    ].join(' · ') || 'Changed nothing';
    return {at: e.at, what: what + (e.ignored ? ' (not applied: the owner’s move wins)' : ''),
      by: e.actor === 'coordinator' ? 'Coordinator' : e.actor === 'owner-cli' ? 'You (CLI)' : [e.actor, e.source].filter(Boolean).join(' · '), owner: e.source === 'owner'};
  });
  const grouped = [];
  for (const row of rows) {
    const prev = grouped.at(-1);
    if (prev && prev.at.slice(0, 19) === row.at.slice(0, 19) && prev.by === row.by) prev.what += ` · ${row.what}`;
    else grouped.push({...row});
  }
  return grouped.reverse();
}
/** Recorded sessions only: current links, historical link additions, pipeline jobs and the explicitly assigned job.
 * Creation is claimed only by a creation event that also records the session link; writer metadata is not agent identity. */
export function agentSessions(item, events = [], timeline = []) {
  const sessions = new Map(), ranks = {assigned: 0, workedOn: 1, created: 2};
  const jobId = ref => {
    const value = /^(?:sortie:)?([0-9]+)$/.exec(String(ref ?? ''))?.[1], id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const httpUrl = url => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? url : null; } catch { return null; }
  };
  const add = (ref, url, role, record = null) => {
    const id = jobId(ref);
    if (id == null) return;
    const explicit = httpUrl(url), previous = sessions.get(id);
    const row = previous ?? {id, url: `https://sortie.wang.team/v1/jobs/${id}`, role, records: []};
    if (explicit && (!row.explicitUrl || row.url === `https://sortie.wang.team/v1/jobs/${id}`)) { row.url = explicit; row.explicitUrl = true; }
    if (ranks[role] > ranks[row.role]) row.role = role;
    if (record) {
      row.records.push(record);
      for (const field of ['actor', 'source', 'at']) if (record[field] && !row[field]) row[field] = record[field];
    }
    sessions.set(id, row);
  };
  for (const link of item.links ?? []) if (link.type === 'sortie') add(link.ref, link.url, 'workedOn');
  for (const event of events) {
    const before = event.changes?.links?.[0] ?? [], after = event.changes?.links?.[1] ?? [];
    const created = !event.ignored && !event.occurrence && event.changes?.title?.[0] === null
      && Object.values(event.changes).every(change => change[0] === null);
    for (const link of after) if (link.type === 'sortie' && !before.some(old => old.type === link.type && old.ref === link.ref)) {
      add(link.ref, link.url, created ? 'created' : 'workedOn', {kind: 'event', actor: event.actor, source: event.source, at: event.at});
    }
  }
  for (const event of timeline) if (event.type === 'job') add(event.ref, event.url, 'workedOn', {kind: 'timeline', actor: event.actor, source: event.source, at: event.at});
  if (item.actor === 'agent-job') add(item.actorRef, null, 'assigned', item.since ? {kind: 'assignment', at: item.since} : null);
  return [...sessions.values()].map(({explicitUrl, ...session}) => session);
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
/** A project as Deck's find gives it (kind `project`, flightplan's `/v1/projects` entry): its title over the rest of its `line`; the
 *  epic on the Board (`url`, Enter) and its issue (`issue`, Mod+Enter). */
export function projectResult(p) {
  const head = `${p.title} · `;
  return {kind: 'project', title: p.title, subtitle: p.line?.startsWith(head) ? p.line.slice(head.length) : p.line ?? '', project: p,
    url: boardUrl(p.id), issue: p.ref ? refUrl({id: p.id, key: `github:${p.ref}`}) : null};
}

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
    case 'projects': {
      // flightplan's sentence (`3 active: 1 waiting on you, …`), then each active project
      const r = await call('projects');
      return {results: [noneRow(r?.summary || 'No active projects'), ...(r?.projects ?? []).map(projectResult)]};
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
export function createFlightplan(host, {clock = Date.now, timers = globalThis, toastMs = 3500, parseMs = 150, reload = null, page = 'flightplan', needsSource = null} = {}) {
  const subscribers = new Set();
  const source = needsSource ?? (host.backends?.includes('flightplan') ? needsFor(host) : createNeeds(host, {backends: ['flightplan']}));
  let stopped = false, todosGen = 0, boardGen = 0, parseGen = 0, parseTimer = null, toastTimer = null, eventsGen = 0, listGen = 0, resumeAsked = false;
  let todosReading = 0, boardReading = 0;
  const relatedItems = new Map(), columnLimits = new Map();
  const resetColumns = () => columnLimits.clear();
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
  const needItem = need => need.item ? {...need.item, title: need.title, ...(need.backend !== 'flightplan' ? {needSource: need} : {})}
    : {id: `need:${need.backend}:${need.id}`, kind: 'need', status: 'needs-you', title: need.title, needSource: need, list: null};
  const fp = {
    tab: 'todos', list: 'all', showDone: false,
    needsSource: source, needsFailures: source.failures, lists: [], date: newYork(clock()).day, today: [], upcoming: [], needs: source.needs.map(needItem), openItems: [], doneToday: [], listItems: null,
    loading: true, error: null, liveError: null,
    board: {epics: [], tasks: [], projects: [], completed: [], loading: false, loaded: false, error: null}, area: 'All', epic: null, priority: '', label: '', query: '', column: 'needs-you', over: null,
    drawer: null, toast: null, busy: new Set(), snoozing: null,
    capture: {text: '', preview: null, error: null, busy: false, choices: null},
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    stop() { offNeeds(); stopped = true; timers.clearTimeout(parseTimer); timers.clearTimeout(toastTimer); live.stop(); subscribers.clear(); },
    checkUpdates() { return live.check(); },
    setTab(tab) { const previous = fp.tab; fp.tab = tab; if (tab === 'board' && (!fp.board.loaded || previous !== tab)) fp.refreshBoard(); else if (tab === 'todos' && previous !== tab && !fp.loading) fp.refresh(); changed(); },
    async setList(slug) { fp.list = slug; fp.listItems = slug === 'all' ? null : fp.openItems.filter(i => i.list === slug); changed(); if (slug !== 'all') await loadList(); },
    toggleDone() { fp.showDone = !fp.showDone; changed(); },

    /** Todos: today (overdue and due today), the next 14 days, Needs you, the lists, open items (the rail's counts), done today. */
    async refresh() {
      await fp.resume();
      const gen = ++todosGen, now = newYork(clock());
      const midnight = new Date(utc(now.day) - now.offset * 60000).toISOString();
      todosReading++;
      try {
        // Shared Needs has its own subscription; an unrelated backend must not hold local reads or actions.
        (fp.loading ? source.ensure() : source.refresh()).catch(e => failed(e));
        const [today, upcoming, lists, open, done] = await Promise.all([call('today', {query: MINE}), call('upcoming', {query: {days: 14, ...MINE}}), call('lists'), all({status: OPEN.join(','), ...MINE}, 2), all({status: 'done', updatedSince: midnight, ...MINE}, 1)]);
        if (stopped || gen !== todosGen) return;
        Object.assign(fp, {date: today?.date ?? now.day, today: today?.items ?? [], upcoming: upcoming?.items ?? [],
          lists: lists?.lists ?? [], openItems: open, doneToday: done.filter(i => i.doneAt && i.doneAt >= midnight), error: null, loading: false});
        if (fp.list !== 'all') await loadList();
      } catch (e) {
        if (stopped || gen !== todosGen) return;
        Object.assign(fp, {error: describeFailure('flightplan', e), loading: false});
      } finally { todosReading--; }
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

    /** The write Sign in to save kept (host.resume; contract/backends.md, *Session renewal*), retried once on return; asked once,
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
        return after;
      });
    },
    async answer(item, body) {
      return write(item, async () => {
        const after = await call('answer', {...id(item), body});
        say('Reply saved');
        return after;
      });
    },
    async reopen(item) { return write(item, () => call('update', {...id(item), body: {status: 'ready'}})); },
    openSnooze(item) { fp.snoozing = fp.snoozing === item.id ? null : item.id; changed(); },
    async snooze(item, choice) {
      fp.snoozing = null;
      return write(item, async () => {
        const after = await call('snooze', {...id(item), body: {until: choice.until}});
        say(`Snoozed to ${dueText(choice.until, fp.date)}`, () => write(item, () => item.due ? call('snooze', {...id(item), body: {until: item.due}}) : call('update', {...id(item), body: {due: null}})));
        return after;
      });
    },
    /** A need's action: open its page, run its backend's op, copy its command, or mark it done. */
    async act(item) {
      const {action} = needOf(item);
      if (action.kind === 'answer') return fp.open(item);
      if (action.kind === 'done') return fp.done(item);
      if (fp.busy.has(item.id)) return;
      fp.busy.add(item.id); changed();
      try {
        if (action.kind === 'url') return await host.call('url.open', {url: action.url});
        if (action.kind === 'command') { await host.call('clipboard.copy', {text: action.command}); return say('Instructions copied'); }
        const op = action.backend === 'bridge' && !host.backends?.includes('bridge') ? 'bridge.need' : `${action.backend}.need`;
        const r = await host.call(op, {id: action.id});
        say(r?.message ?? 'Started');
        source.refresh({force: true}).catch(e => failed(e, action.backend));
      } catch (e) { failed(e, action.backend ?? 'flightplan'); }
      finally { fp.busy.delete(item.id); changed(); }
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
        invalidateReads();
        const item = await call('add', {body});
        invalidateReads();
        applyItem(item);
        source.patchItem?.(item);
        timers.clearTimeout(parseTimer);
        parseGen++;
        fp.capture = {text: '', preview: null, error: null, busy: false, choices: null};
        say(`Added to ${fp.lists.find(l => l.slug === item?.list)?.title ?? item?.list ?? 'Flightplan'}${item?.due ? `, ${dueText(item.due, fp.date)}` : ''}`,
          item?.id != null ? () => write(item, () => call('update', {...id(item), body: {status: 'dropped'}})) : null, false, null,
          item?.list ? {label: `View ${fp.lists.find(l => l.slug === item.list)?.title ?? item.list}`, run: () => { fp.setTab('todos'); fp.setList(item.list); }} : null);
        reconcile(item);
        return item;
      } catch (e) {
        if (e?.status === 422) {
          const preview = await call('parse', {body: {text}}).catch(() => null);
          fp.capture = {...fp.capture, busy: false, preview: preview ? {...preview, for: text} : fp.capture.preview, choices: preview?.ambiguous?.[0] ?? null,
            error: preview?.ambiguous?.length ? null : 'Flightplan reads this more than one way; add a day or time.'};
        } else if (e?.renew) { fp.capture = {...fp.capture, busy: false}; failed(e); }
        else fp.capture = {...fp.capture, busy: false, error: describeFailure('flightplan', e).message};
        changed();
        reconcile();
        return null;
      }
    },

    // ---------- the board ----------
    async refreshBoard() {
      const gen = ++boardGen, detailGen = eventsGen;
      boardReading++;
      fp.board = {...fp.board, loading: !fp.board.loaded, error: null};
      changed();
      try {
        const status = [...OPEN, 'done'].join(',');
        const [epics, work, projects] = await Promise.all([all({kind: 'epic', status}), all({repo: 'any', status}), call('projects')]);
        await Promise.all(work.filter(t => t.status === 'stuck').map(async t => {
          try { t.timeline = (await call('timeline', id(t)))?.timeline ?? []; } catch { t.timeline = []; }
        }));
        if (stopped || gen !== boardGen) return;
        // An item read opened during this batch is newer than its collection snapshot.
        const current = detailGen !== eventsGen && fp.drawer?.events ? fp.drawer.item : null;
        fp.board = {projects: projects?.projects ?? [], completed: projects?.completed ?? [], epics: epics.map(t => t.id === current?.id ? current : t), tasks: work.filter(t => t.kind !== 'epic').map(t => t.id === current?.id ? current : t), loading: false, loaded: true, error: null};
      } catch (e) {
        if (stopped || gen !== boardGen) return;
        fp.board = {...fp.board, loading: false, error: describeFailure('flightplan', e)};
      } finally { boardReading--; }
      changed();
    },
    areas() { return ['All', ...[...new Set(fp.board.tasks.map(t => t.area).filter(Boolean))].sort()]; },
    setArea(a) { if (fp.area === a) return; fp.area = a; resetColumns(); changed(); },
    setPriority(priority) { if (fp.priority === priority) return; fp.priority = priority; resetColumns(); changed(); },
    setLabel(label) { if (fp.label === label) return; fp.label = label; resetColumns(); changed(); },
    setQuery(query) { if (fp.query === query) return; fp.query = query; resetColumns(); changed(); },
    priorities() { return ['P0', 'P1', 'P2', 'P3', 'none']; },
    labels() { return [...new Set(fp.board.tasks.flatMap(t => t.labels ?? []))].sort((a, b) => a.localeCompare(b)); },
    setEpic(epicId, status = null) { const next = fp.epic === epicId && !status ? null : epicId; if (next !== fp.epic) resetColumns(); fp.epic = next; if (status) fp.column = status; changed(); },
    setColumn(k) { fp.column = k; changed(); },
    /** Each epic's progress: {epic, ref, why, total, done, counts: {status: n}}. */
    epics() {
      return [...fp.board.projects, ...fp.board.completed].map(p => {
        const epic = fp.board.epics.find(e => e.id === p.id);
        return {...p, repo: epic?.repo ?? null, taskCount: p.total, ref: p.ref ? shortRef(p.ref) : null, why: oneLine(epic?.notes) || null,
          epic: {...epic, id: p.id, title: p.title, status: p.verdict === 'done' ? 'done' : 'in-progress'}};
      });
    },
    /** Active backend projects by default; completed history only on request or to preserve the selected project. */
    projects({completed = false} = {}) { return fp.epics().filter(e => completed || e.verdict !== 'done' || e.epic.id === fp.epic); },
    /** Combined filters run before batching so a match beyond the initial cards is reachable immediately. */
    columns({query = fp.query} = {}) {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean), epics = new Map(fp.board.epics.map(e => [e.id, e]));
      const shown = fp.board.tasks.filter(t => (fp.area === 'All' || t.area === fp.area) && (fp.epic == null || t.parent === fp.epic)
        && (!fp.priority || (fp.priority === 'none' ? !t.priority : t.priority === fp.priority))
        && (!fp.label || (t.labels ?? []).includes(fp.label))
        && words.every(word => `${t.title} ${refOf(t)} ${[t.key?.replace(/^github:/, ''), ...(t.links ?? []).map(l => l.ref)].filter(Boolean).flatMap(ref => [ref, shortRef(ref)]).join(' ')} ${t.repo ?? ''} ${(epics.get(t.parent) ?? relatedItems.get(t.parent))?.title ?? ''}`.toLowerCase().includes(word)));
      return BOARD.map(k => STATUSES.find(s => s.k === k)).map(s => {
        const all = shown.filter(t => t.status === s.k).sort(byPriority), n = columnLimits.get(s.k) ?? BOARD_BATCH;
        return {...s, all, cards: all.slice(0, n), hidden: Math.max(0, all.length - n)};
      });
    },
    loadMoreColumn(k) { const column = fp.columns().find(c => c.k === k); if (!column?.hidden) return; columnLimits.set(k, column.cards.length + BOARD_BATCH); changed(); },
    /** A card's one chip, if any: why it is stuck, else an open blocker, else its PR. */
    chips(task) {
      if (task.status === 'stuck') return [{kind: 'stuck', text: oneLine(task.timeline?.filter(e => e.detail).sort((a, b) => b.at.localeCompare(a.at))[0]?.detail, 100) || 'stuck'}];
      const byId = new Map(fp.board.tasks.map(t => [t.id, t]));
      const b = (task.blockedBy ?? []).find(id => byId.get(id)?.status !== 'done');
      if (b != null) return [{kind: 'blocked', text: `blocked by ${byId.get(b) ? refOf(byId.get(b)) : `FP-${b}`}`}];
      const pr = task.links?.find(x => x.type === 'pr');
      return pr ? [{kind: 'pr', text: `PR ${shortRef(pr.ref)}`}] : [];
    },
    itemById(id) { return knownItems().get(Number(id)) ?? null; },
    epicOf(task) { return fp.board.epics.find(e => e.id === task.parent) ?? relatedItems.get(task.parent) ?? null; },
    /** The owner's move (a drag, the drawer's select): PATCH {status}; undo moves it back. */
    async move(task, status) {
      if (!task || task.status === status) return;
      const was = task.status;
      return write(task, async () => {
        const after = await call('update', {...id(task), body: {status}});
        say(`Moved to ${statusLabel(status)}`, () => fp.move({...task, status}, was));
        return after;
      }, {...task, status});
    },
    setOver(k) { if (fp.over !== k) { fp.over = k; changed(); } },
    async edit(task, body) { await write(task, () => call('update', {...id(task), body})); },
    open(task) { if (task.needSource && !task.needSource.item) return; fp.drawer = {item: task, events: null, error: null, related: relations(task), timeline: task.timeline ?? [], agentSessions: agentSessions(task, [], task.timeline), sessionError: null}; changed(); loadEvents(task); },
    openRelated(id) { const item = fp.itemById(id); fp.open(item ?? {id: Number(id), title: `FP-${id}`, status: null}); },
    close() { fp.drawer = null; eventsGen++; changed(); },
    dismiss() { timers.clearTimeout(toastTimer); fp.toast = null; changed(); },
    /** The toast's Sign in to save: the session landing, which returns here for `resume`. */
    signIn() { const go = fp.toast?.signIn; fp.dismiss(); go?.(); },
    async undo() { const u = fp.toast?.undo; fp.dismiss(); await u?.(); },
  };
  async function loadList() {
    const slug = fp.list, gen = ++listGen;
    try {
      const items = await all({list: slug, status: OPEN.join(','), ...MINE}, 2);
      if (!stopped && gen === listGen && fp.list === slug) { fp.listItems = items; changed(); }
    } catch (e) { if (!stopped && gen === listGen && fp.list === slug) { fp.error = describeFailure('flightplan', e); changed(); } }
  }
  async function loadEvents(task) {
    const gen = ++eventsGen;
    try {
      const timelineRead = call('timeline', id(task)).then(value => ({value}), error => ({error}));
      const [item, r] = await Promise.all([call('item', id(task)), call('events', id(task))]);
      if (!stopped && gen === eventsGen && fp.drawer) {
        fp.board = {...fp.board, tasks: fp.board.tasks.map(t => t.id === item.id ? item : t), epics: fp.board.epics.map(t => t.id === item.id ? item : t)};
        relatedItems.set(item.id, item);
        const timeline = task.timeline ?? [];
        fp.drawer = {...fp.drawer, item, events: r?.events ?? [], timeline, agentSessions: agentSessions(item, r?.events, timeline),
          sessionError: null, error: null, related: relations(item)}; changed();
        // Pipeline history is optional; a slow timeline must not hold the current item and its field history.
        timelineRead.then(result => {
          if (stopped || gen !== eventsGen || fp.drawer?.item.id !== item.id) return;
          const timeline = result.value?.timeline ?? [];
          fp.drawer = {...fp.drawer, timeline, agentSessions: agentSessions(fp.drawer.item, fp.drawer.events, timeline),
            sessionError: result.error ? describeFailure('flightplan', result.error) : null}; changed();
        });
        await loadRelated(item, gen);
      }
    } catch (e) { if (!stopped && gen === eventsGen && fp.drawer) { fp.drawer = {...fp.drawer, error: describeFailure('flightplan', e)}; changed(); } }
  }
  function knownItems() {
    const items = new Map(relatedItems);
    for (const item of [...fp.openItems, ...fp.today, ...fp.upcoming, ...fp.doneToday, ...fp.needs, ...fp.board.epics, ...fp.board.tasks, ...(fp.drawer ? [fp.drawer.item] : [])]) items.set(item.id, item);
    return items;
  }
  function relations(item) {
    const known = knownItems(), entry = id => known.get(Number(id)) ?? {id: Number(id), title: `FP-${id}`, missing: true};
    return {parent: item.parent != null ? entry(item.parent) : null, children: (item.children ?? []).map(entry),
      blockedBy: (item.blockedBy ?? []).map(entry), blocking: [...known.values()].filter(i => (i.blockedBy ?? []).includes(item.id)), loading: false, error: null};
  }
  async function loadRelated(item, gen) {
    const related = relations(item), refs = [related.parent, ...related.children, ...related.blockedBy].filter(Boolean);
    const ids = [...new Set(refs.filter(i => i.missing).map(i => i.id))];
    if (!ids.length) return;
    fp.drawer = {...fp.drawer, related: {...related, loading: true}}; changed();
    let error = null;
    // Bound concurrent detail requests when an epic has many children absent from the Board snapshot.
    for (let n = 0; n < ids.length; n += 4) {
      await Promise.all(ids.slice(n, n + 4).map(async id => {
        try {
          const found = await call('item', {query: {id: String(id)}});
          if (!stopped && gen === eventsGen && found?.id === id) relatedItems.set(id, found);
        } catch (e) { if (e.status !== 404) error = describeFailure('flightplan', e); }
      }));
      if (stopped || gen !== eventsGen || fp.drawer?.item.id !== item.id) return;
    }
    fp.drawer = {...fp.drawer, related: {...relations(item), error}}; changed();
  }
  // Reads begun before a write cannot restore the previous item after it succeeds (including a pending drawer read).
  function invalidateReads() { todosGen++; boardGen++; eventsGen++; listGen++; }
  /** Apply the server's complete item to each visible snapshot. Classification matches Flightplan's date/list views. */
  function applyItem(item) {
    if (item?.id == null) return;
    relatedItems.set(item.id, item);
    const replace = (items, include) => {
      const found = items.some(i => i.id === item.id);
      const next = items.filter(i => i.id !== item.id);
      if (include) next.splice(found ? items.findIndex(i => i.id === item.id) : next.length, 0, item);
      return next;
    };
    const previous = fp.board.tasks.find(t => t.id === item.id);
    if (previous && previous.status !== item.status) {
      // Carry the saved status delta until the API revalidates; never rebuild totals from the Board's task subset.
      const adjust = p => {
        if (p.id !== item.parent) return p;
        const counts = {...p.counts, [previous.status]: (p.counts[previous.status] ?? 0) - 1,
          [item.status]: (p.counts[item.status] ?? 0) + 1};
        return {...p, counts, done: p.done + Number(item.status === 'done') - Number(previous.status === 'done'),
          total: p.total + Number(previous.status === 'dropped') - Number(item.status === 'dropped')};
      };
      fp.board = {...fp.board, projects: fp.board.projects.map(adjust), completed: fp.board.completed.map(adjust)};
    }
    const own = !item.repo, open = OPEN.includes(item.status), due = item.due?.slice(0, 10);
    fp.today = replace(fp.today, own && open && due && due <= fp.date);
    fp.upcoming = replace(fp.upcoming, own && open && due > fp.date && due <= addDays(fp.date, 14));
    fp.openItems = replace(fp.openItems, own && open);
    fp.doneToday = replace(fp.doneToday, own && item.status === 'done' && item.doneAt && newYork(Date.parse(item.doneAt)).day === fp.date);
    if (fp.listItems) fp.listItems = replace(fp.listItems, own && open && item.list === fp.list);
    fp.board = {...fp.board, tasks: replace(fp.board.tasks, !!item.repo && item.kind !== 'epic' && item.status !== 'dropped'),
      epics: replace(fp.board.epics, item.kind === 'epic' && item.status !== 'dropped')};
    if (fp.drawer) { const current = fp.drawer.item.id === item.id ? item : fp.drawer.item; fp.drawer = {...fp.drawer, item: current, related: relations(current), agentSessions: agentSessions(current, fp.drawer.events ?? [], fp.drawer.timeline ?? [])}; }
    changed();
  }
  /** Revalidate independently after showing the saved item; global Needs never gates these local reads. */
  function reconcile(item) {
    if (stopped) return;
    Promise.all([again(), ...(fp.board.loaded || fp.board.loading ? [fp.refreshBoard()] : []), ...(item && fp.drawer?.item.id === item.id ? [loadEvents(item)] : [])]).catch(e => failed(e));
  }
  /** Pending until the write answers; success updates all snapshots immediately, failure retains the saved state. */
  async function write(item, fn, optimistic = null) {
    if (fp.busy.has(item.id)) return;
    invalidateReads();
    fp.busy.add(item.id);
    if (optimistic) applyItem(optimistic);
    changed();
    try {
      const result = await fn();
      invalidateReads();
      const after = {...item, ...result};
      applyItem(after);
      source.patchItem?.(after);
      // Canonical Needs refreshes independently; local action completion never waits for another backend.
      source.refresh({force: true}).catch(e => failed(e));
      reconcile(after);
      return after;
    } catch (e) {
      invalidateReads();
      if (optimistic) applyItem(item);
      failed(e);
      reconcile();
      return null;
    } finally {
      fp.busy.delete(item.id);
      changed();
    }
  }
  /** A write's failure: a 401 the backend's session landing renews is one Sign in to save action (contract/flightplan.md), not an
   *  error; anything else says why. */
  function failed(e, backend = 'flightplan') {
    if (e?.renew) say('Not saved yet', null, false, () => e.renew(page));
    else say(describeFailure(backend, e).message, null, true);
  }
  /** The toast: a line and an optional Undo, for toastMs; with Sign in to save (`signIn`) until it is used or replaced. */
  function say(text, undo = null, bad = false, signIn = null, action = null) {
    timers.clearTimeout(toastTimer);
    const t = fp.toast = {text, undo, bad, signIn, action};
    if (!signIn) toastTimer = timers.setTimeout(() => { if (fp.toast === t) { fp.toast = null; changed(); } }, toastMs);
    changed();
  }
  const offNeeds = source.subscribe(() => {
    if (stopped) return;
    fp.needs = source.needs.map(needItem); fp.needsFailures = source.failures; changed();
  });
  const live = watchFlightplan({timers, document: page === 'flightplan' ? globalThis.document : null,
    read: async options => { const result = await host.call('flightplan.changes', {}, options); return result?.version ? {version: `${result.version}:${newYork(clock()).day}`} : result; },
    busy: () => fp.busy.size > 0 || fp.capture.busy || fp.loading || todosReading > 0 || boardReading > 0,
    refresh: async () => {
      await (fp.tab === 'board' ? fp.refreshBoard() : fp.refresh());
      if (stopped) return false;
      if (fp.drawer) await loadEvents(fp.drawer.item);
      if (fp.tab === 'board') source.refresh().catch(() => {});
      return !(fp.tab === 'board' ? fp.board.error : fp.error);
    },
    error: e => { const next = e ? describeFailure('flightplan', e) : null; if (JSON.stringify(next) !== JSON.stringify(fp.liveError)) { fp.liveError = next; changed(); } },
  });
  return fp;
}
