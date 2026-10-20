import {dateText, dateTimeText, fieldLabel} from './format.js';
import {formatQuantity, moneyText} from './quantity.js';

const excluded = /^(body|content|text|messages|history|conversations|raw|html)$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/, MOMENT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const WORD = /^[a-z]+(?:[_-][a-z]+)*$/, NAMED = /^(state|status|kind|type)$/i;

/** One leaf as people read it: days and times in the shared style, `25 USD` as money, Yes/No, a state word capitalised. */
export function factValue(value, key = '') {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).trim();
  if (DAY.test(text)) return dateText(text);
  if (MOMENT.test(text)) return dateTimeText(text);
  const money = moneyText(text);
  if (money) return formatQuantity(money);
  return NAMED.test(key) && WORD.test(text) ? fieldLabel(text) : text;
}

/** Metadata leaves as labelled facts; keep identifiers intact and quantities together. A list of one is not numbered; a
 *  `{kind | label | name, value}` pair is one fact named by its kind. */
export function readableFacts(value, label = '', depth = 0, key = '') {
  if (value == null || value === '' || depth > 8) return [];
  if (typeof value !== 'object') {
    const text = factValue(value, key);
    return text ? [{label, value: text}] : [];
  }
  if (!Array.isArray(value) && Number.isFinite(value.value) && typeof value.unit === 'string') {
    return [{label, value: formatQuantity({...value, precision: value.precision ?? Math.min(20, String(value.value).split('.')[1]?.length ?? 0)})}];
  }
  const name = !Array.isArray(value) && (value.kind ?? value.label ?? value.name);
  if (name && value.value != null && typeof value.value !== 'object' && Object.keys(value).length === 2) {
    return readableFacts(value.value, [label, fieldLabel(name)].filter(Boolean).join(' · '), depth + 1);
  }
  return Object.entries(value).filter(([k]) => !excluded.test(k)).flatMap(([k, next]) => {
    const part = Array.isArray(value) ? (value.length > 1 ? Number(k) + 1 : null) : fieldLabel(k);
    return readableFacts(next, [label, part].filter(Boolean).join(' · '), depth + 1, Array.isArray(value) ? key : k);
  });
}
