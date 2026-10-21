// What a physical thing is linked to, and the one way to link anything to a thing (contract/things.md *Links*): `ThingLinks` (a
// thing's Linked and Suggested, its Link… picker, Unlink and Not it), `LinkPicker` (bridge's search over one kind at a time, the one
// picker every place shares), `MoveConfirm` (an exclusive target another thing has: asked first) and `LinkToThing` (a purchase's or a
// House device's side: pick a thing in a drawer, then link), `NewThing` (a thing from scratch: the Things page's and a House tile's) and
// `Aliases` (a thing's other names). A member who may not write sees the links without any action.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {LINK_KINDS, byText, canLink, createThing, createThingLinks, exclusive, groupLinks, isConflict, kindOf, linkKey, linkTarget, parseAliases, saveAliases, searchTargets} from '../thing-links.js';
import {describeFailure} from '../failure.js';
import {joinText} from '../format.js';
import {Field} from './controls.js';
import {ChipGroup} from './chip-group.js';
import {Toast, useOutcome} from './toast.js';
import {Drawer, SectionHead} from './drawer.js';
import {EntityLink, entityHref} from './entity-link.js';
import {Failure, StateBlock, Skeleton} from './page-state.js';
import {RowList} from './rows.js';
const html = htm.bind(h);

const PICK_KINDS = LINK_KINDS.filter(k => k.pick).map(k => k.kind);
const HINTS = {purchase: 'Name, store or order number', device: 'Name, model or room', entity: 'Name or entity id', record: 'Name or room',
  document: 'Title or words in it', thing: 'Name, model or room'};

/** A link's or a result's title: its record or document as the shared EntityLink where bridge gives one (`ref`), else plain text.
 *  `open(document)`: a document in the host's viewer; another record is the site's own link to its page (a desktop's panel has no
 *  pages: its title stays text). */
export function TargetTitle({item, host, open = null}) {
  const ref = item.ref, document = ref?.kind === 'document';
  if (!ref || !entityHref(ref) || !document && host?.kind !== 'web') return item.title;
  return html`<${EntityLink} kind=${ref.kind} id=${String(ref.id)} label=${item.title} pages=${host?.kind === 'web'}
    onOpen=${document && open ? r => open({id: Number(r.id)}) : null} />`;
}

/** Asks before an exclusive target leaves the thing that has it: `title` what moves, `from` ({name} or null: bridge did not say),
 *  `to` the thing it goes to. */
export function MoveConfirm({title, from, to, busy = false, onMove, onCancel}) {
  const yes = useRef(null);
  useLayoutEffect(() => { yes.current?.focus({preventScroll: true}); }, []);
  return html`<div class="dk-link-confirm" role="alertdialog" aria-label="Move the link" onKeyDown=${ev => { if (ev.key === 'Escape') { ev.stopPropagation(); onCancel(); } }}>
    <p><b>${title}</b> is linked to ${from?.name ? html`<b>${from.name}</b>` : 'another thing'}. Move it to ${to ? html`<b>${to}</b>` : 'this thing'}?</p>
    <div class="dk-link-confirm-acts"><button type="button" class="dk-btn main" ref=${yes} disabled=${busy} onClick=${onMove}>Move here</button>
      <button type="button" class="dk-btn" disabled=${busy} onClick=${onCancel}>Cancel</button></div></div>`;
}

/** The one picker: `kinds` (LINK_KINDS' or `thing`; chips when several), bridge's first results before anything is typed, then its
 *  matches (200 ms after typing stops, the one before cancelled); each result names the thing it belongs to now. `onPick(result)`;
 *  `current`: the thing being linked to (its results say Linked, not pickable); `label` names the picker. */
