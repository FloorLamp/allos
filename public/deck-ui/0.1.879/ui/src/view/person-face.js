// A person's face (contract/people.md *Faces*): the profile's Face section (the linked face and how, Change face and Unlink; with none,
// Link a face and bridge's suggestions, Link or Not it) and the face picker, inline where it was asked for (a search over Immich's
// faces, unnamed ones too, a page of 40 at a time, each with its Immich page to name it there; Close or Esc folds it). Linking a face someone else has asks to move it first (bridge's 409).
// Only where this page may link (people-faces.js `canLinkFaces`); a device sees how the face came, read-only.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {plural} from '../format.js';
import {openable} from '../host/host.js';
import {canLinkFaces, faceHow, faceOf, faceSuggestions, linkFace, notTheirFace, readFaces, subscribeFaces, unlinkFace, withFace} from '../people-faces.js';
import {personPhoto} from '../people.js';
import {Avatar} from './avatar.js';
import {CollectionSearch} from './collection-page.js';
import {SectionHead} from './drawer.js';
import {Glyph} from '../glyphs.js';
import {Failure, Skeleton, StateBlock} from './page-state.js';
const html = htm.bind(h);

/** The person's portrait and face as this page last changed them, redrawn on their link or unlink: `{photo, face}`. */
export function usePersonFace(person) {
  const id = person?.id == null ? null : String(person.id), [, redraw] = useState(0);
  useEffect(() => id == null ? undefined : subscribeFaces(change => { if (change.id === id) redraw(n => n + 1); }), [id]);
  const current = withFace(person ?? {});
  return {photo: personPhoto(current), face: faceOf(current)};
}

/** A face's thumbnail: Immich's, through the host (the shared Avatar: the name's initials until it loads, and if it never does). */
const FaceThumb = ({host, face, class: cls = 'dk-face-thumb'}) => html`<${Avatar} host=${host} path=${face.thumbnail} sized=${false}
  name=${face.name ?? '?'} class=${cls} />`;

const faceName = face => face.name ?? 'Unnamed';
const photos = face => face.photos == null ? null : plural(face.photos, 'photo');

/** Linking a face to `person`: `link(face)` links it; a face someone else has (409) waits in `confirm` ({face, holder}) for `move()`
 *  or `cancel()`; `busy` the face being linked; `error` a failed link (the shared failure). `onLinked(change)` after a link. */
function useLinking(host, person, onLinked) {
  const [busy, setBusy] = useState(null), [confirm, setConfirm] = useState(null), [error, setError] = useState(null);
  const run = async (face, move) => {
    setBusy(face.id); setError(null);
    try {
      const change = await linkFace(host, person.id, face.id, {move});
      setConfirm(null); setBusy(null);
      onLinked?.(change);
    } catch (e) {
      setBusy(null);
      if (e?.status === 409 && !move) setConfirm({face, holder: e.holder ?? face.person ?? null});
      else { setConfirm(null); setError(e); }
    }
  };
  return {busy, confirm, error, link: face => run(face, false), move: () => confirm && run(confirm.face, true), cancel: () => setConfirm(null)};
}

/** The 409's question: this face is someone else's; Move it here (again with `move`) or Cancel. */
function MoveFace({linking, name}) {
  const ref = useRef(null), c = linking.confirm;
  useEffect(() => { if (c) ref.current?.focus(); }, [c]);
  if (!c) return null;
  const holder = c.holder?.name ?? 'someone else';
  return html`<div class="dk-face-move" role="alert">
    <p><b>${faceName(c.face)}</b> is linked to ${holder}. Move it to ${name}? ${holder} then has no portrait from it.</p>
    <div class="dk-face-actions"><button ref=${ref} type="button" class="dk-btn" data-variant="primary" disabled=${linking.busy != null}
      onClick=${linking.move}>${linking.busy ? 'Moving…' : 'Move it here'}</button>
      <button type="button" class="dk-btn" onClick=${linking.cancel}>Cancel</button></div></div>`;
}

/** The face picker, unfolded in place (the profile's Face section, the record card): Immich's faces (named first, then unnamed by
 *  photo count), a search over their names, More for the next 40; a tile links its face to `person`, or opens it in Immich to name it
 *  there. `current` the person's face now (its id). Close or Esc folds it, the focus back where it was. */
