// A thing's page is its hub (contract/things.md *Hub*; model src/thing-hub.js): Live (its House devices with House's own controls
// and confirmation), Usage and Health (the 12-week strip, the sessions, each logged one In Health), Rules (Habitat's, each to House
// admin), Purchase and warranty (its order and Money's charges), Papers (each in the shared viewer). A part bridge could not read
// from Habitat is one quiet line where Live would be; the rest stands.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {CONTROLLED, createHouse, stateText} from '../house.js';
import {chargeHref, chargeLine, createUsage, deviceEntities, healthLine, healthOf, purchaseFacts, ruleHref, ruleLine, sessionLine,
  thingPapers, usageSummary, usageWeeks, whenText} from '../thing-hub.js';
import {countText, dateText, fieldLabel, joinText, plural} from '../format.js';
import {openable} from '../host/host.js';
import {Facts, Section} from './drawer.js';
import {SiteLink} from './entity-link.js';
import {Failure} from './page-state.js';
import {RowList} from './rows.js';
import {Confirm, Tile} from './house-controls.js';
const html = htm.bind(h);

const external = (host, url) => { if (openable(url)) host?.call('url.open', {url}).catch(() => {}); };
/** A link out of Deck (Allos's Health): a real link, opened through the host (a desktop's browser, the site's new tab). */
export const OutLink = ({host, url, children, label = null}) => html`<a class="dk-entity" href=${url} target="_blank" rel="noopener noreferrer"
  aria-label=${label} onClick=${ev => { ev.preventDefault(); external(host, url); }}>${children}</a>`;

/** A reading's own line (a power sensor: `0 W`): House's words for its state. */
const reading = (house, e) => ({label: e.name, value: stateText(e, house.state(e.id))});

/** The devices' entities as House shows them: a control as House's tile (its confirmation, its action through Habitat), a reading
 *  as a fact. One House model for the page's devices, watching only theirs. */
function HouseControls({host, devices}) {
  const [house] = useState(() => createHouse(host, {view: 'thing', ...deviceEntities(devices)}));
  const [, redraw] = useState(0);
  useEffect(() => {
    const off = house.subscribe(() => redraw(n => n + 1));
    house.start();
    const key = ev => { if (ev.key === 'Escape') house.cancel(); };
    addEventListener('keydown', key);
    return () => { off(); removeEventListener('keydown', key); house.stop(); };
  }, [house]);
  return html`${devices.map(d => {
    const own = house.entities.filter(e => e.device === d.id);
    const controls = own.filter(e => CONTROLLED.has(e.domain)), readings = own.filter(e => !CONTROLLED.has(e.domain));
    return html`<section key=${d.id} class="dk-hub-device" aria-label=${d.name ?? 'Device'}>
      ${devices.length > 1 || !controls.length ? html`<h3 class="dk-label">${d.name ?? 'Device'}</h3>` : null}
      ${controls.length ? html`<div class="dk-hub-controls">${controls.map(e => html`<${Tile} key=${e.id} house=${house} e=${e} />`)}</div>` : null}
      ${readings.length ? html`<${Facts} facts=${readings.map(e => reading(house, e))} />` : null}
    </section>`;
  })}
  ${house.error ? html`<${Failure} backend="habitat" error=${house.error} host=${host} inline=${true} retry=${() => { house.stop(); house.error = null; house.start(); }} />` : null}
  <${Confirm} house=${house} />
  <div class="dh-status" role="status">${house.outcome ? html`<span class=${house.outcome.bad ? 'bad' : ''}>${house.outcome.text}</span>` : null}</div>`;
}