export function LinkPicker({host, kinds = PICK_KINDS, current = null, onPick, label = 'Link', busy = null, inset = false}) {
  const [kind, setKind] = useState(kinds[0]), [q, setQ] = useState(''), [retry, setRetry] = useState(0);
  const [found, setFound] = useState({loading: true, results: [], error: null});
  const box = useRef(null);
  useLayoutEffect(() => { box.current?.querySelector('input')?.focus({preventScroll: true}); }, []);
  useEffect(() => {
    const ask = new AbortController();
    setFound(f => ({...f, loading: true, error: null}));
    const t = setTimeout(() => searchTargets(host, {kind, q}, {signal: ask.signal}).then(
      results => { if (!ask.signal.aborted) setFound({loading: false, results, error: null}); },
      error => { if (!ask.signal.aborted) setFound({loading: false, results: [], error: describeFailure('bridge', error)}); }), q.trim() ? 200 : 0);
    return () => { clearTimeout(t); ask.abort(); };
  }, [host, kind, q, retry]);
  const here = r => current && (r.kind === 'thing' ? String(r.id) : String(r.thing?.id ?? '')).toLowerCase() === String(current).toLowerCase();
  const items = found.results.map(r => ({id: `${r.kind}:${r.id}`, glyph: kindOf(r.kind).glyph, title: r.title,
    sub: joinText([r.subtitle, r.kind !== 'thing' && r.thing && !here(r) ? `Now: ${r.thing.name}` : null]) || null,
    end: here(r) ? {label: 'Linked', disabled: true, onClick: () => {}} : {label: busy === `${r.kind}:${r.id}` ? 'Linking…' : 'Link', disabled: !!busy, onClick: () => onPick(r)}}));
  const what = kindOf(kind).label.toLowerCase();
  return html`<div class=${`dk-link-picker${inset ? ' inset' : ''}`} role="group" aria-label=${label} ref=${box}>
    ${kinds.length > 1 ? html`<${ChipGroup} label="Kind" value=${kind} onChange=${setKind} options=${kinds.map(k => ({value: k, label: kindOf(k).label}))} />` : null}
    <${Field} type="search" label=${`Search ${what}`} placeholder=${HINTS[kind] ?? 'Name'} value=${q} onInput=${ev => setQ(ev.currentTarget.value)} />
    <${RowList} inline=${true} host=${host} items=${found.loading && !found.results.length ? undefined : items} loading=${found.loading && !found.results.length ? 3 : 0}
      error=${found.error ? {error: found.error, onAction: () => setRetry(n => n + 1)} : null}
      empty=${{glyph: kindOf(kind).glyph, title: q.trim() ? `No ${what} match` : `No ${what} yet`}} />
  </div>`;
}

const Group = ({title, label = title, children}) => html`<section class="dk-link-group" aria-label=${label}><h3 class="dk-label">${title}</h3>${children}</section>`;

/** A thing's links (bridge.things.links): Linked by kind, each its title (EntityLink where bridge gives a record), who made it, Unlink;
 *  Link… (the picker over every kind); Suggested (why, Link, Not it). `onOpen(document)` opens a linked document in the host's viewer;
 *  `name` the thing's, said when a move is asked; `model` a createThingLinks the page already reads (opened and stopped there). */
