// The zone editor (contract/house.md *Zones*) over src/zones.js: the map (zone-map.js) beside the list on a wide screen, above it on a
// phone; the selected zone's form (name, radius, where), its Home Assistant sync, Save, Cancel and Delete with a confirmation; the
// address search; the zones Home Assistant has otherwise (drift) with Take HA's and Keep Habitat's. Built from Deck's own parts:
// the page header, rows, fields, buttons and states.
import {h} from '../../vendor/preact.mjs';
import htm from '../../vendor/htm.mjs';
import {formatQuantity} from '../quantity.js';
import {fieldLabel, joinText, plural} from '../format.js';
import {readOnly, syncState, zoneName} from '../zones.js';
import {Glyph} from '../glyphs.js';
import {PageHeader} from './page-header.js';
import {PageState, StateBlock} from './page-state.js';
import {RowList} from './rows.js';
import {Button, Field} from './controls.js';
import {ZoneMap} from './zone-map.js';

const html = htm.bind(h);
const metres = n => formatQuantity({value: n, unit: 'm', precision: 0});
const coordinate = n => formatQuantity({value: n, precision: 4});
const where = z => `${coordinate(z.latitude)}, ${coordinate(z.longitude)}`;
const FIELD = {name: 'name', radius_m: 'radius', latitude: 'latitude', longitude: 'longitude', passive: 'passive', icon: 'icon'};

function zoneRow(model, z) {
  const core = readOnly(z), sync = core ? null : syncState(z), writing = model.writing?.id === z.id ? model.writing.kind : null;
  return {id: z.id, glyph: core ? 'lock' : 'place', title: zoneName(z),
    sub: joinText([metres(z.radius_m), z.passive ? 'Passive' : null, core ? 'Home Assistant’s own' : null]),
    notes: [z.unnamed || !z.name?.trim() ? {text: 'Needs a name', tone: 'warn'} : null,
      writing ? {text: writing === 'deleting' ? 'Deleting…' : 'Saving…', tone: 'accent'}
        : sync ? {text: sync.text === 'Failed' ? `${sync.text}: ${sync.error}` : sync.text, tone: sync.tone} : null].filter(Boolean),
    end: sync?.text === 'Failed' && model.canWrite && !core ? {label: 'Retry', disabled: model.busy, onClick: () => model.retry(z.id)} : undefined};
}

function Search({model}) {
  const s = model.search;
  return html`<section class="dz-search" aria-label="Find a place">
    <form role="search" onSubmit=${ev => { ev.preventDefault(); model.find(ev.currentTarget.elements.q.value); }}>
      <input class="dk-field" type="search" name="q" placeholder="Search an address or place" aria-label="Search an address or place"
        autocomplete="off" disabled=${s.busy} />
      <${Button} type="submit" disabled=${s.busy}>${s.busy ? 'Searching…' : 'Search'}<//>
    </form>
    ${s.error ? html`<${StateBlock} inline=${true} warn=${true} title=${s.unavailable ? 'Search unavailable' : 'Search failed'}
        line=${s.unavailable ? 'Habitat couldn’t reach the address search. Try again later, or place the zone on the map.' : String(s.error.message ?? s.error)} />`
      : s.results ? html`<div class="dz-results">
        <${RowList} items=${s.results.map((r, i) => ({id: `r${i}`, glyph: 'map', title: r.name, sub: where(r)}))} onOpen=${row => model.choose(s.results[Number(row.id.slice(1))])}
          empty=${{glyph: 'find', title: `Nothing found for “${s.q}”`, line: 'Try a street address or a town.'}} />
        <${Button} variant="quiet" onClick=${() => model.clearSearch()}>Clear<//>
      </div>` : null}
  </section>`;
}