export function FacePicker({host, person, current = null, open, onClose, onLinked}) {
  const [query, setQuery] = useState(''), [state, setState] = useState({faces: [], next: null, total: null, loading: true}), [retry, setRetry] = useState(0);
  const linking = useLinking(host, person, change => { onClose?.(); onLinked?.(change); });
  const request = useRef(null), box = useRef(null);
  // opened: the search takes the focus; folded: it goes back to what opened it
  useLayoutEffect(() => {
    if (!open) return undefined;
    const from = document.activeElement;
    box.current?.querySelector('input[type="search"]')?.focus({preventScroll: true});
    box.current?.scrollIntoView?.({block: 'nearest'});
    return () => { if (from?.isConnected) from.focus({preventScroll: true}); };
  }, [open]);
  const read = (cursor = null) => {
    request.current?.abort();
    const ask = request.current = new AbortController();
    setState(previous => ({...(cursor ? previous : {faces: [], next: null, total: null}), loading: true, error: null}));
    readFaces(host, {q: query, cursor}, {signal: ask.signal}).then(page => {
      if (!ask.signal.aborted) setState(previous => ({faces: cursor ? [...previous.faces, ...page.faces] : page.faces, next: page.next, total: page.total, loading: false}));
    }, error => { if (!ask.signal.aborted) setState(previous => ({...previous, loading: false, error})); });
  };
  // a new search waits for the typing to pause; opening reads at once
  useEffect(() => {
    if (!open) return undefined;
    const wait = setTimeout(() => read(), query ? 200 : 0);
    return () => { clearTimeout(wait); request.current?.abort(); };
  }, [open, query, retry]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  const openFace = face => { if (openable(face.immich)) host.call('url.open', {url: face.immich}).catch(() => {}); };
  const name = person.name ?? 'this person';
  const total = state.total ?? state.faces.length;
  if (!open) return null;
  const title = current ? 'Change face' : 'Link a face';
  // Esc folds the picker alone (not the row, the profile or the palette under it)
  const key = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); onClose?.(); } };
  return html`<section ref=${box} class="dk-face-picker" aria-label=${`${title} for ${name}`} onKeyDown=${key} onClick=${ev => ev.stopPropagation()}>
      <div class="dk-face-picker-head"><b>${title}</b>
        <button type="button" class="dk-btn icon" aria-label=${`Close ${title.toLowerCase()}`} onClick=${() => onClose?.()}><${Glyph} name="close" size=${16} /></button></div>
      <p class="dk-note">The face's latest photo becomes ${name}’s portrait. Name an unnamed face in Immich to find it here by name.</p>
      <${CollectionSearch} always=${true} label="Search faces" placeholder="Names in Immich"
        page=${{query, setQuery, total: state.loading || state.error ? 0 : total, pages: 1, count: total}} />
      <${MoveFace} linking=${linking} name=${name} />
      ${linking.error ? html`<${Failure} backend="bridge" error=${linking.error} host=${host} />` : null}
      ${state.error && !state.faces.length ? html`<${Failure} backend="bridge" error=${state.error} host=${host} retry=${() => setRetry(n => n + 1)} />`
        : state.loading && !state.faces.length ? html`<${Skeleton} inline=${true} />`
        : !state.faces.length ? html`<${StateBlock} inline=${true} title=${query ? 'No faces match' : 'No faces yet'}
            line=${query ? 'Only named faces match a search; unnamed ones show with an empty search.' : 'Immich has no faces to link yet.'} />`
        : html`<ul class="dk-face-grid" aria-label="Faces">${state.faces.map(face => {
          const mine = face.id === current, other = face.person && face.person.id !== String(person.id) ? face.person : null;
          const label = [faceName(face), photos(face), mine ? `${name}’s face now` : other ? `Linked to ${other.name}` : null].filter(Boolean).join(' · ');
          return html`<li key=${face.id} class=${`dk-face-tile${mine ? ' mine' : ''}`}>
            <button type="button" class="dk-face-pick" aria-label=${mine ? label : `Link ${label}`} disabled=${mine || linking.busy != null}
              onClick=${() => linking.link(face)}>
              <${FaceThumb} host=${host} face=${face} />
              <b>${faceName(face)}</b>
              ${photos(face) ? html`<span>${photos(face)}</span>` : null}
              ${mine ? html`<span class="dk-face-holder">Their face now</span>` : other ? html`<span class="dk-face-holder">Linked to ${other.name}</span>` : null}
              ${linking.busy === face.id ? html`<span class="dk-face-busy" role="status">Linking…</span>` : null}
            </button>
            ${face.immich ? html`<button type="button" class="dk-btn text" aria-label=${`Open ${faceName(face)} in Immich`} onClick=${() => openFace(face)}>Open in Immich ↗</button>` : null}
          </li>`;
        })}</ul>`}
      ${state.error && state.faces.length ? html`<${Failure} backend="bridge" error=${state.error} host=${host} retry=${() => read(state.next)} />` : null}
      ${state.next && !state.error ? html`<div class="dk-face-more"><button type="button" class="dk-btn" disabled=${state.loading} onClick=${() => read(state.next)}>${state.loading ? 'Loading…' : 'More'}</button></div>` : null}
    </section>`;
}

