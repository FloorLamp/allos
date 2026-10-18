import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {duplicatePairs, pairsForPerson, decidePair, subscribeDuplicateDecisions} from '../people-duplicates.js';
const html = htm.bind(h);

/** One evidence-backed candidate at a time. Reading never changes identity. */
export function PeopleDuplicates({host, personId, onResolved}) {
  const [open, setOpen] = useState(false), [revision, refresh] = useState(0);
  const [state, setState] = useState({}), [index, setIndex] = useState(0), [busy, setBusy] = useState(false);
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
  return html`<section class="person-profile-section" aria-label="Possible duplicates">
    <button type="button" class="dk-btn text" aria-expanded=${open} onClick=${() => setOpen(value => !value)}>Review possible duplicates</button>
    ${open ? html`<div aria-busy=${busy}>
      ${state.pairs ? html`<button class="dk-btn text" disabled=${busy} onClick=${() => refresh(n => n + 1)}>Refresh candidates</button>` : null}
      ${state.error ? html`<p role="alert">Possible duplicates unavailable: ${state.error.message}<button class="dk-btn" onClick=${() => refresh(n => n + 1)}>Retry review</button></p>` : null}
      ${pair ? html`<article><p>${pair.people.map(person => [person.name, person.relation, ...(person.sources ?? []), person.birth, ...(person.identifiers ?? [])].filter(Boolean).join(' · ')).join(' / ')}</p>
        <p>Possible duplicate · ${at + 1} of ${pairs.length}. Shared names or household contacts do not establish identity.</p>
        ${host.kind === 'web' ? html`<button class="dk-btn" disabled=${busy} onClick=${() => decide('merge')}>Merge</button><button class="dk-btn" disabled=${busy} onClick=${() => decide('separate')}>Keep separate</button>` : html`<p>Review Merge or Keep separate in the owner web session.</p>`}
        ${pairs.length > 1 ? html`<button class="dk-btn" disabled=${busy} onClick=${() => setIndex((at + 1) % pairs.length)}>Next candidate</button>` : null}
      </article>` : !state.error ? html`<p role="status">${state.pairs ? 'No possible duplicates to review.' : 'Loading possible duplicates…'}</p>` : null}
    </div>` : null}
  </section>`;
}