function Sync({model, zone}) {
  const sync = syncState(zone), writing = model.writing?.id === zone.id ? model.writing.kind : null;
  if (writing) return html`<div class="dz-sync" role="group" aria-label="Home Assistant">
    <span class="dp-note accent">${writing === 'deleting' ? 'Deleting…' : 'Saving…'}</span>
    <span class="dz-sync-line">Waiting for Home Assistant</span></div>`;
  if (!sync) return null;
  const line = sync.text === 'Failed' ? sync.error : sync.text === 'Pending' ? `${sync.error}. Habitat tries again every five minutes.`
    : zone.ha.entity_id ? `Home Assistant has it as ${zone.ha.entity_id}` : 'Home Assistant has it';
  return html`<div class=${`dz-sync ${sync.tone}`} role="group" aria-label="Home Assistant">
    <span class=${`dp-note ${sync.tone}`}>${sync.text}</span>
    <span class="dz-sync-line">${line}</span>
    ${sync.text === 'Failed' && model.canWrite ? html`<${Button} disabled=${model.busy} onClick=${() => model.retry(zone.id)}>Retry<//>` : null}
  </div>`;
}

function Editor({model}) {
  if (!model.selected || !model.draft) return null;
  const isNew = model.selected === 'new', zone = isNew ? null : model.zone(model.selected), d = model.draft;
  const title = isNew ? d.name.trim() || 'New zone' : zoneName(zone);
  if (zone && readOnly(zone)) return html`<section class="dz-editor" aria-label=${title}>
    <h2><${Glyph} name="lock" size=${16} /> ${title}</h2>
    <p class="dz-line">Home Assistant’s own zone, ${metres(zone.radius_m)} around ${where(zone)}. Change it in Home Assistant’s settings.</p>
    <div class="dz-actions"><${Button} onClick=${() => model.close()}>Close<//></div>
  </section>`;
  const editable = model.editable(), dirty = model.dirty();
  // a field's error once Save tried it or Habitat named it
  const shown = key => model.fields[key] ?? null;
  const number = (key, label, props) => html`<${Field} label=${label} type="number" inputmode="decimal" step="any" value=${Number.isFinite(d[key]) ? String(d[key]) : ''}
    disabled=${!editable} error=${shown(key)} onInput=${ev => model.edit(key, ev.currentTarget.value)} ...${props} />`;
  return html`<section class="dz-editor" aria-label=${title}>
    <h2>${title}</h2>
    ${zone && (zone.unnamed || !zone.name?.trim()) ? html`<p class="dz-line warn">Home Assistant never named this zone: name it, or delete it.</p>` : null}
    <form onSubmit=${ev => { ev.preventDefault(); model.save(); }}>
      <${Field} label="Name" value=${d.name} placeholder="Grocery, School…" disabled=${!editable} error=${shown('name')} autocomplete="off"
        onInput=${ev => model.edit('name', ev.currentTarget.value)} />
      ${number('radius_m', 'Radius', {unit: 'm', min: '1', step: '1', inputmode: 'numeric'})}
      <div class="dz-pair">${number('latitude', 'Latitude')}${number('longitude', 'Longitude')}</div>
      ${editable ? html`<p class="dk-field-hint">${isNew ? 'Click the map to move it. ' : ''}Drag the circle or its centre to move it, its edge to resize it.</p>` : null}
      ${zone ? html`<${Sync} model=${model} zone=${zone} />` : null}
      ${editable ? model.confirming ? html`<div class="dz-confirm" role="alertdialog" aria-label="Delete zone">
          <p>Delete ${title}? Home Assistant loses it too.</p>
          <div class="dz-actions"><${Button} variant="danger" disabled=${model.busy} onClick=${() => model.remove()}>${model.writing?.kind === 'deleting' ? 'Deleting…' : 'Delete zone'}<//>
            <${Button} onClick=${() => model.keep()}>Keep<//></div>
        </div>` : html`<div class="dz-actions">
          <${Button} type="submit" variant="primary" disabled=${!dirty || model.busy}>${model.busy ? 'Saving…' : isNew ? 'Add zone' : 'Save'}<//>
          <${Button} onClick=${() => model.cancel()}>${dirty && !isNew ? 'Cancel' : isNew ? 'Discard' : 'Close'}<//>
          ${isNew ? null : html`<${Button} variant="danger" class="dz-delete" onClick=${() => model.askDelete()}>Delete<//>`}
        </div>` : html`<div class="dz-actions"><${Button} onClick=${() => model.close()}>Close<//></div>`}
    </form>
  </section>`;
}

function Drift({model}) {
  if (!model.drift.length) return null;
  return html`<section class="dz-drift" aria-label="Different in Home Assistant">
    <h2 class="dk-label">Different in Home Assistant · ${model.drift.length}</h2>
    <p class="dz-line">Home Assistant has these otherwise. Nothing is overwritten until you choose.</p>
    ${model.drift.map(d => {
      const zone = model.zoneOf(d), gone = d.differs === 'missing-in-ha' && !!zone, missing = !gone && (d.differs === 'missing-here' || !zone);
      const differs = Array.isArray(d.differs) ? d.differs.map(f => FIELD[f] ?? fieldLabel(f)) : [];
      return html`<div key=${d.entity_id} class="dz-drift-item">
        <${RowList} items=${[{id: d.entity_id, glyph: 'warn', title: d.name || d.entity_id || 'Unnamed',
          sub: gone ? `Gone from Home Assistant · Habitat has it, ${metres(zone.radius_m)} around ${where(zone)}`
            : missing ? `Only in Home Assistant · ${metres(d.radius_m)} around ${where(d)}`
            : joinText([`Differs: ${differs.join(', ')}`, differs.includes('radius') ? `HA ${metres(d.radius_m)}, Habitat ${metres(zone.radius_m)}` : null,
              differs.includes('name') ? `HA “${d.name}”` : null])}]} />
        ${model.canWrite ? html`<div class="dz-actions" role="group" aria-label=${`Settle ${d.name || d.entity_id}`}>
          ${gone ? html`<${Button} disabled=${model.busy} onClick=${() => model.pushAgain(d)}>Push to HA<//>
            <${Button} variant="danger" disabled=${model.busy} onClick=${() => model.deleteHere(d)}>Delete here<//>`
          : html`<${Button} disabled=${model.busy} onClick=${() => model.takeHa(d)}>${missing ? 'Add it here' : 'Take HA’s'}<//>
            ${missing ? null : html`<${Button} disabled=${model.busy} onClick=${() => model.keepHabitat(d)}>Keep Habitat’s<//>`}`}
        </div>` : null}
      </div>`;
    })}
  </section>`;
}

/** The page (the host draws the shell bar above it). */
export function Zones({model, host}) {
  const add = model.canWrite ? html`<${Button} variant=${model.adding ? 'secondary' : 'primary'} aria-pressed=${String(model.adding)}
    onClick=${() => model.adding ? model.close() : model.startAdd()}>${model.adding ? 'Cancel adding' : 'Add zone'}<//>` : null;
  const unnamed = model.zones.filter(z => z.unnamed || !z.name?.trim()).length;
  return html`<main class="dk-page dz-page" aria-label="Zones">
    <${PageHeader} title="Zones" description="Places Habitat knows for presence, arrivals and zone names. Each change goes to Home Assistant too." actions=${add} />
    <${PageState} state=${model.loading && !model.zones.length ? 'loading' : undefined} error=${model.zones.length ? null : model.error} backend="habitat"
      title=${model.error ? 'Zones unavailable' : undefined} retry=${() => model.load()} host=${host}>
      ${model.canWrite ? html`<${Search} model=${model} />` : null}
      <div class=${`dz-layout${model.selected ? ' editing' : ''}`}>
        <${ZoneMap} model=${model} />
        <div class="dz-side">
          <${Editor} model=${model} />
          <section aria-label="Zones list">
            <h2 class="dk-label">Zones · ${model.zones.length}${unnamed ? html` · <span class="dz-warn">${plural(unnamed, 'needs a name', 'need a name')}</span>` : null}</h2>
            <${RowList} items=${model.zones.map(z => zoneRow(model, z))} current=${model.selected} onOpen=${row => model.select(row.id, {focus: true})}
              empty=${{glyph: 'place', title: 'No zones yet', line: model.canWrite ? 'Add one: click Add zone, then the map.' : 'Habitat has none.'}} />
          </section>
        </div>
      </div>
      <${Drift} model=${model} />
    <//>
    <div class="dz-status" role="status">${model.outcome ? html`<span class=${model.outcome.bad ? 'bad' : ''}>${model.outcome.text}</span>` : null}</div>
  </main>`;
}
