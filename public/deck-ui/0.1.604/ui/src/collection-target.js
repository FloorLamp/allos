// Collection identity comes from recorded projections, never document names or opaque ID patterns.
export const COLLECTIONS = ['people', 'vehicles', 'properties', 'insurance', 'papers', 'taxes', 'things', 'clusters'];
const fields = {people: 'person', vehicles: 'vehicle', properties: 'property', insurance: 'insurance', papers: 'paper', taxes: 'packet', things: 'thing', clusters: 'cluster'};
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 240 ? value
  : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;

export function collectionTarget(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.collection && typeof value.collection === 'object') return collectionTarget(value.collection);
  if (COLLECTIONS.includes(value.collection)) {
    const id = identity(value.id);
    if (id != null) return {collection: value.collection, id, ...(value.document && typeof value.document === 'object' ? {document: value.document} : {})};
  }
  const raw = value.result ?? value;
  for (const collection of COLLECTIONS) {
    const entity = raw[fields[collection]] ?? value[fields[collection]] ?? (collection === 'taxes' ? raw.tax ?? value.tax : null);
    if (!entity || typeof entity !== 'object' || collection === 'things' && entity.type !== 'product') continue;
    const id = identity(collection === 'taxes' ? entity.year : entity.id);
    if (id == null) continue;
    const document = raw.document ?? value.document;
    return {collection, id, ...(document && typeof document === 'object' ? {document} : {})};
  }
  return null;
}

export const collectionName = target => ({people: 'Person', vehicles: 'Vehicle', properties: 'Property', insurance: 'Policy', papers: 'Identity paper', taxes: 'Tax packet', things: 'Product', clusters: 'Cluster'})[target?.collection] ?? 'Collection';
