// A house record in the Things full view (contract/things.md *House record*; the model in ../house-record.js): its facts edited in
// place (a value clicked becomes its field: Save, or Esc), open items (Accept, Fill in, Answer, Verify), live state from Habitat, a
// panel's breakers, events newest first (+ Event; each edited or deleted), warranty, installer, notes, photos and the record's history.
// Every edit is bridge's at once: its answer is the record now, drawn from it, and a toast says Saved. Edits show only to a member
// who may write (member.js; never the agent member); shared screens never mount Things. A section with nothing in it is left out.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {EVENT_TYPES, FIELDS, breakerLine, breakers, createRecordEditor, editValue, eventFields, eventForm, eventWhen, fillItem,
  historyLine, historyWho, installerFacts, openItems, recordEvents, recordFacts, recordPhotos, warrantyFacts} from '../house-record.js';
import {countText, dateTimeText, fieldLabel, isoDay, plural} from '../format.js';
import {factValue} from '../readable-facts.js';
import {memberCan, pageMember} from '../host/member.js';
import {openable, resourcePath} from '../host/host.js';
import {describeFailure} from '../failure.js';
import {Facts, Section, SectionHead} from './drawer.js';
import {DetailList} from './detail-list.js';
import {Button, Field} from './controls.js';
import {Failure} from './page-state.js';
import {Toast, useOutcome} from './toast.js';
const html = htm.bind(h);

/** May this page write (the agent member may not; an unknown member may: bridge decides). */
export const canWrite = () => memberCan(pageMember(), 'write');
const open = (host, url) => { if (openable(url)) host.call('url.open', {url}).catch(() => {}); };
// a field's message from bridge's check: by its path, else by its last part (an event's `title`)
const messageFor = (fields, name) => fields?.[name] ?? fields?.[String(name).split('.').at(-1)] ?? null;
const otherMessages = (fields, names) => Object.entries(fields ?? {}).filter(([k]) => !names.some(n => k === n || k === String(n).split('.').at(-1))).map(([, m]) => m);

/** One form of an edit: `fields` [{name, label, as?, hint?, options?: [[value, text]], inputMode?}], `initial` values; `onSave(values)`
 *  answers `{errors}` (its own checks) or saves; `state` the edit's (busy, error, bridge's `fields`). Esc cancels. */