/** bridge's guesses at the person's face while they have none (best first): each a row to Link or say Not it (never asked again). */
function useSuggestions(host, id, enabled) {
  const [state, setState] = useState({suggestions: []});
  useEffect(() => {
    if (!enabled || id == null) { setState({suggestions: []}); return undefined; }
    const ask = new AbortController();
    // bridge without faces yet (or a failed read) shows none: the picker stays the way to link
    faceSuggestions(host, id, {signal: ask.signal}).then(suggestions => { if (!ask.signal.aborted) setState({suggestions}); }, () => {});
    return () => ask.abort();
  }, [host, id, enabled]);
  return [state.suggestions, hide => setState(previous => ({suggestions: previous.suggestions.filter(s => s.face.id !== hide)}))];
}

/** The profile's Face section: the linked face (its thumbnail, name and how it came) with Change face and Unlink; none linked, Link a
 *  face and bridge's suggestions ("Probably this face": Link, Not it). Read-only (a device, the agent member): how it came, if said. */
export function PersonFace({host, person}) {
  const writer = canLinkFaces(host), id = person.id == null ? null : String(person.id), name = person.name ?? 'this person';
  const {photo, face} = usePersonFace(person), linked = !!(face || photo);
  const [picking, setPicking] = useState(false), [busy, setBusy] = useState(null), [error, setError] = useState(null);
  const [suggestions, hide] = useSuggestions(host, id, writer && !linked);
  const linking = useLinking(host, person, () => setError(null));
  if (id == null || !writer && !face?.by) return null;
  const unlink = async () => {
    setBusy('unlink'); setError(null);
    try { await unlinkFace(host, id); } catch (e) { setError(e); }
    setBusy(null);
  };
  const notIt = async suggestion => {
    setBusy(suggestion.face.id); setError(null);
    try { await notTheirFace(host, id, suggestion.face.id); hide(suggestion.face.id); } catch (e) { setError(e); }
    setBusy(null);
  };
  const how = faceHow(face);
  const actions = !writer ? null : linked
    ? html`<button type="button" class="dk-btn" aria-expanded=${picking ? 'true' : 'false'} onClick=${() => setPicking(!picking)}>Change face</button>
      <button type="button" class="dk-btn" disabled=${busy != null || picking} onClick=${unlink}>${busy === 'unlink' ? 'Unlinking…' : 'Unlink'}</button>`
    // the one primary action: Link a face, or with suggestions each one's Link
    : html`<button type="button" class="dk-btn" data-variant=${suggestions.length ? null : 'primary'} aria-expanded=${picking ? 'true' : 'false'}
      onClick=${() => setPicking(!picking)}>Link a face</button>`;
  return html`<section class="dk-section person-face" aria-label="Face"><${SectionHead} level=${3} title="Face" actions=${actions} />
    ${writer ? html`<${FacePicker} host=${host} person=${person} current=${face?.id ?? null} open=${picking} onClose=${() => setPicking(false)} />` : null}
    ${linked ? html`<div class="person-face-linked">
        <div><b>${face?.name ?? (face ? 'Unnamed face' : 'A face in Immich')}</b>${how ? html`<span>${how}</span>` : null}</div></div>`
      : html`<p class="dk-note">No face linked, so no portrait. Link ${name}’s face in Immich to show their latest photo.</p>`}
    ${!linked && suggestions.length ? html`<div class="person-face-suggestions">
      <h4>${suggestions.length > 1 ? 'Probably one of these faces' : 'Probably this face'}</h4>
      <ul>${suggestions.map(s => html`<li key=${s.face.id}>
        <${FaceThumb} host=${host} face=${s.face} />
        <div><b>${faceName(s.face)}</b><span>${[s.why, photos(s.face)].filter(Boolean).join(' · ')}</span></div>
        <div class="dk-face-actions">
          <button type="button" class="dk-btn" data-variant="primary" disabled=${busy != null || linking.busy != null} aria-label=${`Link ${faceName(s.face)}`}
            onClick=${() => linking.link(s.face)}>${linking.busy === s.face.id ? 'Linking…' : 'Link'}</button>
          <button type="button" class="dk-btn" disabled=${busy != null || linking.busy != null} aria-label=${`Not it: ${faceName(s.face)}`}
            onClick=${() => notIt(s)}>${busy === s.face.id ? 'Hiding…' : 'Not it'}</button></div>
      </li>`)}</ul></div>` : null}
    <${MoveFace} linking=${linking} name=${name} />
    ${error || linking.error ? html`<${Failure} backend="bridge" error=${error ?? linking.error} host=${host} />` : null}
  </section>`;
}
