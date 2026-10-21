// Find's Browse (the site's `browse` cap): each source with its documents' count (bridge.facets, the controller's `facets`); a row
// opens that source's browse (a group with its filters).
import {h} from '../../../vendor/preact.mjs';
import htm from '../../../vendor/htm.mjs';
import {sourceName} from '../../../../palette/model.mjs';
import {plural} from '../../format.js';
import {RowsSection} from './rows-section.js';
const html = htm.bind(h);

export const LANDING = 4;
/** A source's glyph: the one its documents mostly take. */
const GLYPH = {gmail: 'mail', immich: 'photo', messages: 'chat', kb: 'note', house: 'house', 'house-model': 'house', ref: 'key', amazon: 'order'};
export const browseItems = sources => (sources ?? []).map(s => ({id: `source:${s.v}`, glyph: GLYPH[s.v] ?? 'document', title: sourceName(s.v), sub: plural(s.n, 'document'), source: s.v}));
export const Browse = ({sources, fold, host, onBrowse, limit = LANDING}) => html`<${RowsSection} id="browse" label="Browse" items=${browseItems(sources)}
  limit=${limit} fold=${fold} host=${host} onOpen=${it => onBrowse({source: it.source})} />`;
