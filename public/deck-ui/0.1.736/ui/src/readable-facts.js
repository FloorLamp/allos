import {formatQuantity} from './quantity.js';

export const fieldLabel = key => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
const excluded = /^(body|content|text|messages|history|conversations|raw|html)$/i;

/** Metadata leaves as labelled facts; keep identifiers intact and quantities together. */
export function readableFacts(value, label = '', depth = 0) {
  if (value == null || value === '' || depth > 8) return [];
  if (typeof value !== 'object') {
    const text = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value).trim();
    return text ? [{label, value: text}] : [];
  }
  if (!Array.isArray(value) && Number.isFinite(value.value) && typeof value.unit === 'string') {
    return [{label, value: formatQuantity({...value, precision: value.precision ?? Math.min(20, String(value.value).split('.')[1]?.length ?? 0)})}];
  }
  return Object.entries(value).filter(([key]) => !excluded.test(key)).flatMap(([key, next]) =>
    readableFacts(next, [label, Array.isArray(value) ? Number(key) + 1 : fieldLabel(key)].filter(Boolean).join(' · '), depth + 1));
}
