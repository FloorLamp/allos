// Keep only the last four characters of identifiers shown in collection views.
export function maskedIdentifier(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const tail = [...text].filter(char => /[a-z0-9]/i.test(char)).slice(-4).join('');
  return tail ? `••••${tail}` : '••••';
}

const identifierKey = key => /^(?:scope|number)$/i.test(key);
const namedIdentifierKey = /(?:passport|member(?:ship)?|policy|account|vin|plate|routing|tax.?id|ein|ssn).*(?:number|no)?|(?:number|no).*(?:passport|member(?:ship)?|policy|account|vin|plate|routing|tax.?id|ein|ssn)/i;

export function maskIdentifiers(value) {
  if (Array.isArray(value)) return value.map(maskIdentifiers);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    (identifierKey(key) || namedIdentifierKey.test(key)) && typeof item === 'string' ? maskedIdentifier(item) : maskIdentifiers(item)]));
}
