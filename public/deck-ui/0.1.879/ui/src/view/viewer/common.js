// What the viewer's kinds share: the query's words marked in text (text nodes and <mark>s, never markup), a full view's photos, an
// attachment's or archive entry's glyph and card (SPEC.md, *Kinds*: glyph, name, `size · n pages`, or `Open in <source> ↗` where it does not show here).
import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
import {docGlyph} from '../../../../palette/model.mjs';
import {MAX_DEPTH, OPENS, openIn, size} from '../../viewer.js';
import {countText, plural} from '../../format.js';
import {SectionHead} from '../drawer.js';
import {PhotoStrip, setItems} from '../photo-strip.js';

const html = htm.bind(h);

/** The photos Find found of what a full view shows (`e.photos`: SPEC.md, *Photos*): a Photos section, its strip; a thumbnail its photo
 *  here, `+n` all of them (history). `label`: headed as a trip's, a day's or a thing's sections are (`PHOTOS`), else as a record's. */
export function EntryPhotos({v, e, label = false}) {
  if (!e.photos) return null;
  const strip = html`<${PhotoStrip} items=${setItems(e.photos)} total=${e.photos.total} host=${v.host} label=${e.photos.title}
    onOpen=${i => v.openPhotos(e.photos, i)} onAll=${() => v.openPhotos(e.photos)} />`;
  return label ? html`<section class="dv-tsec" aria-label=${e.photos.title}><div class="dk-label">Photos</div>${strip}</section>`
    : html`<section class="dk-section dv-photos-section" aria-label=${e.photos.title}><${SectionHead} level=${3} title="Photos" meta=${countText(e.photos.total)} />${strip}</section>`;
}

/** A query's words (at least 2 characters, lowercased). */
export const wordsOf = q => String(q ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);

/** Text with each of `words` marked: an array of strings and <mark> elements. */
export function marked(text, words) {
  const s = String(text ?? '');
  if (!words?.length) return s;
  const re = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return s.split(re).map((part, i) => i % 2 ? html`<mark key=${i}>${part}</mark>` : part);
}

/** An attachment's type as its name or MIME type says: `PDF`, `XLSX`. */
export const typeOf = a => { const m = /\.([a-z0-9]{1,6})$/i.exec(a.name ?? ''); return m ? m[1].toUpperCase() : String(a.type ?? '').split('/')[1]?.toUpperCase() ?? ''; };

/** An attachment's or entry's glyph (docGlyph by its kind, type and extension). */
export function attachmentGlyph(a) {
  const ext = /\.([a-z0-9]+)$/i.exec(a.name ?? '')?.[1]?.toLowerCase() ?? '';
  const type = a.kind === 'table' ? 'spreadsheet' : a.kind === 'archive' ? 'zip' : a.kind === 'video' ? 'video'
    : /^image\//.test(a.type ?? '') || a.of === 'image' ? 'image' : {pdf: 'document', csv: 'spreadsheet', xlsx: 'spreadsheet', xls: 'spreadsheet', zip: 'zip', pptx: 'slides'}[ext] ?? ext;
  return docGlyph({type});
}

/** Whether an attachment opens here at this depth. */
export const opensHere = (a, depth) => OPENS.includes(a.kind) && !a.unavailable && depth < MAX_DEPTH;

/** An attachment card: a click opens it in the viewer (history), or the document's page when it does not show here. */
export function Card({a, depth = 0, source, onOpen}) {
  const shows = opensHere(a, depth);
  const sub = a.unavailable ? (a.unavailable === 'signal' ? 'In Signal' : 'No longer available at Google') : shows ? [typeOf(a), size(a.size), a.count ? plural(a.count, 'page') : ''].filter(Boolean).join(' · ')
    : [size(a.size), `${openIn(source)} ↗`].filter(Boolean).join(' · ');
  return html`<button class="dv-card" title=${shows ? `Show ${a.name} here` : `${a.name}: ${openIn(source)}`} disabled=${!!a.unavailable} onClick=${() => onOpen(a)}>
    <span class="dk-tile"><${Glyph} name=${attachmentGlyph(a)} /></span>
    <span class="lines"><b>${a.name}</b><span class=${shows ? '' : 'away'}>${sub}</span></span>
  </button>`;
}
