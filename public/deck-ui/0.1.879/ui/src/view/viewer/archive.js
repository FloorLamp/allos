// An archive (palette SPEC.md, *Kinds*: `archive`): a zip's entries in the rows' anatomy (glyph by type, name, `size · folder`); typing
// filters them (the filter takes the keys: ↑ / ↓ choose, Enter opens); a viewable entry opens in the viewer (history), another says
// `Open in <source> ↗`.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {countText, plural} from '../../format.js';
import {Glyph} from '../../glyphs.js';
import {openIn, size} from '../../viewer.js';
import {attachmentGlyph, opensHere} from './common.js';
import {plainText} from '../keys.js';

const html = htm.bind(h);

/** Entries whose path holds every word of the filter. */
export const filtered = (entries, q) => { const ws = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean); return entries.filter(x => ws.every(w => x.name.toLowerCase().includes(w))); };

export function Archive({v, e, pane}) {
  const a = e.answer, entries = a.entries ?? [];
  const [q, setQ] = useState(e.view.filter ?? '');
  const [at, setAt] = useState(-1);
  const input = useRef(null), list = useRef(null);
  const shown = filtered(entries, q);
  const depth = e.attachments.length;
  const open = x => opensHere(x, depth) ? v.openAttachment(x) : v.source();
  useEffect(() => { setAt(q ? 0 : -1); }, [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'}); }, [at]);
  pane.kind.current = {
    // typing anywhere in the viewer filters
    key(k, ev) {
      if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && /\S/.test(k) && !['R', 'N', '/'].includes(k)) { input.current?.focus(); return false; }
      return false;
    },
    fieldKey(k) {
      if (k === 'Down' || k === 'Up') { setAt(i => Math.max(0, Math.min(shown.length - 1, i + (k === 'Down' ? 1 : -1)))); return true; }
      if (k === 'Enter' && shown[at]) { open(shown[at]); return true; }
      if (k === 'Esc' && q) { setQ(''); return true; }
      return false;
    },
  };
  return html`
    <div class="dv-archive">
      <div class="dv-filter"><input class="dk-field" ref=${plainText(input)} type="search" placeholder="Filter the files" aria-label="Filter the files" value=${q}
        onInput=${ev => { e.view.filter = ev.target.value; setQ(ev.target.value); }} /></div>
      <ol class="dv-scroll dv-rows" ref=${list} role="listbox" aria-label="Files">
        ${shown.map((x, i) => {
          const cut = x.name.lastIndexOf('/'), dir = cut >= 0 ? x.name.slice(0, cut) : '', name = cut >= 0 ? x.name.slice(cut + 1) : x.name, shows = opensHere(x, depth);
          return html`<li key=${x.n} role="option" aria-selected=${i === at} class="dv-row" title=${x.name} onClick=${() => open(x)} onMouseMove=${() => at !== i && setAt(i)}>
            <span class="dk-tile"><${Glyph} name=${attachmentGlyph(x)} /></span>
            <span class="lines"><b>${name}</b><span>${[size(x.size), dir].filter(Boolean).join(' · ')}</span></span>
            ${shows ? null : html`<span class="end">${openIn(e.source)} ↗</span>`}
          </li>`;
        })}
        ${shown.length ? null : html`<li class="dk-state"><b>No file matches “${q}”</b></li>`}
      </ol>
      ${(a.total ?? 0) > entries.length ? html`<div class="dv-sheets"><span class="note">The first ${countText(entries.length)} of ${plural(a.total, 'file')}</span></div>` : null}
    </div>`;
}
