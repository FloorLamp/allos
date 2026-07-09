// Pure helpers for the audit log (issue #22). No DB/network here — this file is
// safe to import from unit tests and from client code. The DB writer lives in
// lib/audit.ts and the read/query layer in lib/audit-query.ts.
//
// An audit ACTION is a kebab-case, dotted identifier: a DOMAIN, a dot, and a
// verb — e.g. `medical-file.view`, `profile.switch`, `login.success`. The domain
// (the part before the first dot) is what the viewer's "action" filter groups on.

// The canonical set of actions we record, so call sites and the docs can't drift
// on spelling. Grouped by domain. Values are the exact strings stored in
// audit_events.action.
export const AUDIT_ACTIONS = {
  loginSuccess: "login.success",
  loginFailure: "login.failure",
  loginThrottled: "login.throttled",
  logout: "login.logout",
  passwordChange: "login.password-change",
  passwordReset: "login.password-reset",
  loginCreate: "login.create",
  loginDelete: "login.delete",
  profileSwitch: "profile.switch",
  profileCreate: "profile.create",
  profileDelete: "profile.delete",
  grantUpdate: "grant.update",
  medicalFileView: "medical-file.view",
  medicalDocUpload: "medical-document.upload",
  medicalDocDelete: "medical-document.delete",
  shareLinkCreate: "share-link.create",
  shareLinkRevoke: "share-link.revoke",
  shareLinkView: "share-link.view",
  // Long-lived access tokens (issue #24): the calendar .ics feed and the Health
  // Connect ingest token. mint covers both first mint and rotation (a rotation IS
  // a mint that kills the old token); detail says which.
  tokenMint: "token.mint",
  tokenRevoke: "token.revoke",
  // Full-account data export (issue #18): a single portable bundle of the active
  // profile's entire record (export.full), and the clinical-passport FHIR bundle
  // download (export.fhir). Exporting everything is exactly what an audit log wants
  // to capture; the target records how many rows/files/resources left the app.
  exportFull: "export.full",
  exportFhir: "export.fhir",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

// The domain of an action — everything before the first dot (the whole string if
// there is no dot). Used to populate + apply the viewer's action filter.
export function actionDomain(action: string): string {
  const i = action.indexOf(".");
  return i === -1 ? action : action.slice(0, i);
}

// Whether an action matches a filter prefix: an exact match, or the prefix is a
// leading DOMAIN segment (so "login" matches "login.success" but not
// "login-attempt.x"). Mirrors the SQL predicate used in lib/audit-query.ts.
export function matchesActionPrefix(action: string, prefix: string): boolean {
  if (!prefix) return true;
  return action === prefix || action.startsWith(prefix + ".");
}

// ---- Retention ----

// Default audit retention: keep 90 days of events. The hourly notify tick calls
// pruneAuditEvents() with this default.
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

// The SQLite datetime() modifier for an age-based prune cutoff — e.g. 90 →
// "-90 days", so `ts < datetime('now', modifier)` selects rows older than that.
export function retentionModifier(maxDays: number): string {
  return `-${maxDays} days`;
}

// How many rows a keep-newest-N cap would delete from a table of `total` rows.
// Never negative (a table already under the cap deletes nothing).
export function rowsToPrune(total: number, maxRows: number): number {
  return Math.max(0, total - maxRows);
}

// ---- Pagination ----

export const AUDIT_PAGE_SIZE = 50;

// Coerce an arbitrary (possibly user-supplied) page value to a 1-based integer.
export function clampPage(page: number): number {
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

// The SQL OFFSET for a 1-based page of `pageSize` rows.
export function pageOffset(page: number, pageSize: number): number {
  return (clampPage(page) - 1) * pageSize;
}

// Total number of pages for `total` rows at `pageSize` (at least 1, so an empty
// table still reads as "page 1 of 1").
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}
