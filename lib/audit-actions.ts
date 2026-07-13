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
  // Optional TOTP 2FA (issue #23). enable/disable are the enrollment lifecycle;
  // twofaFailure is a wrong/expired second-factor code at login (username only,
  // never the code); twofaRecoveryUsed marks a one-time recovery code being
  // redeemed; twofaBypass is the loud, audited env-var override
  // (ALLOS_DISABLE_2FA) that lets a locked-out admin back in without a code.
  twofaEnable: "login.2fa-enable",
  twofaDisable: "login.2fa-disable",
  twofaFailure: "login.2fa-failure",
  twofaRecoveryUsed: "login.2fa-recovery-used",
  twofaBypass: "login.2fa-bypass",
  loginCreate: "login.create",
  loginDelete: "login.delete",
  profileSwitch: "profile.switch",
  profileCreate: "profile.create",
  profileDelete: "profile.delete",
  grantUpdate: "grant.update",
  medicalFileView: "medical-file.view",
  medicalDocUpload: "medical-document.upload",
  medicalDocDelete: "medical-document.delete",
  // Moving a document — and its ENTIRE import footprint — across profiles (issue
  // #655) is the single most audit-worthy data movement in the app, so it earns its
  // own action alongside the file view/upload/delete events. target = document id,
  // detail = source→destination profile ids (identifiers only, no medical content).
  medicalDocReassign: "medical-document.reassign",
  // Provider registry admin mutations (issue #655). The GLOBAL, admin-only edits to
  // the shared provider rows: an identity edit (provider.update) and a duplicate
  // merge (provider.merge), which re-points every link then DELETES the absorbed
  // row. Because the absorbed row is gone and integer ids never recycle, the merge
  // detail records the absorbed id + NAME + surviving id + per-table re-point counts
  // — otherwise "what did this merge absorb" is unrecoverable.
  providerUpdate: "provider.update",
  providerMerge: "provider.merge",
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
  // Per-dataset CSV export (issue #471): the /api/export/<dataset> route serves the
  // identical full-table PHI as the ZIP (ds.rows() unbounded), so "someone exported
  // the whole biomarker history" must be logged here too — not only when the ZIP
  // button was used. target = the dataset key, detail = the row count that left.
  exportDataset: "export.dataset",
} as const;

// DELIBERATELY UNAUDITED PHI egress, recorded here so it reads as a decision, not a
// gap (issue #471): the token-authed calendar `.ics` feed and the Telegram
// notification sends. Both are high-frequency machine pulls/pushes (a subscribed
// calendar client refetches every few hours; the tick fans out per profile), so an
// audit row per fetch/send would be poll spam that buries the real access events —
// and each already has its own trail (token mint/revoke rows, the notify delivery
// markers). Auditing them would degrade the log without adding accountability.

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

// A 90-day day-window fallback, kept ONLY for callers/tests that prune by a day
// count. It is NOT the tick's default: the hourly notify tick prunes by the
// admin-configurable MONTH window (`DEFAULT_AUDIT_RETENTION_MONTHS = 24` in
// lib/retention.ts unless overridden), so the real out-of-the-box retention is 24
// months, not 90 days. See pruneAuditEvents() (lib/audit.ts) — maxMonths wins when
// supplied, and the tick always supplies it.
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