/** Bridge's device states as facts, for a host with no House (Habitat not set up there): what bridge read, no control. */
function DeviceFacts({devices}) {
  return devices.map(d => html`<section key=${d.id} class="dk-hub-device" aria-label=${d.name ?? 'Device'}>
    <h3 class="dk-label">${d.name ?? 'Device'}</h3>
    <${Facts} facts=${(d.entities?.length ? d.entities : [{id: d.id, name: 'State', state: d.state}]).map((e, _, all) => ({label: e.name ?? (all.length === 1 ? 'State' : fieldLabel(String(e.id).replace(/^[a-z_]+\./, ''))),
      value: stateText({domain: e.domain ?? String(e.id).split('.')[0], attributes: e.unit ? {unit_of_measurement: e.unit} : {}}, {state: e.state})}))} />
  </section>`);
}

/** Live: each linked device's state with its control (House's), its alerts. */
export function HubLive({thing, host}) {
  const devices = (thing.devices ?? []).filter(d => d?.id), alerts = thing.alerts ?? [];
  if (!devices.length && !alerts.length) return null;
  const house = host?.backends?.includes('habitat');
  return html`<${Section} title="Live" class="dk-section dk-hub-live">
    ${devices.length ? house ? html`<${HouseControls} host=${host} devices=${devices} />` : html`<${DeviceFacts} devices=${devices} />` : null}
    ${alerts.length ? html`<${RowList} inline=${true} items=${alerts.map(a => ({id: `alert:${a.id}`, glyph: 'warn', title: a.title,
      sub: joinText([a.detail, a.since ? `since ${dateText(a.since)}` : null]) || null, badge: a.state ? {text: fieldLabel(a.state)} : null}))} />` : null}
  <//>`;
}

/** The 12 weeks as a strip of days, a used day filled; its words for a screen reader. */
function UsageStrip({days, now}) {
  const {columns, count} = usageWeeks(days, now);
  return html`<div class="dk-hub-strip" role="img" aria-label=${`Used on ${plural(count, 'day')} in the last 12 weeks`}>
    ${columns.map((week, w) => html`<span key=${w} class="dk-hub-week">${week.map(d => html`<span key=${d.day}
      class=${`dk-hub-day${d.used ? ' used' : ''}${d.future ? ' future' : ''}`} title=${d.future ? null : `${dateText(d.day)}${d.used ? ': used' : ''}`} />`)}</span>`)}
  </div>`;
}

const SHOWN = 5;
/** Usage and Health: the summary, the strip, the sessions (the newest few, All n › every one, More past bridge's page), the Health line. */
export function HubUsage({thing, host}) {
  const usage = thing.usage, health = thing.health;
  const [model] = useState(() => createUsage(host, thing.id, usage));
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => () => model.stop(), [model]);
  if (!usage && !health) return null;
  const now = new Date();
  const shown = model.all ? model.sessions : model.sessions.slice(0, SHOWN);
  const hidden = model.sessions.length > SHOWN || model.next;
  // bridge gives no total: every one read so far is the count once its last page is in
  const all = model.next ? 'All sessions ›' : `All ${countText(model.sessions.length)} ›`;
  const rows = shown.map(s => {
    const logged = healthOf(s);
    return {id: `session:${s.start}`, glyph: 'chart', title: whenText(s.start, now), sub: sessionLine(s),
      ...(logged === 'logged' ? {end: {label: 'In Health ›', aria: `In Health: ${whenText(s.start, now)}`, onClick: () => external(host, s.practice.url)}}
        : logged === 'not' ? {badge: {text: 'Not in Health', tone: ''}} : {})};
  });
  return html`<${Section} title="Usage" class="dk-section dk-hub-usage"
    actions=${hidden && !model.all ? html`<button type="button" class="dk-btn text" onClick=${() => model.showAll()}>${all}</button>` : null}>
    ${usage ? html`<p class="dk-hub-summary">${usageSummary(usage, now)}</p>
      <${UsageStrip} days=${usage.days ?? []} now=${now} />` : null}
    ${health ? html`<p class="dk-hub-health">${health.url ? html`<${OutLink} host=${host} url=${health.url}>${healthLine(health)} ›<//>` : healthLine(health)}</p>` : null}
    ${rows.length ? html`<${RowList} inline=${true} host=${host} items=${rows} />` : null}
    ${model.all && model.next ? html`<div class="dk-hub-more"><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.more()}>${model.loading ? 'Loading…' : 'More sessions'}</button></div>` : null}
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} host=${host} inline=${true} retry=${() => model.more()} />` : null}
  <//>`;
}

