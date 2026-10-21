import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Failure} from '../page-state.js';
import {Later} from '../deferred.js';
// An item or a change an exact id named in Find (palette SPEC.md, *Identifiers*), in the viewer's pane (a desktop's: its panel has no
// pages): Flightplan's drawer content (view/flightplan.js PlanDetail), loaded with the views past the first screen. Space and Enter on
// its controls stay theirs (the frame's Space would close the pane).
const html = htm.bind(h);

export function Plan({v, e, pane}) {
  pane.kind.current = {};
  const own = ev => { if ((ev.key === ' ' || ev.key === 'Enter') && ev.target.closest?.('button, a[href], [role="menuitem"]')) ev.stopPropagation(); };
  return html`<div class="dv-scroll dv-textscroll" onKeyDown=${own}>
    <${Later} name="PlanDetail" host=${v.host} plan=${e.plan} fallback=${html`<p class="df-muted" role="status">Loading…</p>`}
      failed=${(error, retry) => html`<${Failure} backend="flightplan" error=${error} host=${v.host} retry=${retry} />`} />
  </div>`;
}
