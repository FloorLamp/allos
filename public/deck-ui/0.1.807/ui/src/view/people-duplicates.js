import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {dateText, fieldLabel} from '../format.js';
import {Facts, SectionHead} from './drawer.js';
import {Failure, Skeleton, StateBlock} from './page-state.js';
import {duplicatePairs, duplicateFacts, pairsForPerson, decidePair, subscribeDuplicateDecisions} from '../people-duplicates.js';
const html = htm.bind(h);

/** The toggle for the review: a page's header action, a profile's or a filter bar's; the review shows where the caller puts it. */
export const DuplicatesToggle = ({open, onToggle}) => html`<button type="button" class="dk-btn" aria-expanded=${open} data-variant=${open ? 'primary' : null}
  onClick=${() => onToggle(!open)}>${open ? 'Close duplicates review' : 'Review possible duplicates'}</button>`;

/** One evidence-backed candidate at a time, the two people side by side. Reading never changes identity; Merge (one person from two,
 *  not undone here) asks first. With `open` the caller holds the toggle (DuplicatesToggle) and the review shows only while open;
 *  without it the review brings its own. */
export function PeopleDuplicates({host, personId, onResolved, open: held}) {
  const [own, setOpen] = useState(false), [revision, refresh] = useState(0);
  const open = held ?? own;
  const [state, setState] = useState({}), [index, setIndex] = useState(0), [busy, setBusy] = useState(false), [confirming, confirm] = useState(false);
  useEffect(() => subscribeDuplicateDecisions(host, resolved => setState(previous => previous.pairs
    ? {...previous, pairs: previous.pairs.filter(pair => pair.a !== resolved.a || pair.b !== resolved.b)} : previous)), [host]);
  useEffect(() => {
    let active = true;
    if (open) {
      setState({});
      duplicatePairs(host, {refresh: revision > 0}).then(pairs => {
        if (active) setState({pairs: pairsForPerson(pairs, personId)});
      }, error => { if (active) setState({error}); });
    }
    return () => { active = false; };
  }, [host, open, personId, revision]);
  const pairs = state.pairs ?? [], at = Math.min(index, Math.max(0, pairs.length - 1)), pair = pairs[at];
  useEffect(() => confirm(false), [pair]);
  const decide = async choice => {
    setBusy(true);
    try {
      await decidePair(host, pair, choice);
      setState({pairs: pairs.filter(p => p !== pair)});
      onResolved?.(choice);
      if (choice === 'merge') globalThis.location.reload();
    } catch (error) {
      setState(previous => ({...previous, error}));
      // Conflicts require new evidence; never retry a stale identity decision silently.
      if (error.status === 409) refresh(n => n + 1);
    } finally { setBusy(false); }
  };
  if (held != null && !open) return null;
  const names = pair?.people.map(p => p.name).join(' and ');
  return html`<section class="dk-duplicates" aria-label="Possible duplicates">
    ${held == null ? html`<${DuplicatesToggle} open=${open} onToggle=${setOpen} />` : null}
    ${open ? html`<div aria-busy=${busy}>
      <${SectionHead} title="Possible duplicates" meta=${pairs.length ? `${at + 1} of ${pairs.length}` : null}
        actions=${state.pairs && !state.error ? html`<button type="button" class="dk-btn" disabled=${busy} onClick=${() => refresh(n => n + 1)}>Refresh</button>` : null} />
      ${state.error ? html`<${Failure} named=${true} backend="bridge" error=${state.error} retry=${() => refresh(n => n + 1)} host=${host} />` : null}
      ${pair ? html`<article class="dk-duplicate-pair">
        <div class="dk-duplicate-compare">${pair.people.map(person => html`<div key=${person.id} class="dk-duplicate-person">
          <h4>${person.name}</h4><${Facts} facts=${duplicateFacts(person, {label: fieldLabel, date: dateText})} /></div>`)}</div>
        <p class="dk-note">Shared names or household contacts alone do not make them one person.</p>
        ${host.kind !== 'web' ? html`<p class="dk-note">Review Merge or Keep separate in the owner web session.</p>`
          : confirming ? html`<div class="dk-duplicate-actions" role="group" aria-label="Confirm merge">
            <p><b>Merge ${names} into one person?</b> Their documents and conversations join; this can’t be undone here.</p>
            <button type="button" class="dk-btn" data-variant="danger" disabled=${busy} onClick=${() => decide('merge')}>Merge</button>
            <button type="button" class="dk-btn" disabled=${busy} onClick=${() => confirm(false)}>Cancel</button></div>`
          : html`<div class="dk-duplicate-actions">
            <button type="button" class="dk-btn" disabled=${busy} onClick=${() => decide('separate')}>Keep separate</button>
            ${pairs.length > 1 ? html`<button type="button" class="dk-btn" disabled=${busy} onClick=${() => setIndex((at + 1) % pairs.length)}>Next candidate</button>` : null}
            <button type="button" class="dk-btn" data-variant="danger" disabled=${busy} onClick=${() => confirm(true)}>Merge…</button></div>`}
      </article>` : !state.error ? state.pairs ? html`<${StateBlock} inline=${true} line="No possible duplicates to review." />` : html`<${Skeleton} inline=${true} />` : null}
    </div>` : null}
  </section>`;
}
