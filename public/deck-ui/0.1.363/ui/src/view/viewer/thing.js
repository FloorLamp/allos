import {dateTimeText} from '../../quantity.js';
// A thing (palette SPEC.md, *Kinds*: `thing`; bridge CONTRACT.md *Pages*): a device or plant of the house as bridge joins it: what
// it is, where, its live state (Home Assistant, read only) and network, its purchase (each order one card: what, when, total, its
// links), a plant's bloom calendar and plantings, then its documents, each opening in the viewer (history). Text and links only:
// nothing here acts on the house.
import {h} from '../../../vendor/preact.mjs';
import {useEffect, useRef} from '../../../vendor/hooks.mjs';
import htm from '../../../vendor/htm.mjs';
import {Glyph} from '../../glyphs.js';
import {dateLabel, docGlyph, docSubtitle, periodLabel} from '../../../../palette/model.mjs';

const html = htm.bind(h);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A calendar day `MM-DD` as `May 25`. */
export const dayLabel = md => { const [m, d] = String(md ?? '').split('-').map(Number); return m && d ? `${MONTHS[m - 1]} ${d}` : String(md ?? ''); };
const since = at => { const t = Date.parse(at ?? ''); return Number.isNaN(t) ? '' : dateTimeText(t, {dateStyle: 'medium', timeStyle: 'short'}); };

/** The thing's identity line: `hvac · Mysa INF-V1-0 · S/N SV3HTJ325H`, a plant's `Magnolia grandiflora · 1`. */
export function identity(t) {
  if (t.type === 'plant') return [t.botanical, t.count != null ? `${t.count} ${t.count === 1 ? 'plant' : 'plants'}` : null, t.confidence ? `identified by ${t.confidence}` : null].filter(Boolean).join(' · ');
  return [t.kind, [t.make, t.model].filter(Boolean).join(' ') || null, t.serial ? `S/N ${t.serial}` : null, t.installed ? `installed ${dateLabel(t.installed)}` : null].filter(Boolean).join(' · ');
}

function Section({label, children}) {
  return html`<section class="dv-tsec"><div class="dk-label">${label}</div>${children}</section>`;
}
export const Link = ({v, url, children}) => html`<button class="dk-btn text dv-tlink" onClick=${() => v.openUrl(url)}>${children} ↗</button>`;

function Doc({v, d}) {
  return html`<button class="dv-row dv-tdoc" title=${d.title} onClick=${() => v.openRelated({document: d})}>
    <span class="dk-tile"><${Glyph} name=${docGlyph(d)} /></span>
    <span class="lines"><b>${d.title}</b><span>${[d.order ? null : d.reason, docSubtitle(d)].filter(Boolean).join(' · ')}${d.mails?.length ? ` · ${d.mails.length + 1} mails` : ''}</span></span>
  </button>`;
}

function Order({v, o, d}) {
  return html`<div class="dv-torder">
    <button class="dv-row dv-tdoc" onClick=${() => v.openRelated({document: d})}>
      <span class="dk-tile"><${Glyph} name="order" /></span>
      <span class="lines"><b>${o.items?.length ? `${o.items[0]}${o.items.length > 1 ? ` and ${o.items.length - 1} more` : ''}` : d.title}</b>
        <span>${[o.merchant, o.date ? dateLabel(o.date) : null, o.total, o.status, o.number ? `order ${o.number}` : null].filter(Boolean).join(' · ')}</span></span>
    </button>
    ${o.links?.length ? html`<div class="dv-tlinks">${o.links.map(l => html`<${Link} key=${l.url} v=${v} url=${l.url}>${l.title}<//>`)}</div>` : null}
  </div>`;
}

export function Thing({v, e, pane}) {
  const t = e.answer?.thing ?? {}, body = useRef(null);
  const docs = t.documents ?? [], orders = docs.filter(d => d.order), others = docs.filter(d => !d.order);
  pane.kind.current = {};
  useEffect(() => { if (e.view.scrollTop != null && body.current) body.current.scrollTop = e.view.scrollTop; }, []);
  return html`
    <div class="dv-scroll dv-textscroll" ref=${body} onScroll=${ev => { e.view.scrollTop = ev.currentTarget.scrollTop; }}>
      <article class="dv-thing">
        <p class="dv-tid">${identity(t)}</p>
        ${t.type === 'plant' ? html`
          <${Section} label="Where">
            <p>${(t.areas ?? []).join('; ') || 'In the garden'}</p>
            ${t.url ? html`<${Link} v=${v} url=${t.url}>House model<//>` : null}
          <//>
          ${t.bloom || t.calendar?.length ? html`<${Section} label="Blooms">
            ${t.bloom ? html`<p class="dv-tnow">${t.bloom.text}</p>` : null}
            <dl class="dv-tlist">${(t.calendar ?? []).map(c => html`<div key=${c.key}><dt>${c.label}</dt><dd>${dayLabel(c.from)}${c.to ? `–${dayLabel(c.to)}` : ''}</dd></div>`)}</dl>
          <//>` : null}
          ${t.plantings?.length ? html`<${Section} label="Planted">
            ${t.plantings.map((p, i) => html`<div class="dv-tplant" key=${i}>
              <p><b>${/^\d{4}-\d{2}$/.test(p.date) ? periodLabel(p.date) : p.date}</b> · ${p.change}${p.count ? ` ${p.count}` : ''} · ${p.area}</p>
              ${p.note ? html`<p class="dv-tnote">${p.note}</p>` : null}
              ${p.photos?.length ? html`<div class="dv-tlinks">${p.photos.map((ph, j) => html`<${Link} key=${ph.id} v=${v} url=${ph.url}>Photo ${j + 1}<//>`)}</div>` : null}
            </div>`)}
          <//>` : null}
        ` : html`
          <${Section} label="Now">
            ${t.state ? html`<p class="dv-tnow">${t.state}</p>` : html`<p class="dv-tnote">${t.ha ? 'Home Assistant has no state for it' : 'Home Assistant did not answer'}</p>`}
            ${t.network ? html`<p>${[t.network.state, t.network.ip, t.network.host, t.network.online ? null : t.network.since ? `since ${since(t.network.since)}` : null].filter(Boolean).join(' · ')}</p>` : null}
            ${t.entities?.length ? html`<dl class="dv-tlist">${t.entities.map(x => html`<div key=${x.entity}><dt>${x.name}</dt><dd>${x.state}</dd></div>`)}</dl>` : null}
          <//>
          <${Section} label="Where">
            <p>${[t.room?.name, t.location].filter(Boolean).join(' · ') || 'Not placed in the house model'}</p>
            ${t.url ? html`<${Link} v=${v} url=${t.url}>House record<//>` : null}
          <//>
          ${orders.length || t.purchase?.price ? html`<${Section} label="Bought">
            ${t.purchase?.price ? html`<p>${t.purchase.price}</p>` : null}
            ${orders.map(d => html`<${Order} key=${d.id} v=${v} o=${d.order} d=${d} />`)}
          <//>` : null}
        `}
        ${t.type === 'plant' && orders.length ? html`<${Section} label="Bought">${orders.map(d => html`<${Order} key=${d.id} v=${v} o=${d.order} d=${d} />`)}<//>` : null}
        ${others.length ? html`<${Section} label="Documents">${others.map(d => html`<${Doc} key=${d.id} v=${v} d=${d} />`)}<//>` : null}
      </article>
    </div>`;
}
