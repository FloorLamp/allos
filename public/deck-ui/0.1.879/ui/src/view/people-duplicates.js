import {h} from '../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {dateText, fieldLabel, joinText, plural} from '../format.js';
import {Facts, SectionHead} from './drawer.js';
import {Failure, Skeleton, StateBlock} from './page-state.js';
import {Avatar} from './avatar.js';
import {Toast, useFading} from './toast.js';
import {decidePair, duplicateFacts, duplicatePairs, evidenceWords, ownerSession, pairKey, pairsForPerson, portraitOf,
  subscribeDuplicateDecisions} from '../people-duplicates.js';
const html = htm.bind(h);
const NONE = [];

/** The owner's pairs to review (all, or one person's by exact id) and which this page has decided: nothing for anyone else (members,
 *  the agent member, devices), so they never see the entry or ask for pairs, nor while not `enabled`. `open`: the pairs still undecided. */
export function useDuplicates(host, personId, {enabled = true} = {}) {
  const [state, setState] = useState({}), [revision, setRevision] = useState(0), [decided, setDecided] = useState(() => new Map());
  useEffect(() => subscribeDuplicateDecisions(host, ({pair, choice}) => setDecided(previous => {
    const next = new Map(previous);
    if (choice === 'undo') next.delete(pairKey(pair)); else next.set(pairKey(pair), choice);
    return next;
  })), [host]);
  useEffect(() => {
    let active = true;
    if (!enabled) { setState({}); return undefined; }
    ownerSession(host).then(owner => {
      if (!active) return undefined;
      if (!owner) return setState({owner: false});
      setState(previous => ({...previous, owner: true, error: null}));
      return duplicatePairs(host, {refresh: revision > 0}).then(pairs => {
        if (active) { setDecided(new Map()); setState({owner: true, pairs: pairsForPerson(pairs, personId)}); }
      }, error => {
        // bridge refuses a session that is not the owner's: no review, rather than a failure
        if (active) setState([401, 403].includes(error.status) ? {owner: false} : {owner: true, error});
      });
    });
    return () => { active = false; };
  }, [host, personId, enabled, revision]);
  const pairs = state.pairs ?? NONE;
  return {...state, pairs, decided, loading: !!state.owner && !state.pairs && !state.error,
    open: pairs.filter(pair => !decided.has(pairKey(pair))).length, reload: () => setRevision(n => n + 1)};
}

/** The entry to the review: `Possible duplicates (n)`, n the pairs still to decide; only for the owner, and only while there are
 *  some (or the review is open, so it can close). */
export function DuplicatesEntry({review, open, onToggle}) {
  if (!review.owner || !open && !review.error && !review.open) return null;
  return html`<button type="button" class="dk-btn" aria-expanded=${open} data-variant=${open ? 'primary' : null}
    onClick=${() => onToggle(!open)}>${review.error ? 'Possible duplicates' : `Possible duplicates (${review.open})`}</button>`;
}

const KEYS = {m: 'merge', k: 'separate', s: 'skip', z: 'undo'};
const DONE = {merge: 'Merged', separate: 'Kept apart', skip: 'Skipped'};
const typing = target => !!target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

/** One candidate pair at a time, the two people side by side: Merge (M), Keep separate (K) or Skip (S) moves to the next; Undo (Z)
 *  takes back this page's last (a skip just goes back to it). The keys work while the review is open and not typing in a field, and
 *  not under another dialog. A 409 (the pair changed) reloads the pairs. `onChanged(choice)` after a merge or its undo. */
