// A person and a trip (palette SPEC.md, *Kinds*: `person`, `trip`; bridge CONTRACT.md *Pages*): bridge's view of what several
// documents share. A person: their line, their phone and email to copy, where else they are (the family tree, their photos: each opens
// its page), their conversations by day, the mails and papers naming them,
// the projects they appear in (each opens its group). A trip: its line, then its legs in order (a flight's route, a stay's or a car's
// name, its days, its confirmation numbers to copy, its documents). Every document opens in the viewer (history). Text only.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
import {dateLabel, docGlyph, docSubtitle, periodLabel} from '../../../../palette/model.mjs';
import {Link} from './thing.js';

const html = htm.bind(h);
const LEG = {flight: 'trip', stay: 'stay', car: 'car'};

/** A leg's days: `Jul 31, 2021`, `Aug 1 – Aug 5, 2021` (model dateLabel), else the month it names. */
export function legDays(l) {
  if (!l.from) return l.month ? periodLabel(l.month) : '';
  return !l.to || l.to === l.from ? dateLabel(l.from) : `${dateLabel(l.from)} – ${dateLabel(l.to)}`;
}

function Section({label, children}) {
  return html`<section class="dv-tsec"><div class="dk-label">${label}</div>${children}</section>`;
}
function Doc({v, d}) {
  return html`<button class="dv-row dv-tdoc" title=${d.title} onClick=${() => v.openRelated({document: d})}>
    <span class="dk-tile"><${Glyph} name=${docGlyph(d)} /></span>
    <span class="lines"><b>${d.title}</b><span>${docSubtitle(d, d.reason ?? null)}</span></span>
  </button>`;
}
/** Numbers to copy: `Phone +1 555 0100`, each its own button (Copied in the header). */
function Numbers({v, ids}) {
  return html`<dl class="dv-tlist">${ids.map(x => html`<div key=${x.value}><dt>${x.title}</dt><dd>
    <button class="dk-btn text dv-tcopy" title=${`Copy ${x.value}`} onClick=${() => v.copy(x.value)}>${x.value}</button></dd></div>`)}</dl>`;
}
function Scroll({e, children}) {
  const body = useRef(null);
  useEffect(() => { if (e.view.scrollTop != null && body.current) body.current.scrollTop = e.view.scrollTop; }, []);
  return html`<div class="dv-scroll dv-textscroll" ref=${body} onScroll=${ev => { e.view.scrollTop = ev.currentTarget.scrollTop; }}>
    <article class="dv-thing">${children}</article></div>`;
}

export function Person({v, e, pane}) {
  const p = e.answer?.person ?? {};
  pane.kind.current = {};
  const docs = (label, list) => list?.length ? html`<${Section} label=${label}>${list.map(d => html`<${Doc} key=${d.id} v=${v} d=${d} />`)}<//>` : null;
  return html`<${Scroll} e=${e}>
    <p class="dv-tid">${[p.role, p.vendor, p.line].filter(Boolean).join(' · ')}</p>
    ${p.ids?.length ? html`<${Section} label="Contact"><${Numbers} v=${v} ids=${p.ids} /><//>` : null}
    ${p.links?.length ? html`<${Section} label="Links"><div class="dv-tlinks">${p.links.map(l => html`<${Link} key=${l.url} v=${v} url=${l.url}>${l.title}<//>`)}</div><//>` : null}
    ${p.projects?.length ? html`<${Section} label="Projects"><div class="dv-tlinks dv-tprojects">${p.projects.map(x => html`
      <button key=${x.id} class="dk-btn text dv-tlink" onClick=${() => v.chip({key: `project:${x.id}`, label: x.name})}>${x.name} ›</button>`)}</div><//>` : null}
    ${docs('Conversations', p.conversations)}
    ${docs('Mail', p.mails)}
    ${docs('Papers', p.papers)}
  <//>`;
}

export function Trip({v, e, pane}) {
  const t = e.answer?.trip ?? {};
  pane.kind.current = {};
  return html`<${Scroll} e=${e}>
    <p class="dv-tid">${t.line ?? ''}</p>
    <${Section} label="Itinerary">
      ${(t.legs ?? []).map((l, i) => html`<div class="dv-tleg" key=${i}>
        <p class="dv-tlegh"><span class="dk-tile"><${Glyph} name=${LEG[l.kind] ?? 'document'} /></span>
          <span class="lines"><b>${l.title}</b><span>${[legDays(l), l.kind === 'flight' && l.flights > 1 ? `${l.flights} flights` : null].filter(Boolean).join(' · ')}</span></span></p>
        ${l.numbers?.length ? html`<${Numbers} v=${v} ids=${l.numbers} />` : null}
        ${(l.documents ?? []).map(d => html`<${Doc} key=${d.id} v=${v} d=${d} />`)}
      </div>`)}
    <//>
  <//>`;
}

/** Calendar dates stay in the event's zone; all-day boundaries are exclusive. */
export function eventTime(e) {
  if (!e.start) return '';
  if (e.allDay) {
    const last = e.end ? new Date(Date.parse(`${e.end.slice(0, 10)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : e.start.slice(0, 10);
    return `${dateLabel(e.start.slice(0, 10))}${last > e.start.slice(0, 10) ? ` – ${dateLabel(last)}` : ''} · All day`;
  }
  const format = value => new Intl.DateTimeFormat('en-US', {timeZone: e.timeZone || 'UTC', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'}).format(new Date(value));
  return [e.start, e.end].filter(Boolean).map(format).join(' – ');
}

function Result({v, r}) {
  const d = r.document;
  return html`<button class="dv-row dv-tdoc" onClick=${() => v.openRelated(r)}>
    <span class="dk-tile"><${Glyph} name=${r.kind === 'event' ? 'day' : r.kind === 'person' ? 'person' : docGlyph(d)} /></span>
    <span class="lines"><b>${r.title ?? d.title}</b><span>${r.subtitle ?? docSubtitle(d)}</span></span>
  </button>`;
}

export function Event({v, e, pane}) {
  const event = e.answer?.event ?? {};
  pane.kind.current = {};
  return html`<${Scroll} e=${e}>
    <p class="dv-tid">${eventTime(event)}</p>
    ${event.place ? html`<p>${event.place}</p>` : null}
    ${event.attendees?.length ? html`<${Section} label="Attendees">${event.attendees.map((a, i) => a.document
      ? html`<${Result} key=${a.document.id} v=${v} r=${a} />`
      : html`<p key=${i}>${[a.name, a.email].filter(Boolean).join(' · ')}</p>`)}<//>` : null}
    ${event.documents?.length ? html`<${Section} label="Documents">${event.documents.map(r => html`<${Result} key=${r.document.id} v=${v} r=${r} />`)}<//>` : null}
  <//>`;
}

export function Day({v, e, pane}) {
  pane.kind.current = {};
  return html`<${Scroll} e=${e}><${Section} label="Events">${(e.answer?.day?.results ?? []).map(r => html`<${Result} key=${r.event.id} v=${v} r=${r} />`)}<//><//>`;
}