export function ThingLinks({id, host, onOpen = null, name = null, model: shared = null}) {
  const [model] = useState(() => shared ?? createThingLinks(host));
  const [, redraw] = useState(0), [picking, setPicking] = useState(false), [outcome, say] = useOutcome();
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  // a page that shares the model (the thing's hub: its Papers) reads and stops it itself
  useEffect(() => { if (!shared) model.open(id); }, [model, id]);
  useEffect(() => () => { if (!shared) model.stop(); }, [model]);
  useEffect(() => { if (model.outcome) { say(model.outcome.text, model.outcome.bad); model.outcome = null; } });
  const open = onOpen;
  const write = model.writable;
  const groups = groupLinks(model.links);
  const pick = async target => { if (await model.link(target)) setPicking(false); };
  const busy = [...model.busy][0] ?? null;
  const linkRow = l => ({id: linkKey(l), glyph: kindOf(l.kind).glyph, title: html`<${TargetTitle} item=${l} host=${host} open=${open} />`, tip: l.title,
    sub: l.subtitle || null, actions: html`<span class="dk-link-by">${byText(l)}</span>`,
    ...(write ? {end: {label: model.busy.has(linkKey(l)) ? 'Unlinking…' : 'Unlink', disabled: model.busy.has(linkKey(l)), onClick: () => model.unlink(l)}} : {})});
  const suggestionRow = s => ({id: `s:${linkKey(s)}`, glyph: kindOf(s.kind).glyph, title: html`<${TargetTitle} item=${s} host=${host} open=${open} />`, tip: s.title,
    sub: s.subtitle || null, summary: joinText([s.why && `Why: ${s.why}`, s.linkedTo ? `Now: ${s.linkedTo.name}` : null]) || null,
    ...(write ? {actions: html`<button type="button" class="dk-btn main" disabled=${model.busy.has(linkKey(s))} onClick=${() => model.link(s)}>Link</button>
      <button type="button" class="dk-btn" disabled=${model.busy.has(linkKey(s))} onClick=${() => model.unlink(s, {notIt: true})}>Not it</button>`} : {})});
  return html`<section class="dk-section dk-thing-links" aria-label="Linked" aria-busy=${model.loading}>
    <${SectionHead} title="Linked" meta=${model.links.length ? String(model.links.length) : null}
      actions=${write ? html`<button type="button" class="dk-btn" aria-expanded=${String(picking)} onClick=${() => setPicking(!picking)}>${picking ? 'Done' : 'Link…'}</button>` : null} />
    ${model.confirm ? html`<${MoveConfirm} title=${model.confirm.target.title} from=${model.confirm.linkedTo} to=${name} busy=${!!busy}
      onMove=${async () => { if (await model.move()) setPicking(false); }} onCancel=${() => model.cancel()} />` : null}
    ${picking && write ? html`<${LinkPicker} host=${host} current=${id} busy=${busy} onPick=${pick} label="Link to this thing" inset=${true} />` : null}
    ${model.loading && !model.links.length ? html`<${Skeleton} inline=${true} />`
      : model.error ? html`<${Failure} backend="bridge" error=${model.error} host=${host} inline=${true} retry=${() => model.open(id)} />`
      : !groups.length ? html`<${StateBlock} inline=${true} line=${write ? 'Nothing linked yet. Link… finds its purchase, House device, record or papers.' : 'Nothing linked yet.'} />`
      : groups.map(g => html`<${Group} key=${g.kind} title=${g.label}><${RowList} inline=${true} host=${host} items=${g.links.map(linkRow)} /><//>`)}
    ${model.unavailable.includes('habitat') ? html`<p class="dk-note">House devices are missing: the House did not answer.</p>` : null}
    ${model.suggestions.length ? html`<${Group} title="Suggested"><${RowList} inline=${true} host=${host} items=${model.suggestions.map(suggestionRow)} /><//>` : null}
    <${Toast} outcome=${outcome} />
  </section>`;
}

/** The other side's Link: a drawer with the thing picker (bridge.things.search kind=thing); a pick links `target` ({kind, id, title})
 *  to that thing, asking first when `current` ({id, name}: the thing it is linked to now) is another and the kind exclusive.
 *  `onLinked(thing {id, name})`; `title` the drawer's. */
export function LinkToThing({host, target, current = null, title, onClose, onLinked}) {
  const [confirm, setConfirm] = useState(null), [busy, setBusy] = useState(null), [error, setError] = useState(null);
  const go = async (thing, move) => {
    setBusy(`thing:${thing.id}`); setError(null);
    try {
      await linkTarget(host, thing.id, target, {move});
      setConfirm(null);
      onLinked({id: thing.id, name: thing.title});
    } catch (e) {
      if (isConflict(e) && !move) setConfirm({thing, from: e.linkedTo ?? current});
      else setError(describeFailure('bridge', e).message);
    }
    setBusy(null);
  };
  const pick = thing => {
    if (current && exclusive(target.kind) && String(current.id).toLowerCase() !== String(thing.id).toLowerCase()) setConfirm({thing, from: current});
    else go(thing, false);
  };
  return html`<${Drawer} open=${true} title=${title} sub=${target.title} onClose=${onClose}>
    ${confirm ? html`<${MoveConfirm} title=${target.title} from=${confirm.from} to=${confirm.thing.title} busy=${!!busy}
      onMove=${() => go(confirm.thing, true)} onCancel=${() => setConfirm(null)} />` : null}
    ${error ? html`<p class="dk-field-error" role="alert">${error}</p>` : null}
    <${LinkPicker} host=${host} kinds=${['thing']} current=${current?.id ?? null} busy=${busy} onPick=${pick} label="Things" />
  <//>`;
}

/** A thing from scratch (bridge.things.create): its name (required), make, model, kind, room, notes and other names; `from` ({kind,
 *  id, title}: a House device or entity) is linked to it at once, a device another thing has (`current`, or bridge's 409) asked first. `onCreated(thing {id,
 *  name})`; `name` the name it starts with. */
