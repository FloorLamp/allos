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
    : format === 'duration' ? duration(abs)
    : `${grouped(abs, precision ?? (abs < 10 && !Number.isInteger(abs) ? 1 : 0), precision ?? (abs < 10 && !Number.isInteger(abs) ? 1 : 0))}${unit ? ` ${unit}` : ''}`;
  // a negative that rounds to zero is not shown as one
  const mark = value < 0 && /[1-9]/.test(body.replace(unit, '')) ? MINUS : sign === 'always' && value > 0 ? '+' : '';
  return `${mark}${body}`;
}

const UNITS = [['y', 31536000], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
function duration(seconds) {
  const s = Math.round(seconds);
  if (s === 0) return '0s';
  const out = [];
  let rest = s;
  for (const [name, size] of UNITS) {
    if (rest >= size) { out.push(`${Math.floor(rest / size)}${name}`); rest %= size; }
    if (out.length === 2) break;
  }
  return out.join(' ');
}

/** The money preset: `money(-42.5)` → {value, format: 'currency', unit: 'USD', sign: 'always', tone}. Money in is good, out is neutral
 *  (a purchase is not an alarm); pass `tone` to say otherwise. */
export function money(value, {currency = 'USD', tone, precision} = {}) {
  return {value, unit: currency, format: 'currency', sign: 'always', precision, tone: tone ?? (value > 0 ? 'good' : 'neutral')};
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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date section for 'YYYY-MM-DD': {key, label} — Today, Yesterday, `Mon, Oct 12` this year, `Oct 12, 2025` before. `now` a Date. */
export function dateSection(iso, now = new Date()) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const day = Date.UTC(y, m - 1, d), today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const age = Math.round((today - day) / 86400000);
  const label = age === 0 ? 'Today' : age === 1 ? 'Yesterday'
    : y === now.getFullYear() ? `${WEEKDAYS[new Date(day).getUTCDay()]}, ${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${d}, ${y}`;
  return {key: iso.slice(0, 10), label};
}

/** A conversation's date: time today, Yesterday, weekday this week, then calendar date. */
export function textsWhen(at, now = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), ago = Math.round((day(now) - day(d)) / 86_400_000);
  if (ago === 0) return d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});
  if (ago === 1) return 'Yesterday';
  if (ago > 1 && ago < 7) return d.toLocaleDateString('en-US', {weekday: 'long'});
  return d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : {year: 'numeric'})});
}

/** Recent item age in minutes, hours, or calendar days. */
export function age(at, now = Date.now()) {
  const t = new Date(at), mins = (now - at) / 60000, today = new Date(now);
  if (!Number.isFinite(mins) || mins < 1) return 'now';
  if (mins < 60) return `${Math.floor(mins)} min`;
  const day = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(t) === day(today)) return `${Math.floor(mins / 60)} h`;
  if (day(t) === day(new Date(now - 86400000))) return 'yesterday';
  if (mins < 7 * 1440) return t.toLocaleDateString('en-US', {weekday: 'short'});
  return t.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
}

/** Locale-stable date/time text shared by views. */
export const dateText = (at, options) => new Date(at).toLocaleDateString('en-US', options);
export const timeText = (at, options) => new Date(at).toLocaleTimeString('en-US', options);
export const dateTimeText = (at, options = {dateStyle: 'medium', timeStyle: 'short'}) => new Date(at).toLocaleString('en-US', options);

export function ago(at, now) {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  if (ms < 3600000) return 'just now';
  if (ms < 86400000) { const n = Math.floor(ms / 3600000); return `${n} hour${n === 1 ? '' : 's'} ago`; }
  const n = Math.floor(ms / 86400000);
  return n < 60 ? `${n} day${n === 1 ? '' : 's'} ago` : age(Date.parse(at), now);
}
