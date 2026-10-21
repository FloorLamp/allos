// A table (palette SPEC.md, *Kinds*: `table`): a grid of bridge's cells (up to 1,000 rows × 50 columns a sheet), only the rows in
// view drawn; the header row frozen, the first column too when it scrolls sideways; cells 28 high with hair rules, numbers in tabular
// figures to the right; sheets as tabs under it; the header's find keeps rows holding every word highlighted (N / Shift+N, `match i
// of n`); a click, drag or Shift+click selects cells and Mod+C copies them as tab-separated text (Copy in the header: the sheet).
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {countText, plural} from '../../format.js';
import {marked, wordsOf} from './common.js';
import {ChipGroup} from '../chip-group.js';

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
/** Columns whose filled cells (among the first 200 rows of the body) are all numbers: their headers align right over them. */
export function numericColumns(body, cols) {
  return Array.from({length: cols}, (_, j) => {
    const cells = body.slice(0, 200).map(r => String(r[j] ?? '').trim()).filter(Boolean);
    return cells.length > 0 && cells.every(numeric);
  });
}
/** The first column of a row holding one of the words (-1: none). */
export const hitColumn = (row, words) => words.length ? row.findIndex(c => { const t = String(c ?? '').toLowerCase(); return words.some(w => t.includes(w)); }) : -1;
/** The scrollLeft that shows column j whole beside the frozen first column (scrollLeft kept when it does already). Scrolling right, a
 *  column's edge meets the frozen column's: no sliver of a column shows beside it. */
export function scrollToColumn(ws, j, left, width) {
  if (j <= 0) return left;
  const x = ws.slice(0, j).reduce((t, w) => t + w, 0), w = ws[j], frozen = ws[0] ?? 0;
  if (x + w > left + width) {
    const need = Math.min(x - frozen, x + w - width);
    let start = frozen;
    for (let k = 1; k < j && start - frozen < need; k++) start += ws[k];
    return Math.max(0, start - frozen);
  }
  if (x < left + frozen) return Math.max(0, x - frozen);
  return left;
}
/** Rows (of the body) holding every word. */
export const hitsOf = (body, words) => !words.length ? [] : body.flatMap((r, i) => { const t = r.join(' ').toLowerCase(); return words.every(w => t.includes(w)) ? [i] : []; });
/** Cells as tab-separated text, one line a row. */
export const tsv = rows => rows.map(r => r.map(c => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');

/** The grid's scroll: the rows in view; whether columns lie past its right edge (a shade there, clear of its scroll bars). */
const viewOf = el => ({top: el.scrollTop, h: el.clientHeight, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  bar: el.offsetWidth - el.clientWidth, under: el.offsetHeight - el.clientHeight});

export function Table({v, e, pane, find}) {
  const sheets = e.answer.sheets ?? [];
  const [at, setAt] = useState(Math.min(e.view.sheet ?? 0, Math.max(0, sheets.length - 1)));
  const s = sheets[at] ?? {rows: [], name: ''};
  const cols = Math.max(s.columnCount ?? 0, ...s.rows.map(r => r.length), 0);
  const head = s.rows[0] ?? [], body = s.rows.slice(1);
  const ws = useMemo(() => widths(s.rows, cols), [s, cols]);
  const nums = useMemo(() => numericColumns(body, cols), [s, cols]);
  const scroller = useRef(null), dragging = useRef(false);
  const [view, setView] = useState({top: 0, h: 600, right: false, bar: 0, under: 0});
  const [sel, setSel] = useState(null); // {r0, c0, r1, c1}: body rows
  const words = wordsOf(find?.q ?? ''), qWords = wordsOf(e.query);
  const hits = useMemo(() => hitsOf(body, words), [s, find?.q]);
  // where the find is among its hits, for the find's text (a new text starts at its first hit at once)
  const [hit, setHit] = useState({q: null, at: -1});
  const fq = `${at}:${find?.q ?? ''}`;
  const hitAt = hit.q === fq ? hit.at : hits.length ? 0 : -1;
  const setHitAt = i => setHit({q: fq, at: i});
  const hitSet = new Set(hits);

  // a match in view: its row a third down, its first matching cell sideways
  const toRow = i => {
    const el = scroller.current;
    if (!el || i < 0) return;
    el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 3);
    el.scrollLeft = scrollToColumn(ws, hitColumn(body[i] ?? [], words), el.scrollLeft, el.clientWidth);
  };
  const step = d => { if (!hits.length) return; const i = Math.max(0, Math.min(hits.length - 1, hitAt + d)); setHitAt(i); toRow(hits[i]); };
  useEffect(() => { if (hits.length) toRow(hits[0]); }, [find?.q, at]);
  useEffect(() => { pane.setInfo({sheet: at, matches: hits.length, matchAt: hitAt}); });
  useLayoutEffect(() => {
    const el = scroller.current, measure = () => setView(viewOf(el));
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
      ${s.rows.length ? html`<div class="dv-gridwrap"><div class="dv-scroll dv-grid" ref=${scroller} onScroll=${ev => setView(viewOf(ev.currentTarget))}
        onPointerDown=${onDown} onPointerOver=${onOver}>
        <table style=${`width:${total}px`} aria-rowcount=${body.length + 1} aria-colcount=${cols}>
          <colgroup>${ws.map((w, j) => html`<col key=${j} style=${`width:${w}px`} />`)}</colgroup>
          <thead><tr>${Array.from({length: cols}, (_, j) => html`<th key=${j} class=${[j === 0 ? 'first' : '', nums[j] ? 'num' : ''].filter(Boolean).join(' ')} scope="col">${head[j] ?? ''}</th>`)}</tr></thead>
          <tbody>
            ${first > 0 ? html`<tr class="pad" style=${`height:${first * ROW}px`}></tr>` : null}
            ${body.slice(first, last).map((r, k) => {
              const i = first + k;
              return html`<tr key=${i} class=${hitSet.has(i) ? (hits[hitAt] === i ? 'hit at' : 'hit') : ''} aria-rowindex=${i + 2}>${Array.from({length: cols}, (_, j) => td(r[j], i, j))}</tr>`;
            })}
            ${last < body.length ? html`<tr class="pad" style=${`height:${(body.length - last) * ROW}px`}></tr>` : null}
          </tbody>
        </table>
      </div>${view.right ? html`<div class="dv-gridshade" aria-hidden="true" style=${`right:${view.bar}px;bottom:${view.under}px`}></div>` : null}</div>`
        : html`<div class="dk-state"><b>This sheet is empty</b></div>`}
      ${sheets.length > 1 || s.truncated ? html`<div class="dv-sheets">
        ${sheets.length > 1 ? html`<${ChipGroup} class="tabs" label="Sheets" value=${at} options=${sheets.map((x, i) => ({value: i, label: html`<span>${x.name}</span>`}))}
          onChange=${i => { setAt(i); setSel(null); scroller.current && (scroller.current.scrollTop = 0); }} />` : null}
        ${s.truncated ? html`<span class="note">The first ${countText(body.length)} of ${plural(Math.max(0, (s.rowCount ?? 0) - 1), 'row')}</span>` : null}
      </div>` : null}
    </div>`;
}