export function EditForm({label, heading = null, fields, initial = {}, state, onSave, onCancel, save = 'Save', extra = null}) {
  const [values, setValues] = useState(initial), [errors, setErrors] = useState({});
  const ref = useRef(null);
  useEffect(() => { ref.current?.querySelector('input, textarea, select')?.focus({preventScroll: true}); }, []);
  const set = name => event => setValues(v => ({...v, [name]: event.currentTarget.value}));
  const submit = event => { event.preventDefault(); setErrors(onSave(values)?.errors ?? {}); };
  const server = state?.fields, others = otherMessages(server, fields.map(f => f.name));
  const error = name => errors[name] ?? messageFor(server, name);
  return html`<form ref=${ref} class="thing-form" aria-label=${label} onSubmit=${submit} noValidate
      onKeyDown=${event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    ${heading ? html`<b class="thing-form-title">${heading}</b>` : null}
    ${fields.map(f => f.options ? html`<${Field} key=${f.name} as="select" label=${f.label} hint=${f.hint} error=${error(f.name)} name=${f.name}
        value=${values[f.name] ?? ''} onChange=${set(f.name)}>${f.options.map(([value, text]) => html`<option value=${value}>${text}</option>`)}<//>`
      : html`<${Field} key=${f.name} as=${f.as ?? 'input'} type=${f.as ? undefined : 'text'} label=${f.label} hint=${f.hint} error=${error(f.name)}
        name=${f.name} value=${values[f.name] ?? ''} onInput=${set(f.name)} inputMode=${f.inputMode} autocomplete="off" />`)}
    ${others.length || (state?.error && !server) ? html`<p class="dk-field-error thing-form-error" role="alert">${others.length ? others.join(' ') : `Not saved. ${state.error.detail}`}</p>` : null}
    <div class="thing-form-actions">
      <${Button} variant="primary" type="submit" disabled=${state?.busy}>${state?.busy ? 'Saving…' : save}<//>
      <${Button} variant="quiet" type="button" onClick=${onCancel}>Cancel<//>
      ${extra}
    </div>
  </form>`;
}

/** Facts whose values a writer edits in place: a click on one is its field (Save, Esc); a phone or site also opens. */
export function EditableFacts({facts, editor, host, write, prefix}) {
  const [editing, setEditing] = useState(null);
  if (!facts.length) return null;
  return html`<dl class="dk-facts thing-facts">${facts.map(f => {
    const key = `${prefix}:${f.path ?? f.label}`;
    if (write && f.path && editing === f.path) return html`<div key=${key} class="thing-fact-edit">
      <${EditForm} label=${`Edit ${f.label.toLowerCase()}`} state=${editor.state(key)} initial=${{[f.path]: f.raw}} onCancel=${() => { editor.clear(key); setEditing(null); }}
        fields=${[{name: f.path, label: f.label, as: f.options ? undefined : f.as, options: f.options, hint: f.hint, inputMode: f.inputMode}]}
        onSave=${values => { editor.edit(key, {[f.path]: editValue(f, values[f.path])}).then(ok => { if (ok) setEditing(null); }); }} /></div>`;
    const link = f.url && openable(f.url(f.raw)) ? f.url(f.raw) : null;
    return html`<div key=${key}><dt>${f.label}</dt><dd>${write && f.path
      ? html`<button type="button" class="dk-btn text thing-value" title=${`Edit ${f.label.toLowerCase()}`} aria-label=${`${f.label}: ${f.value}. Edit`}
          onClick=${() => setEditing(f.path)}>${f.value}</button>${link ? html`<button type="button" class="dk-btn text thing-open-link" aria-label=${`Open ${f.value}`} onClick=${() => open(host, link)}>↗</button>` : null}`
      : link ? html`<button type="button" class="dk-btn text thing-link" onClick=${() => open(host, link)}>${f.value}</button>` : f.value}</dd></div>`;
  })}</dl>`;
}

/** A paragraph a writer edits in place (the record's notes): a click on it is its field. */
export function EditableText({path, label, text, editor, write}) {
  const [editing, setEditing] = useState(false), key = `text:${path}`;
  if (write && editing) return html`<${EditForm} label=${`Edit ${label.toLowerCase()}`} state=${editor.state(key)} initial=${{[path]: text}}
    fields=${[{name: path, label, as: 'textarea'}]} onCancel=${() => { editor.clear(key); setEditing(false); }}
    onSave=${v => { editor.edit(key, {[path]: String(v[path] ?? '').trim() || null}).then(ok => { if (ok) setEditing(false); }); }} />`;
  return write ? html`<button type="button" class="dk-btn text thing-value thing-text" aria-label=${`${label}: ${text}. Edit`} onClick=${() => setEditing(true)}>${text}</button>`
    : html`<p class="thing-notes">${text}</p>`;
}

const ACTION = {field: 'Fill in', answer: 'Answer', breaker: 'Verify'};
const fillFields = field => [{name: field, label: FIELDS[field].label, hint: FIELDS[field].hint, inputMode: FIELDS[field].inputMode}];

/** The record's open items, one per subject, each with its actions; one form open at a time. None: no section. */
export function OpenItems({thing, editor, onOpen}) {
  const items = openItems(thing, {hidden: editor.hidden}), write = canWrite();
  const [form, setForm] = useState(null);
  if (!items.length) return null;
  const close = key => { editor.clear(key); setForm(null); };
  const done = ok => { if (ok) setForm(null); };
  const formOf = item => {
    const cancel = () => close(item.key), state = editor.state(item.key), label = `${ACTION[item.kind]}: ${item.title ?? FIELDS[item.field].label}`;
    if (item.kind === 'field') return html`<${EditForm} label=${label} fields=${fillFields(item.field)} state=${state} onCancel=${cancel}
      onSave=${v => { const value = String(v[item.field] ?? '').trim(); if (!value) return {errors: {[item.field]: `Give the ${FIELDS[item.field].label.toLowerCase()}`}}; editor.edit(item.key, {[item.field]: value}).then(done); }} />`;
    if (item.kind === 'answer') return html`<${EditForm} label=${label} fields=${[{name: 'answer', label: 'Answer', as: 'textarea', hint: 'Clears the question; history keeps the answer'}]}
      state=${state} onCancel=${cancel} onSave=${v => { if (!String(v.answer ?? '').trim()) return {errors: {answer: 'An answer is required'}}; editor.answer(item.key, item.on, v.answer.trim()).then(done); }} />`;
    const b = item.breaker;
    return html`<${EditForm} label=${label} state=${state} onCancel=${cancel} initial=${b.label ? {answer: 'confirmed'} : {answer: 'feeds'}}
      fields=${[...(b.label ? [{name: 'answer', label: 'The loads', options: [['confirmed', `As labelled: “${b.label}”`], ['feeds', 'It feeds something else']]}] : []),
        {name: 'feeds', label: 'What it feeds', hint: b.label ? 'Only when it is not as labelled' : 'What turns off with it'}]}
      onSave=${v => {
        const feeds = v.answer === 'confirmed' && b.label ? b.label : String(v.feeds ?? '').trim();
        if (!feeds) return {errors: {feeds: 'Say what it feeds'}};
        editor.breaker(item.key, b.slot, {feeds}).then(done);
      }} />`;
  };
  return html`<${Section} title="Open items" meta=${countText(items.length)} level=${3}>
    <ul class="thing-open" role="list">${items.map(item => {
      const s = item.suggestion, fill = item.fill ? fillItem(item) : null, state = editor.state(item.key);
      return html`<li key=${item.key} class="thing-open-item" data-kind=${item.kind}>
        <div class="thing-open-lines"><b>${item.title}</b>${item.line ? html`<span>${item.line}</span>` : null}
          ${s?.document?.id != null ? html`<button type="button" class="dk-btn text thing-link" onClick=${() => onOpen?.(s.document)}>Open ${s.document.title ?? 'document'}</button>` : null}</div>
        ${!write ? null : item.kind === 'suggestion' ? html`
            ${fill && form === fill.key ? formOf(fill) : html`<div class="thing-open-actions">
              <${Button} variant="primary" disabled=${state?.busy} onClick=${() => editor.accept(s, item.key)}>${state?.busy ? 'Saving…' : 'Accept'}<//>
              ${fill ? html`<button type="button" class="dk-btn text thing-link thing-open-other" onClick=${() => setForm(fill.key)}>Fill in another</button>` : null}</div>`}
            ${state?.error ? html`<p class="dk-field-error" role="alert">Not saved. ${state.fields ? Object.values(state.fields).join(' ') : state.error.detail}</p>` : null}`
          : form === item.key ? formOf(item)
          : html`<div class="thing-open-actions"><${Button} onClick=${() => setForm(item.key)}>${ACTION[item.kind]}<//></div>`}
      </li>`;
    })}</ul>
  <//>`;
}

const EVENT_FIELDS = [
  {name: 'date', label: 'When', hint: 'A day, month or year (YYYY-MM-DD, YYYY-MM, YYYY), or a range start/end', inputMode: 'numeric'},
  {name: 'type', label: 'What happened', options: EVENT_TYPES.map(t => [t, fieldLabel(t)])},
  {name: 'status', label: 'Status', options: [['resolved', 'Resolved'], ['open', 'Open']]},
  {name: 'title', label: 'Title'},
  {name: 'notes', label: 'Notes', as: 'textarea', hint: 'Optional: what was done, what it cost'},
  {name: 'by', label: 'By', hint: 'Optional: who did the work'},
];
const today = () => isoDay(new Date());
/** The record's events, newest first; "+ Event" adds one, a click on one edits or deletes it (Delete asks first). No events: only the
 *  heading with "+ Event", for a member who may write; else no section. */
export function Events({thing, editor, view}) {
  const events = recordEvents(thing), write = canWrite();
  const [form, setForm] = useState(null), [confirm, setConfirm] = useState(false);
  if (!events.length && !write) return null;
  const close = key => { editor.clear(key); setForm(null); setConfirm(false); };
  const adding = form === 'event:new', current = form && !adding ? events.find(e => `event:${e.id}` === form) : null;
  const save = (key, editing, run) => values => { const r = eventFields(values, {editing}); if (r.errors) return r; run(r.event).then(ok => { if (ok) close(key); }); return null; };
  const add = write && !form ? html`<${Button} onClick=${() => setForm('event:new')}>+ Event<//>` : null;
  return html`<div class="thing-events">
    ${events.length ? html`<${DetailList} title="Events" sorted=${true} view=${view} listKey="thing-events" resetKey=${thing.id} actions=${add}
      onOpen=${write ? row => { editor.clear(`event:${row.id}`); setConfirm(false); setForm(`event:${row.id}`); } : null}
      items=${events.map(e => ({id: e.id, glyph: 'day', title: e.title, sub: [eventWhen(e), fieldLabel(e.type ?? 'other'), e.by].filter(Boolean).join(' · '),
        summary: e.notes ?? null, badge: e.status === 'open' ? {text: 'Open', tone: 'warn'} : {text: 'Resolved', tone: 'ok'}}))} />`
      : html`<section class="dk-section" aria-label="Events"><${SectionHead} level=${3} title="Events" actions=${add} /></section>`}
    ${adding ? html`<${EditForm} label="Add an event" heading="New event" state=${editor.state('event:new')} onCancel=${() => close('event:new')}
        initial=${eventForm({date: today()})} fields=${EVENT_FIELDS} save="Add event"
        onSave=${save('event:new', false, event => editor.addEvent('event:new', event))} />` : null}
    ${current ? html`<${EditForm} key=${form} label=${`Edit ${current.title}`} heading=${current.title} state=${editor.state(form)} onCancel=${() => close(form)}
        initial=${eventForm(current)} fields=${[...EVENT_FIELDS.slice(0, 3), {name: 'resolved', label: 'Resolved on', hint: 'Optional, for a resolved event', inputMode: 'numeric'}, ...EVENT_FIELDS.slice(3)]}
        onSave=${save(form, true, fields => editor.editEvent(form, current.id, fields))}
        extra=${confirm ? html`<span class="thing-confirm" role="group" aria-label="Delete this event?"><span>Delete this event?</span>
            <${Button} variant="danger" onClick=${() => editor.deleteEvent(form, current.id).then(ok => { if (ok) close(form); })}>Delete<//>
            <${Button} variant="quiet" onClick=${() => setConfirm(false)}>Keep<//></span>`
          : html`<${Button} variant="danger" class="thing-delete" onClick=${() => setConfirm(true)}>Delete…<//>`} />` : null}
  </div>`;
}

const BREAKER_FIELDS = [{name: 'label', label: 'Label', hint: 'As written on the panel'}, {name: 'feeds', label: 'Feeds', hint: 'What turns off with it'},
  {name: 'amps', label: 'Amps', inputMode: 'numeric'}, {name: 'evidence', label: 'Evidence', hint: 'How it was verified', as: 'textarea'}];
/** A panel's breakers in slot order; a click on one edits it. */
export function Breakers({thing, editor, view}) {
  const list = breakers(thing), write = canWrite();
  const [slot, setSlot] = useState(null);
  if (!list.length) return null;
  const b = list.find(x => x.slot === slot), key = `breaker-edit:${slot}`;
  return html`<div class="thing-breakers"><${DetailList} title="Breakers" sorted=${true} size=${40} view=${view} listKey="thing-breakers" resetKey=${thing.id}
    onOpen=${write ? row => { editor.clear(`breaker-edit:${row.id}`); setSlot(row.id); } : null}
    items=${list.map(x => ({id: x.slot, glyph: 'bolt', title: [x.slot, x.label].filter(Boolean).join(' · '),
      sub: [breakerLine(x), x.feeds ? `Feeds ${x.feeds}` : null].filter(Boolean).join(' · ') || null,
      badge: x.feeds ? null : {text: 'Not verified', tone: 'warn'}}))} />
    ${b ? html`<${EditForm} key=${key} label=${`Edit breaker ${b.slot}`} heading=${`Breaker ${b.slot}`} state=${editor.state(key)} fields=${BREAKER_FIELDS}
      initial=${{label: b.label ?? '', feeds: b.feeds ?? '', amps: b.amps != null ? String(b.amps) : '', evidence: b.evidence ?? ''}}
      onCancel=${() => { editor.clear(key); setSlot(null); }}
      onSave=${v => {
        const fields = {};
        for (const f of ['label', 'feeds', 'evidence']) { const t = String(v[f] ?? '').trim(); if (t !== (b[f] ?? '')) fields[f] = t || null; }
        const amps = String(v.amps ?? '').trim();
        if (!amps || !/^\d+$/.test(amps)) return {errors: {amps: 'Amps, a whole number'}};
        if (Number(amps) !== b.amps) fields.amps = Number(amps);
        if (!Object.keys(fields).length) { setSlot(null); return null; }
        editor.breaker(key, b.slot, fields).then(ok => { if (ok) setSlot(null); });
        return null;
      }} />` : null}</div>`;
}

// A state as people read it: `21.5 °C`, `On`; unknown and unavailable said as such.
const stateText = s => s?.state == null ? 'Unknown' : `${factValue(s.state, 'state')}${s.attributes?.unit_of_measurement ? ` ${s.attributes.unit_of_measurement}` : ''}`;
const entityName = (id, s) => s?.attributes?.friendly_name ?? fieldLabel(String(id).replace(/^[a-z_]+\./, ''));
/** The record's Home Assistant entities (`ha`) as Habitat reads them now; hidden where Habitat is not set up. */
export function LiveState({entities, host}) {
  const [read, setRead] = useState({states: null}), [n, retry] = useState(0);
  const ids = entities.join(',');
  useEffect(() => {
    const request = new AbortController(), absent = e => e?.code === 'not-set-up' || e?.code === 'unsupported';
    setRead({states: null});
    Promise.all(entities.map(id => host.call('habitat.state', {query: {id}}, {signal: request.signal}).then(s => [id, s], failed => [id, {failed}])))
      .then(states => {
        if (request.signal.aborted) return;
        const failures = states.map(([, s]) => s?.failed).filter(Boolean);
        setRead(failures.some(absent) ? {hidden: true} : failures.length === states.length ? {error: describeFailure('habitat', failures[0])} : {states});
      });
    return () => request.abort();
  }, [ids, host, n]);
  if (read.hidden) return null;
  return html`<${Section} title="Live state" level=${3} meta="Habitat">
    ${read.error ? html`<${Failure} backend="habitat" error=${read.error} host=${host} retry=${() => retry(i => i + 1)} />`
      : !read.states ? html`<p class="dk-note" role="status">Reading Habitat…</p>`
      : html`<${Facts} facts=${read.states.map(([id, s]) => ({label: entityName(id, s), value: s?.failed ? 'Unavailable' : stateText(s)}))} />`}
  <//>`;
}

/** The record's photos: bridge's indexed copies of its Immich photos, each opening in the viewer. */
export function RecordPhotos({thing, host, onOpen}) {
  const {shown, missing} = recordPhotos(thing);
  if (!shown.length && !missing) return null;
  return html`<${Section} title="Photos" level=${3} meta=${countText(shown.length + missing)}>
    ${shown.length ? html`<div class="thing-photos">${shown.map(p => html`<${Photo} key=${p.id} photo=${p} host=${host} onOpen=${onOpen} />`)}</div>` : null}
    ${missing ? html`<p class="dk-note">${plural(missing, 'photo')} not in Find yet</p>` : null}
  <//>`;
}
function Photo({photo, host, onOpen}) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let active = true;
    const path = resourcePath(`/v1/doc/${photo.id}/page/1?w=320`);
    if (path) Promise.resolve(host.resource(path)).then(url => { if (active) setSrc(url); }, () => {});
    return () => { active = false; };
  }, [photo.id, host]);
  const title = photo.title ?? 'Photo';
  return html`<button type="button" class="dk-btn thing-photo" aria-label=${`Open ${title}`} onClick=${() => onOpen?.(photo)}>
    ${src ? html`<img src=${src} alt=${title} loading="lazy" decoding="async" />` : html`<span>${title}</span>`}</button>`;
}