export function NewThing({host, from = null, current = null, name = '', onCreated, onCancel}) {
  const [f, setF] = useState({name, make: '', model: '', kind: '', room: '', notes: '', aliases: ''});
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [confirm, setConfirm] = useState(null);
  const field = k => ({value: f[k], onInput: ev => setF({...f, [k]: ev.currentTarget.value})});
  const {aliases, error: aliasError} = parseAliases(f.aliases);
  const send = async move => {
    setBusy(true); setError(null);
    try {
      const answer = await createThing(host, {...f, aliases, from, move});
      setConfirm(null);
      onCreated({id: answer.thing.id, name: answer.thing.name});
    } catch (e) {
      if (isConflict(e) && from && !move) setConfirm({from: e.linkedTo ?? null});
      else setError(describeFailure('bridge', e).message);
    }
    setBusy(false);
  };
  // `current`: the thing `from` is linked to now (Habitat's `thing`): asked before anything is sent
  const submit = ev => { ev.preventDefault(); if (!f.name.trim() || aliasError) return; if (from && current && exclusive(from.kind)) setConfirm({from: current}); else send(false); };
  return html`<form class="dk-new-thing" aria-label="New thing" onSubmit=${submit}>
    ${from ? html`<p class="dk-note">Linked at once to ${from.title ?? from.id}.</p>` : null}
    ${confirm ? html`<${MoveConfirm} title=${from.title ?? from.id} from=${confirm.from} to=${f.name.trim()} busy=${busy} onMove=${() => send(true)} onCancel=${() => setConfirm(null)} />` : null}
    <${Field} label="Name" required=${true} autocomplete="off" ...${field('name')} />
    <div class="dk-new-thing-pair"><${Field} label="Make" autocomplete="off" ...${field('make')} /><${Field} label="Model" autocomplete="off" ...${field('model')} /></div>
    <div class="dk-new-thing-pair"><${Field} label="Kind" placeholder="Light, appliance, tool…" autocomplete="off" ...${field('kind')} />
      <${Field} label="Room" autocomplete="off" ...${field('room')} /></div>
    <${Field} label="Other names" hint="Commas between them: what you might search for" error=${aliasError} autocomplete="off" ...${field('aliases')} />
    <${Field} as="textarea" label="Notes" ...${field('notes')} />
    ${error ? html`<p class="dk-field-error" role="alert">${error}</p>` : null}
    <div class="dk-new-thing-acts"><button type="submit" class="dk-btn main" disabled=${busy || !f.name.trim() || !!aliasError}>${busy ? 'Creating…' : 'Create thing'}</button>
      ${onCancel ? html`<button type="button" class="dk-btn" disabled=${busy} onClick=${onCancel}>Cancel</button>` : null}</div>
  </form>`;
}
/** NewThing in the shared drawer. */
export const NewThingDrawer = ({host, from = null, current = null, name = '', onClose, onCreated}) => html`<${Drawer} open=${true} title="New thing" sub=${from?.title ?? null} onClose=${onClose}>
  <${NewThing} host=${host} from=${from} current=${current} name=${name} onCreated=${onCreated} onCancel=${onClose} /><//>`;

/** A thing's other names (bridge's `aliases`, what Find matches): Also called, and for a member who may write, Edit (one field, commas
 *  between the names; bridge's ≤20 of 1–80 characters checked before it is sent). */
export function Aliases({id, host, aliases: initial = []}) {
  const [aliases, setAliases] = useState(initial), [editing, setEditing] = useState(false), [text, setText] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  useEffect(() => { setAliases(initial); }, [id, (initial ?? []).join('\n')]);
  const write = canLink(host), parsed = parseAliases(text);
  const save = async ev => {
    ev.preventDefault();
    if (parsed.error) return;
    setBusy(true); setError(null);
    try { const answer = await saveAliases(host, id, parsed.aliases); setAliases(Array.isArray(answer?.aliases) ? answer.aliases : parsed.aliases); setEditing(false); }
    catch (e) { setError(describeFailure('bridge', e).message); }
    setBusy(false);
  };
  if (editing) return html`<form class="dk-aliases editing" aria-label="Other names" onSubmit=${save}>
    <${Field} label="Also called" hint="Commas between them" value=${text} error=${parsed.error ?? error} autocomplete="off" onInput=${ev => setText(ev.currentTarget.value)} />
    <div class="dk-new-thing-acts"><button type="submit" class="dk-btn main" disabled=${busy || !!parsed.error}>${busy ? 'Saving…' : 'Save'}</button>
      <button type="button" class="dk-btn" disabled=${busy} onClick=${() => { setEditing(false); setError(null); }}>Cancel</button></div></form>`;
  if (!aliases.length && !write) return null;
  return html`<p class="dk-aliases">${aliases.length ? html`<span>Also called: ${aliases.join(', ')}</span>` : html`<span>No other names</span>`}
    ${write ? html`<button type="button" class="dk-btn text" aria-label=${aliases.length ? 'Edit other names' : 'Add other names'}
      onClick=${() => { setText(aliases.join(', ')); setEditing(true); }}>${aliases.length ? 'Edit' : 'Add other names'}</button>` : null}</p>`;
}