/** Rules: Habitat's that read or move the thing's devices, each to its place in House admin. */
export function HubRules({thing, host}) {
  const rules = thing.rules ?? [];
  if (!rules.length) return null;
  const now = new Date();
  return html`<${Section} title="Rules" meta=${countText(rules.length)} class="dk-section dk-hub-rules">
    <${RowList} inline=${true} host=${host} items=${rules.map(r => ({id: `rule:${r.id}`, glyph: 'bolt', tip: r.title,
      title: html`<${SiteLink} host=${host} path=${ruleHref(r)} label=${r.title ?? r.id} />`, sub: r.summary || null, summary: ruleLine(r, now),
      badge: {text: r.mode === 'live' ? 'Live' : 'Shadow', tone: r.mode === 'live' ? 'accent' : ''},
      ...(r.healthy === false || r.lastOutcome?.ok === false ? {dot: 'warn'} : {})}))} />
  <//>`;
}

/** Purchase and warranty: what bridge has of its order, the order's document (the viewer) and Money's charges. */
export function HubPurchase({thing, host, onOpen}) {
  const p = thing.purchase, facts = purchaseFacts(p, thing.warranty), charges = p?.charges ?? [];
  if (!facts.length && !p?.document && !charges.length) return null;
  const rows = [
    ...(p?.document ? [{id: `doc:${p.document.id}`, glyph: 'order', title: p.document.title ?? 'Order', sub: joinText(['Order', p.store, p.date ? dateText(p.date) : null])}] : []),
    ...charges.map(c => ({id: `charge:${c.id}`, glyph: 'money', tip: chargeLine(c),
      title: html`<${SiteLink} host=${host} path=${chargeHref(c)} label=${chargeLine(c)} />`, sub: 'In Money'})),
  ];
  return html`<${Section} title="Purchase and warranty" class="dk-section dk-hub-purchase">
    ${facts.length ? html`<${Facts} facts=${facts} />` : null}
    ${rows.length ? html`<${RowList} inline=${true} host=${host} items=${rows} onOpen=${r => r.id === `doc:${p?.document?.id}` ? onOpen?.(p.document) : null} />` : null}
  <//>`;
}

/** Papers: every email and document the thing has (its own, its manuals, the ones linked to it), each in the viewer; its order's
 *  document is Purchase's, above, never said again. */
export function HubPapers({thing, links = [], onOpen}) {
  const papers = thingPapers(thing, links, {shown: thing.purchase?.document?.id != null ? [thing.purchase.document.id] : []});
  if (!papers.length) return null;
  return html`<${Section} title="Papers" meta=${countText(papers.length)} class="dk-section dk-hub-papers">
    <${RowList} inline=${true} items=${papers.map(d => ({id: d.id, glyph: d.what === 'Manual' ? 'document' : d.what === 'Order' ? 'mail' : 'document', title: d.title ?? 'Document',
      sub: joinText([d.what, d.date ? dateText(d.date) : null]) || null}))} onOpen=${r => onOpen?.(papers.find(d => d.id === r.id))} />
  <//>`;
}

/** A part bridge could not read: one quiet line in its place (`what`: House, where Live, Usage and Rules would be; Usage; Rules),
 *  Retry reading the thing again. */
export const Unavailable = ({what = 'House', retry}) => html`<p class="dk-note dk-hub-unavailable" role="status">${what} unavailable · <button type="button"
  class="dk-btn text" onClick=${retry}>Retry</button></p>`;
/** Usage or Rules alone unread: its section with that line. */
export const PartUnavailable = ({title, retry}) => html`<${Section} title=${title} class=${`dk-section dk-hub-${title.toLowerCase()}`}><${Unavailable} what=${title} retry=${retry} /><//>`;
