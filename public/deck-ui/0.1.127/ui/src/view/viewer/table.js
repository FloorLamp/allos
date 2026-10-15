// A table (palette SPEC.md, *Kinds*: `table`): a grid of bridge's cells (up to 1,000 rows × 50 columns a sheet), only the rows in
// view drawn; the header row frozen, the first column too when it scrolls sideways; cells 28 high with hair rules, numbers in tabular
// figures to the right; sheets as tabs under it; the header's find keeps rows holding every word highlighted (N / Shift+N, `match i
// of n`); a click, drag or Shift+click selects cells and Mod+C copies them as tab-separated text (Copy in the header: the sheet).
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {marked, wordsOf} from './common.js';

const html = htm.bind(h);
export const ROW = 28;
const OVERSCAN = 12;

/** A cell that reads as a number: `1,837.50`, `$38.00`, `(42)`, `12%`. */
export const numeric = c => /^[-+$€£¥(]?\s?[\d,.]*\d[\d,.]*%?\)?$/.test(String(c ?? '').trim());
/** Each column's width from its widest cell among the first 200 rows: 56 to 320 px. */
export function widths(rows, cols) {
  const w = Array(cols).fill(0);
  for (const r of rows.slice(0, 200)) for (let j = 0; j < cols; j++) w[j] = Math.max(w[j], String(r[j] ?? '').length);
  return w.map(n => Math.round(Math.min(320, Math.max(56, n * 7.4 + 22))));
}
/** Rows (of the body) holding every word. */
export const hitsOf = (body, words) => !words.length ? [] : body.flatMap((r, i) => { const t = r.join(' ').toLowerCase(); return words.every(w => t.includes(w)) ? [i] : []; });
/** Cells as tab-separated text, one line a row. */
export const tsv = rows => rows.map(r => r.map(c => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');

export function Table({v, e, pane, find}) {
  const sheets = e.answer.sheets ?? [];
  const [at, setAt] = useState(Math.min(e.view.sheet ?? 0, Math.max(0, sheets.length - 1)));
  const s = sheets[at] ?? {rows: [], name: ''};
  const cols = Math.max(s.columnCount ?? 0, ...s.rows.map(r => r.length), 0);
  const head = s.rows[0] ?? [], body = s.rows.slice(1);
  const ws = useMemo(() => widths(s.rows, cols), [s, cols]);
  const scroller = useRef(null), dragging = useRef(false);
  const [view, setView] = useState({top: 0, h: 600});
  const [sel, setSel] = useState(null); // {r0, c0, r1, c1}: body rows
  const words = wordsOf(find?.q ?? ''), qWords = wordsOf(e.query);
  const hits = useMemo(() => hitsOf(body, words), [s, find?.q]);
  // where the find is among its hits, for the find's text (a new text starts at its first hit at once)
  const [hit, setHit] = useState({q: null, at: -1});
  const fq = `${at}:${find?.q ?? ''}`;
  const hitAt = hit.q === fq ? hit.at : hits.length ? 0 : -1;
  const setHitAt = i => setHit({q: fq, at: i});
  const hitSet = new Set(hits);

  const toRow = i => { const el = scroller.current; if (el && i >= 0) el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 3); };
  const step = d => { if (!hits.length) return; const i = Math.max(0, Math.min(hits.length - 1, hitAt + d)); setHitAt(i); toRow(hits[i]); };
  useEffect(() => { if (hits.length) toRow(hits[0]); }, [find?.q, at]);
  useEffect(() => { pane.setInfo({sheet: at, matches: hits.length, matchAt: hitAt}); });
  useLayoutEffect(() => {
    const el = scroller.current, measure = () => setView({top: el.scrollTop, h: el.clientHeight});
    measure();
    // measured on the next frame: a size that changes the layout again must not loop the observer
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { e.view.sheet = at; }, [at]);

  const rect = sel && {r0: Math.min(sel.r0, sel.r1), r1: Math.max(sel.r0, sel.r1), c0: Math.min(sel.c0, sel.c1), c1: Math.max(sel.c0, sel.c1)};
  const selected = (i, j) => rect && i >= rect.r0 && i <= rect.r1 && j >= rect.c0 && j <= rect.c1;
  pane.kind.current = {
    step, findEnter: step,
    copyText: () => tsv(s.rows),
    key(k) {
      if (k !== 'Mod+C' || !rect) return false;
      v.copy(tsv(body.slice(rect.r0, rect.r1 + 1).map(r => Array.from({length: rect.c1 - rect.c0 + 1}, (_, j) => r[rect.c0 + j] ?? ''))));
      return true;
    },
  };

  const cell = ev => { const td = ev.target.closest('td[data-r]'); return td ? {r: Number(td.dataset.r), c: Number(td.dataset.c)} : null; };
  const onDown = ev => {
    const c = cell(ev);
    if (!c || ev.button !== 0) return;
    ev.preventDefault();
    dragging.current = true;
    setSel(s0 => ev.shiftKey && s0 ? {...s0, r1: c.r, c1: c.c} : {r0: c.r, c0: c.c, r1: c.r, c1: c.c});
    pane.root.current?.focus({preventScroll: true});
  };
  const onOver = ev => { if (!dragging.current) return; const c = cell(ev); if (c) setSel(s0 => s0 && {...s0, r1: c.r, c1: c.c}); };
  useEffect(() => { const up = () => { dragging.current = false; }; addEventListener('pointerup', up); return () => removeEventListener('pointerup', up); }, []);

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN), last = Math.min(body.length, Math.ceil((view.top + view.h) / ROW) + OVERSCAN);
  const total = ws.reduce((t, w) => t + w, 0);
  const td = (c, i, j) => html`<td key=${j} data-r=${i} data-c=${j} class=${[j === 0 ? 'first' : '', numeric(c) ? 'num' : '', selected(i, j) ? 'sel' : ''].filter(Boolean).join(' ')}
    title=${String(c ?? '').length > 40 ? c : null}>${marked(c ?? '', words.length ? words : qWords)}</td>`;
  return html`
    <div class="dv-table">
      ${s.rows.length ? html`<div class="dv-scroll dv-grid" ref=${scroller} onScroll=${ev => setView({top: ev.currentTarget.scrollTop, h: ev.currentTarget.clientHeight})}
        onPointerDown=${onDown} onPointerOver=${onOver}>
        <table style=${`width:${total}px`} aria-rowcount=${body.length + 1} aria-colcount=${cols}>
          <colgroup>${ws.map((w, j) => html`<col key=${j} style=${`width:${w}px`} />`)}</colgroup>
          <thead><tr>${Array.from({length: cols}, (_, j) => html`<th key=${j} class=${j === 0 ? 'first' : ''} scope="col">${head[j] ?? ''}</th>`)}</tr></thead>
          <tbody>
            ${first > 0 ? html`<tr class="pad" style=${`height:${first * ROW}px`}></tr>` : null}
            ${body.slice(first, last).map((r, k) => {
              const i = first + k;
              return html`<tr key=${i} class=${hitSet.has(i) ? (hits[hitAt] === i ? 'hit at' : 'hit') : ''} aria-rowindex=${i + 2}>${Array.from({length: cols}, (_, j) => td(r[j], i, j))}</tr>`;
            })}
            ${last < body.length ? html`<tr class="pad" style=${`height:${(body.length - last) * ROW}px`}></tr>` : null}
          </tbody>
        </table>
      </div>` : html`<div class="dk-state"><b>This sheet is empty</b></div>`}
      ${sheets.length > 1 || s.truncated ? html`<div class="dv-sheets">
        ${sheets.length > 1 ? html`<nav class="tabs" aria-label="Sheets">${sheets.map((x, i) => html`<button key=${i} class=${`dk-chip${i === at ? ' on' : ''}`} aria-pressed=${i === at}
          onClick=${() => { setAt(i); setSel(null); scroller.current && (scroller.current.scrollTop = 0); }}><span>${x.name}</span></button>`)}</nav>` : null}
        ${s.truncated ? html`<span class="note">The first ${body.length.toLocaleString('en-US')} of ${Math.max(0, (s.rowCount ?? 0) - 1).toLocaleString('en-US')} rows</span>` : null}
      </div>` : null}
    </div>`;
}
