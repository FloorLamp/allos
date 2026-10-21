// A quantity: one number the views show the same way whatever it measures (dollars, gallons of propane, kWh, a tank's %, days
// between fills, a blood-pressure reading). No DOM. contract/foundation.md, *Quantity*.
//   {value, unit?, format?: 'number' | 'currency' | 'percent' | 'duration', precision?, sign?: 'auto' | 'always', tone?: 'good' | 'bad' | 'neutral'}
// `unit`: a currency's ISO code under `currency` ('USD' when absent), else text after the number ('gal', 'kWh', 'mmHg'); `duration`
// reads `value` in seconds as `3d 4h`. `tone` is the meaning of this value to its owner; nothing is green or red by itself.
const MINUS = '−';
const TONES = ['good', 'bad', 'neutral'];

const grouped = (abs, min, max) => abs.toLocaleString('en-US', {minimumFractionDigits: min, maximumFractionDigits: max});

/** The number's text with its sign (`−` for negative, `+` for positive when sign is 'always') and unit; null/NaN: `–`. */
export function formatQuantity(q) {
  if (q == null || q.value == null || !Number.isFinite(q.value)) return '–';
  const {value, unit = '', format = 'number', precision, sign = 'auto'} = q;
  const abs = Math.abs(value);
  const body = format === 'currency' ? new Intl.NumberFormat('en-US', {style: 'currency', currency: unit || 'USD', minimumFractionDigits: precision ?? 2, maximumFractionDigits: precision ?? 2}).format(abs)
    : format === 'percent' ? `${grouped(abs, precision ?? 0, precision ?? 0)}%`
    : format === 'duration' ? durationText(abs)
    : `${grouped(abs, precision ?? (abs < 10 && !Number.isInteger(abs) ? 1 : 0), precision ?? (abs < 10 && !Number.isInteger(abs) ? 1 : 0))}${unit ? ` ${unit}` : ''}`;
  // a negative that rounds to zero is not shown as one
  const mark = value < 0 && /[1-9]/.test(body.replace(unit, '')) ? MINUS : sign === 'always' && value > 0 ? '+' : '';
  return `${mark}${body}`;
}

const UNITS = [['y', 31536000], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
/** Seconds as the two largest units: `45s`, `4m 50s`, `3d 4h`; null: `–`. */
export function durationText(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return '–';
  const s = Math.round(Math.abs(seconds));
  if (s === 0) return '0s';
  const out = [];
  let rest = s;
  for (const [name, size] of UNITS) {
    if (rest >= size) { out.push(`${Math.floor(rest / size)}${name}`); rest %= size; }
    if (out.length === 2) break;
  }
  return out.join(' ');
}

/** Seconds as a media clock: `3:12`, `1:02:03`. */
export function timecodeText(seconds) {
  const t = Math.round(seconds ?? 0), m = Math.floor(t / 60), ss = String(t % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The money preset: `money(-42.5)` → {value, format: 'currency', unit: 'USD', sign: 'always', tone}. Money in is good, out is neutral
 *  (a purchase is not an alarm); pass `tone` to say otherwise. */
export function money(value, {currency = 'USD', tone, precision} = {}) {
  return {value, unit: currency, format: 'currency', sign: 'always', precision, tone: tone ?? (value > 0 ? 'good' : 'neutral')};
}

const SYMBOLS = {'$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY'};
/** An amount as a source wrote it (`231.36 USD`, `$11,200.00`, `USD 12`, `-$5.00`, `($42.00)`) as a currency quantity for
 *  formatQuantity (`$231.36`); null for anything else (a bare number names no currency). */
export function moneyText(text) {
  const m = /^(?:([A-Z]{3}) )?([-−(])? ?([$€£¥])? ?([-−])?(\d[\d,]*(?:\.\d+)?)\)?(?: ([A-Z]{3}))?$/.exec(String(text ?? '').trim().replace(/\s+/g, ' '));
  if (!m || (!m[1] && !m[3] && !m[6])) return null;
  const value = Number(m[5].replace(/,/g, '')) * (m[2] || m[4] ? -1 : 1);
  return Number.isFinite(value) ? {value, unit: m[1] ?? m[6] ?? SYMBOLS[m[3]], format: 'currency'} : null;
}

/** The tone for `value` where `higher` says what a higher number means ('good', 'bad' or 'neutral'); zero and null are neutral. */
export function toneFor(value, higher = 'neutral') {
  if (value == null || value === 0 || !Number.isFinite(value) || higher === 'neutral') return 'neutral';
  return (value > 0) === (higher === 'good') ? 'good' : 'bad';
}

/** A tone class suffix: the quantity's own, else neutral. */
export const toneOf = q => TONES.includes(q?.tone) ? q.tone : 'neutral';

/** A delta against a comparison: `delta(q, from, {label, higher})` → {text: '+12 gal', pct: '+9%', tone, label}. The change is
 *  `value − from.value` in q's own format; `pct` is null when `from` is zero. */
export function delta(q, from, {label = null, higher = 'neutral', pct = true} = {}) {
  if (q?.value == null || from?.value == null) return null;
  const diff = q.value - from.value;
  const text = formatQuantity({...q, value: diff, sign: 'always', tone: undefined});
  return {text, pct: pct && from.value ? `${diff < 0 ? MINUS : diff > 0 ? '+' : ''}${grouped(Math.abs(diff / from.value) * 100, 0, 0)}%` : null,
    tone: toneFor(diff, higher), dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', label};
}

/** Money however a backend sent it (a number, `{amount, currency}`, `{value, unit}`, text moneyText reads: `'25 USD'`) as
 *  `$25.00`; text that is no amount as given; nothing: null. `sign` 'always' marks money in with `+`. */
export function amountText(value, {currency = 'USD', sign = 'auto', precision} = {}) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') { const q = moneyText(value); return q ? formatQuantity({...q, sign, precision}) : value; }
  const amount = Number(typeof value === 'object' ? value.amount ?? value.value : value);
  const unit = typeof value === 'object' ? value.currency ?? value.unit ?? currency : currency;
  return Number.isFinite(amount) ? formatQuantity({value: amount, format: 'currency', unit, sign, precision}) : null;
}