export function PeopleDuplicates({host, review, open, onClose, onChanged}) {
  const ref = useRef(null), [at, setAt] = useState(0), [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]), [status, setStatus] = useState(null), shown = useFading(status?.error ? null : status);
  const pairs = review.pairs, done = pair => review.decided.has(pairKey(pair));
  const pair = pairs[at], first = pairs.findIndex(p => !done(p));
  // a fresh list (the first read, a reload) starts at its first undecided pair
  useEffect(() => { setAt(Math.max(0, pairs.findIndex(p => !done(p)))); }, [pairs]);
  useLayoutEffect(() => { if (open) ref.current?.focus({preventScroll: false}); }, [open]);
  const next = (from, also) => {
    for (let i = from + 1; i < pairs.length; i++) if (!done(pairs[i]) && pairKey(pairs[i]) !== also) return i;
    return pairs.length;
  };
  const keepFocus = () => { if (!ref.current?.contains(document.activeElement)) ref.current?.focus({preventScroll: true}); };
  const failed = (error, what) => {
    setStatus({error, what});
    // Conflicts require new evidence; never retry a stale identity decision silently.
    if (error.status === 409) review.reload();
  };
  async function act(choice) {
    if (busy) return;
    if (choice === 'undo') return undo();
    if (!pair || done(pair)) return;
    const names = pair.people.map(p => p.name).join(' and ');
    if (choice === 'skip') {
      setHistory(h => [...h, {pair, choice, at}]);
      setStatus({text: `Skipped ${names}`});
      setAt(next(at, pairKey(pair)));
      return;
    }
    setBusy(true);
    try {
      await decidePair(host, pair, choice);
      setHistory(h => [...h, {pair, choice, at}]);
      setStatus({text: `${DONE[choice]}: ${names}`});
      setAt(next(at, pairKey(pair)));
      if (choice === 'merge') onChanged?.(choice);
    } catch (error) { failed(error, choice === 'merge' ? 'merge' : 'keep separate'); }
    finally { setBusy(false); keepFocus(); }
  }
  async function undo() {
    const last = history.at(-1);
    if (!last) return;
    const back = pairs.findIndex(p => pairKey(p) === pairKey(last.pair));
    if (last.choice === 'skip') {
      setHistory(h => h.slice(0, -1));
      setStatus({text: `Back to ${last.pair.people.map(p => p.name).join(' and ')}`});
      setAt(back >= 0 ? back : last.at);
      return;
    }
    setBusy(true);
    try {
      await decidePair(host, last.pair, 'undo');
      setHistory(h => h.slice(0, -1));
      setStatus({text: `Undone: ${DONE[last.choice].toLowerCase()} ${last.pair.people.map(p => p.name).join(' and ')}`});
      // the pair is back for review where it was; after a reload it may not be listed yet
      if (back >= 0) setAt(back); else review.reload();
      if (last.choice === 'merge') onChanged?.('undo');
    } catch (error) { failed(error, 'undo'); }
    finally { setBusy(false); keepFocus(); }
  }
  const latest = useRef(act);
  latest.current = act;
  useEffect(() => {
    if (!open) return undefined;
    const key = ev => {
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat || typing(ev.target)) return;
      const choice = KEYS[ev.key?.toLowerCase()], el = ref.current;
      if (!choice || !el) return;
      // the review's keys: focus in it (or on nothing), and no dialog over it
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      if (modal && !modal.contains(el)) return;
      if (!el.contains(ev.target) && ev.target !== document.body && ev.target !== document.documentElement) return;
      ev.preventDefault();
      latest.current(choice);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [open]);
  if (!open) return null;
  const left = pairs.filter(p => !done(p)).length, finished = !pair || done(pair);
  const button = (choice, label, keyName, variant = null) => html`<button type="button" class="dk-btn" data-variant=${variant} aria-keyshortcuts=${keyName}
    disabled=${busy || (choice === 'undo' ? !history.length : finished)} onClick=${() => act(choice)}>${label}<kbd class="dk-key" aria-hidden="true">${keyName}</kbd></button>`;
  const why = pair ? evidenceWords(pair.evidence, {label: fieldLabel}) : [];
  return html`<section class="dk-duplicates" aria-label="Possible duplicates" tabindex="-1" ref=${ref} aria-busy=${busy}>
    <${SectionHead} title="Possible duplicates" meta=${pairs.length && !finished ? `${at + 1} of ${pairs.length}` : null}
      actions=${onClose ? html`<button type="button" class="dk-btn" onClick=${onClose}>Close</button>` : null} />
    ${review.error ? html`<${Failure} named=${true} backend="bridge" error=${review.error} retry=${review.reload} host=${host} />`
      : review.loading ? html`<${Skeleton} inline=${true} />`
      : finished ? html`<${StateBlock} inline=${true} line=${left ? `${plural(left, 'pair')} skipped.` : 'No possible duplicates left to review.'}
          action=${left ? 'Review skipped' : null} onAction=${() => setAt(first)} />`
      : html`<article class="dk-duplicate-pair" key=${pairKey(pair)} aria-label=${pair.people.map(p => p.name).join(' and ')}>
        ${why.length ? html`<p class="dk-duplicate-why">${joinText(why)}</p>` : null}
        <div class="dk-duplicate-compare">${pair.people.map(person => html`<div key=${person.id} class="dk-duplicate-person">
          <div class="dk-duplicate-who"><${Avatar} host=${host} path=${portraitOf(person)} name=${person.name} alt=${`Photo of ${person.name}`} />
            <div><h3>${person.name}</h3><p>${person.relation ? fieldLabel(person.relation) : 'Relation not recorded'}</p></div></div>
          <${Facts} facts=${duplicateFacts(person, {date: dateText, plural})} /></div>`)}</div>
      </article>`}
    ${review.error || review.loading ? null : html`<div class="dk-duplicate-actions" role="group" aria-label="Decide">
      ${button('merge', 'Merge', 'M', 'primary')}${button('separate', 'Keep separate', 'K')}${button('skip', 'Skip', 'S')}
      <span class="dk-duplicate-undo">${button('undo', 'Undo', 'Z')}</span></div>`}
    ${status?.error ? html`<${StateBlock} inline=${true} warn=${true} line=${status.error.status === 409 ? 'These people changed since; the pairs were read again.'
        : `Couldn’t ${status.what}. Try again.`} />`
      : null}
    <${Toast} outcome=${shown} />
  </section>`;
}