/** Who changed what and when, newest first (bridge's history); none or unreadable here: no section. */
export function History({editor, view, thingId, host}) {
  if (editor.historyError) return html`<${Section} title="History" level=${3}><${Failure} backend="bridge" error=${editor.historyError} host=${host} retry=${() => editor.loadHistory()} /><//>`;
  const history = editor.history ?? [];
  return html`<${DetailList} title="History" sorted=${true} view=${view} listKey="thing-history" resetKey=${thingId}
    items=${history.map(h => ({id: h.id, glyph: 'recent', title: historyLine(h), sub: [historyWho(h.who), h.at ? dateTimeText(h.at, {now: new Date()}) : null].filter(Boolean).join(' · '),
      summary: h.note ?? null}))} />`;
}

/** The toast after a write: Saved, for a moment. */
function Saved({count}) {
  const [outcome, say] = useOutcome(2500);
  useEffect(() => { if (count) say('Saved'); }, [count]);
  return html`<${Toast} outcome=${outcome} />`;
}

/** The record past the thing's heading: its facts, open items, live state, breakers, events, warranty, installer, notes, photos and
 *  history. `children` (the thing's own sections: purchase, documents, alerts) sit before the history. */
export function HouseRecord({thing: read, host, onOpen, view, children = null}) {
  const [editor] = useState(() => createRecordEditor(host, read));
  const [, redraw] = useState(0);
  useEffect(() => editor.subscribe(() => redraw(n => n + 1)), [editor]);
  useEffect(() => { editor.loadHistory(); return () => editor.stop(); }, [editor]);
  const thing = editor.thing(), record = thing.house.record, write = canWrite();
  const ha = [].concat(record.ha ?? []).filter(id => typeof id === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(id));
  const warranty = warrantyFacts(thing), installer = installerFacts(thing);

  return html`
    <${EditableFacts} facts=${recordFacts(thing)} editor=${editor} host=${host} write=${write} prefix="record" />
    <${OpenItems} thing=${thing} editor=${editor} onOpen=${onOpen} />
    ${ha.length ? html`<${LiveState} entities=${ha} host=${host} />` : null}
    <${Breakers} thing=${thing} editor=${editor} view=${view} />
    <${Events} thing=${thing} editor=${editor} view=${view} />
    ${warranty.length ? html`<${Section} title="Warranty" level=${3}><${EditableFacts} facts=${warranty} editor=${editor} host=${host} write=${write && !!record.warranty} prefix="warranty" /><//>` : null}
    ${installer.length ? html`<${Section} title="Installer" level=${3}><${EditableFacts} facts=${installer} editor=${editor} host=${host} write=${write} prefix="installer" /><//>` : null}
    ${record.notes ? html`<${Section} title="Notes" level=${3}><${EditableText} path="notes" label="Notes" text=${record.notes} editor=${editor} write=${write} /><//>` : null}
    <${RecordPhotos} thing=${thing} host=${host} onOpen=${onOpen} />
    ${children}
    <${History} editor=${editor} view=${view} thingId=${thing.id} host=${host} />
    <${Saved} count=${editor.saved} />`;
}
