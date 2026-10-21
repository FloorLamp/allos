// A person and a trip (palette SPEC.md, *Kinds*: `person`, `trip`; bridge CONTRACT.md *Pages*): bridge's view of what several
// documents share. A person: their line, their phone and email to copy, where else they are (the family tree, their photos: each opens
// its page), their conversations by day, the mails and papers naming them,
// the clusters they appear in (each opens its group). A trip: its line, then its legs in order (a flight's route, a stay's or a car's
// name, its days, its confirmation numbers to copy, its documents), its route over those days from location history when there is
// one (contract/media.md *Map*). Every document opens in the viewer (history).
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useMemo, useRef} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
import {docGlyph} from '../../../../palette/model.mjs';
import {docLine} from '../rows.js';
import {dateRange, dateText, eventWhen, joinText, plural} from '../../format.js';
import {tripLine} from '../../viewer.js';
import {Facts} from '../drawer.js';
import {avatarOf, normalizePersonProfile} from '../../people.js';
import {Avatar} from '../avatar.js';
import {PersonProfileContent} from '../person-profile.js';
import {TripRoute} from '../map-view.js';
import {EntryPhotos} from './common.js';

const html = htm.bind(h);
const LEG = {flight: 'trip', stay: 'stay', car: 'car'};

/** A leg's days: `Jul 31, 2021`, `Aug 1–5, 2021` (format.js dateRange), else the month it names. */
export const legDays = l => l.from ? dateRange(l.from, l.to) : l.month ? dateText(l.month) : '';

function Section({label, children}) {
  return html`<section class="dv-tsec"><div class="dk-label">${label}</div>${children}</section>`;
}
function Doc({v, d}) {
  return html`<button class="dv-row dv-tdoc" title=${d.title} onClick=${() => v.openRelated({document: d})}>
    <span class="dk-tile"><${Glyph} name=${docGlyph(d)} /></span>
    <span class="lines"><b>${d.title}</b><span>${docLine(d, d.reason ?? null)}</span></span>
  </button>`;
}
/** Numbers to copy as the shared fact rows: `Confirmation number   QWERTY`, each value its own button (Copied in the header). */
const Numbers = ({v, ids}) => html`<${Facts} facts=${ids.map(x => ({label: x.title,
  value: html`<button class="dk-btn text dv-tcopy" title=${`Copy ${x.value}`} onClick=${() => v.copy(x.value)}>${x.value}</button>`}))} />`;
function Scroll({e, children}) {
  const body = useRef(null);
  useEffect(() => { if (e.view.scrollTop != null && body.current) body.current.scrollTop = e.view.scrollTop; }, []);
  return html`<div class="dv-scroll dv-textscroll" ref=${body} onScroll=${ev => { e.view.scrollTop = ev.currentTarget.scrollTop; }}>
    <article class="dv-thing">${children}</article></div>`;
}

export function Person({v, e, pane}) {
  const p = e.answer?.person ?? {};
  const profile = useMemo(() => normalizePersonProfile(p), [p]);
  pane.kind.current = {};
  return html`<${Scroll} e=${e}>
    <${PersonProfileContent} host=${v.host} profile=${profile} view=${e.view} onCopy=${value => v.copy(value)} photos=${html`<${EntryPhotos} v=${v} e=${e} />`}
      onOpen=${document => v.openRelated({document})} onCluster=${cluster => v.openRelated({collection: {collection: 'clusters', id: cluster.id}})} />
  <//>`;
}

export function Trip({v, e, pane}) {
  const t = e.answer?.trip ?? {};
  pane.kind.current = {};
  return html`<${Scroll} e=${e}>
    <p class="dv-tid">${tripLine(t)}</p>
    <${TripRoute} host=${v.host} trip=${t} />
    <${EntryPhotos} v=${v} e=${e} label=${true} />
    <${Section} label="Itinerary">
      ${(t.legs ?? []).map((l, i) => html`<div class="dv-tleg" key=${i}>
        <p class="dv-tlegh"><span class="dk-tile"><${Glyph} name=${LEG[l.kind] ?? 'document'} /></span>
          <span class="lines"><b>${l.title}</b><span>${joinText([legDays(l), l.kind === 'flight' && l.flights > 1 ? plural(l.flights, 'flight') : null])}</span></span></p>
        ${l.numbers?.length ? html`<${Numbers} v=${v} ids=${l.numbers} />` : null}
        ${(l.documents ?? []).map(d => html`<${Doc} key=${d.id} v=${v} d=${d} />`)}
      </div>`)}
    <//>
  <//>`;
}


function Result({v, r}) {
  const d = r.document;
  return html`<button class="dv-row dv-tdoc" onClick=${() => v.openRelated(r)}>
    ${r.kind === 'person' ? html`<${Avatar} host=${v.host} ...${avatarOf(r.person ?? {}, r.person?.name ?? r.title)} />`
      : html`<span class="dk-tile"><${Glyph} name=${r.kind === 'event' ? 'day' : docGlyph(d)} /></span>`}
    <span class="lines"><b>${r.title ?? d.title}</b><span>${r.subtitle ?? docLine(d)}</span></span>
  </button>`;
}

/** An event: bridge's event view, or a calendar event read as a document (calendar-event.js: its calendar's name, its notes). */
export function Event({v, e, pane}) {
  const event = e.answer?.event ?? {};
  pane.kind.current = {};
  return html`<${Scroll} e=${e}>
    <p class="dv-twhen">${eventWhen(event, {now: Date.now()})}</p>
    ${event.place ? html`<p class="dv-tline"><${Glyph} name="place" size=${16} /><button class="dk-btn text dv-tplace" title=${`${event.place}: on the map (M)`}
      onClick=${() => v.openPlace()}>${event.place} ↗</button></p>` : null}
    ${e.kind === 'calendar' && event.calendar ? html`<p class="dv-tline dv-tnote"><${Glyph} name="day" size=${16} /><span>${event.calendar}</span></p>` : null}
    <${EntryPhotos} v=${v} e=${e} label=${true} />
    ${event.notes?.length ? html`<div class="dv-tnotes">${event.notes.map((n, i) => html`<p key=${i}>${n}</p>`)}</div>` : null}
    ${event.attendees?.length ? html`<${Section} label="Attendees">${event.attendees.map((a, i) => a.document
      ? html`<${Result} key=${a.document.id} v=${v} r=${a} />`
      // someone with no page of their own: the same row, its glyph and lines, not a button
      : html`<div key=${i} class="dv-row dv-tdoc dv-tplain"><${Avatar} name=${a.name ?? a.email} />
        <span class="lines"><b>${a.name ?? a.email}</b>${a.name && a.email ? html`<span>${a.email}</span>` : null}</span></div>`)}<//>` : null}
    ${event.documents?.length ? html`<${Section} label="Documents">${event.documents.map(r => html`<${Result} key=${r.document.id} v=${v} r=${r} />`)}<//>` : null}
  <//>`;
}

export function Day({v, e, pane}) {
  pane.kind.current = {};
  return html`<${Scroll} e=${e}><${EntryPhotos} v=${v} e=${e} label=${true} /><${Section} label="Events">${(e.answer?.day?.results ?? []).map(r => html`<${Result} key=${r.event.id} v=${v} r=${r} />`)}<//><//>`;
}
