// Find's Due soon (palette SPEC.md *Rows*, the empty query): what is overdue, then due in the next 30 days, on a host with the
// `obligations` cap; read each time the box empties, nothing shown until it has rows. Five, then `All n ›`; a row opens its held document, else its source URL.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useReducer, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {createDueSoon} from '../../due-soon.js';
import {RowsSection} from './rows-section.js';
const html = htm.bind(h);

export const LANDING = 5;
export function DueSoon({host, idle, fold, onOpen, limit = LANDING}) {
  const [model] = useState(() => createDueSoon(host));
  const [, redraw] = useReducer(n => n + 1, 0);
  useEffect(() => { const off = model.subscribe(redraw); return () => { off(); model.stop(); }; }, [model]);
  useEffect(() => { if (idle) model.refresh(); }, [idle]);
  return idle ? html`<${RowsSection} id="due-soon" label="Due soon" items=${model.items} limit=${limit} all=${true} fold=${fold} host=${host}
    onOpen=${it => it.docId != null ? onOpen(it.docId) : it.url ? host.call('url.open', {url: it.url}).catch(() => {}) : null} />` : null;
}
