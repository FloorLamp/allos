// The one outcome toast (foundation.css `.dk-toast`): one short line over the page's foot, a failure's in its tone, its actions (Undo,
// Sign in to save) beside it. Flightplan's writes, Sign-ins', House's controls and links, a thing's links, a purchase's, a record's
// Saved, Health's logging, the duplicate review and the viewer's Details.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Button} from './controls.js';
import {StatusLink} from './page-state.js';
const html = htm.bind(h);

/** An outcome the view owns: [outcome, say(text, bad = false, actions = null)]; a falsy text clears it; gone after `ms`. */
export function useOutcome(ms = 4000) {
  const [outcome, set] = useState(null);
  useEffect(() => { if (!outcome) return undefined; const t = setTimeout(() => set(null), ms); return () => clearTimeout(t); }, [outcome, ms]);
  return [outcome, (text, bad = false, actions = null) => set(text ? {text, bad, actions} : null)];
}

/** A model's outcome that never ends itself (a status line's): itself until `ms` after it showed, or while it has actions (an Undo
 *  stays while its model offers it); a new outcome (another object) shows again. */
export function useFading(outcome, ms = 4000) {
  const [gone, setGone] = useState(null), timed = !!outcome && !outcome.actions?.length;
  useEffect(() => { if (!timed) return undefined; const t = setTimeout(() => setGone(outcome), ms); return () => clearTimeout(t); }, [outcome, timed, ms]);
  return outcome && outcome !== gone ? outcome : null;
}

/** `outcome` {text, bad?, actions?: [{label, run, disabled?}]} or null: useOutcome's, useFading's or a model's that ends itself;
 *  `status`: a failure links the status page. */
export function Toast({outcome: o, status = false, host = null}) {
  return html`<div class=${`dk-toast${o ? ' on' : ''}${o?.bad ? ' bad' : ''}`} role="status">${o ? html`<span>${o.text}</span>${o.bad && status ? html`<${StatusLink} host=${host} />` : null}${(o.actions ?? []).map(a => html`<${Button}
    key=${a.label} type="button" class="dk-btn text" disabled=${a.disabled} onClick=${a.run}>${a.label}</${Button}>`)}` : null}</div>`;
}
