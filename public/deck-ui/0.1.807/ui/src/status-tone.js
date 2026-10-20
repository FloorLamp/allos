/** Status chip tones; unrecognised labels remain neutral. Explicit row tones take precedence. */
export const statusTone = status => ({
  failing: 'warn', 'needs you': 'warn', 'needs-you': 'warn', expiring: 'warn', 'renewal needed': 'warn',
  expired: 'bad', 'term ended': 'bad',
  upcoming: 'accent',
})[String(status ?? '').trim().toLowerCase()] ?? '';
