import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {dateText} from '../format.js';
import {SectionHead} from './drawer.js';
import {StateBlock} from './page-state.js';
import {mergeHow, ownerSession, unmerge} from '../people-duplicates.js';
const html = htm.bind(h);

/** A profile's undoable merges (people.js `merges`): who joined this person and how (by rule, its label; by the owner), and for the
 *  owner's web session Undo merge (bridge.peopleUnmerge), the page read again after it as after a merge. Nothing when none. */
export function PersonMerges({host, merges = []}) {
  const [owner, setOwner] = useState(false), [busy, setBusy] = useState(null), [failed, setFailed] = useState(null);
  useEffect(() => {
    let active = true;
    if (merges.length) ownerSession(host).then(yes => { if (active) setOwner(yes); });
    return () => { active = false; };
  }, [host, merges.length]);
  if (!merges.length) return null;
  const undo = async merge => {
    setBusy(merge.id); setFailed(null);
    try {
      await unmerge(host, merge.id);
      globalThis.location.reload();
    } catch (error) { setFailed({error, merge}); setBusy(null); }
  };
  return html`<section class="dk-section person-merges" aria-label="Merged into this person"><${SectionHead} level=${3} title="Merged into this person" />
    <ul>${merges.map(merge => html`<li key=${merge.id}>
      <div><b>${merge.name}</b><span>${mergeHow(merge, {owner})}${merge.at ? ` · ${dateText(merge.at, {now: Date.now()})}` : ''}</span></div>
      ${owner ? html`<button type="button" class="dk-btn" disabled=${busy != null} aria-label=${`Undo merge of ${merge.name}`} onClick=${() => undo(merge)}>${busy === merge.id ? 'Undoing…' : 'Undo merge'}</button>` : null}
    </li>`)}</ul>
    ${failed ? html`<${StateBlock} inline=${true} warn=${true} line=${failed.error.status === 404 ? `${failed.merge.name} is no longer a recorded merge.`
      : failed.error.status === 409 ? 'This person changed since; reload to see it.' : `Couldn’t undo the merge of ${failed.merge.name}. Try again.`} />` : null}
  </section>`;
}
