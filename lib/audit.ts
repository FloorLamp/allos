// Audit log writer (issue #22): a durable record of WHO (login) did WHAT (action)
// to WHOSE data (active profile / target). Complements the AI-only trail in
// data/logs/ai.jsonl — this covers auth + PHI-access + admin/family events. Rows
// live in the GLOBAL `audit_events` table (schema in lib/db.ts), an admin-only
// surface like `sessions`; it is intentionally NOT profile-scoped (a token-authed
// or pre-login event has no acting profile), so it's excluded from the
// profile-scoping leak test.
//
// PHI RULE: the `detail` field holds IDENTIFIERS ONLY (a username, a record id, a
// grant diff) — NEVER medical content. Call sites pass short identifiers and this
// module caps length as a backstop.
//
// Server-only: uses the sync SQLite handle. recordAudit() NEVER throws into the
// caller — a logging failure must not break the request it's auditing.

import { db } from "./db";
import { createLogger } from "./log";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  retentionModifier,
} from "./audit-actions";
import { monthsAgoModifier } from "./retention";

const log = createLogger("audit");

export interface AuditInput {
  // The acting login, or null for token-authed / pre-login events (a failed
  // login, a public share-link view). The id is stored raw (no FK) so the record
  // survives the login's later deletion.
  loginId?: number | null;
  // The profile the login was acting as, or null when there's no profile context.
  profileId?: number | null;
  // A dotted, kebab-case action (see AUDIT_ACTIONS in lib/audit-actions.ts).
  action: string;
  // A coarse identifier for the thing acted on (record/file/login/link id). Never
  // PHI content.
  target?: string | null;
  // A SHORT extra identifier detail (a username, a grant diff like "+2,-3"). Never
  // PHI content.
  detail?: string | null;
}

// Bound the free-text-ish columns so a buggy/hostile caller can't bloat the row.
// These only ever hold identifiers, so this is a generous cap.
const MAX_FIELD = 200;
function cap(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s;
}

const INSERT_STMT = db.prepare(
  `INSERT INTO audit_events (login_id, active_profile_id, action, target, detail)
   VALUES (?, ?, ?, ?, ?)`
);

// Append one audit event. Best-effort: any failure is logged and swallowed so the
// audited request is never broken by its own audit write.
export function recordAudit(e: AuditInput): void {
  try {
    INSERT_STMT.run(
      e.loginId ?? null,
      e.profileId ?? null,
      e.action,
      cap(e.target),
      cap(e.detail)
    );
  } catch (err) {
    log.error("failed to record audit event", { action: e.action, err });
  }
}

// Retention sweep, driven from the hourly notify tick. Deletes events older than
// the configured window and, when `maxRows` is given, additionally trims to the
// newest `maxRows` rows as a hard size cap. The window is `maxMonths` when supplied
// (the admin-configurable audit-retention setting the tick reads — issue #98),
// otherwise `maxDays` (default 90, kept for callers/tests that want a day window).
// Returns the number of rows removed. Never throws — a prune failure must not stop
// the tick.
export function pruneAuditEvents(
  opts: { maxDays?: number; maxMonths?: number; maxRows?: number } = {}
): number {
  let deleted = 0;
  try {
    if (opts.maxMonths != null) {
      deleted += db
        .prepare(`DELETE FROM audit_events WHERE ts < datetime('now', ?)`)
        .run(monthsAgoModifier(opts.maxMonths)).changes;
    } else {
      const maxDays = opts.maxDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
      deleted += db
        .prepare(`DELETE FROM audit_events WHERE ts < datetime('now', ?)`)
        .run(retentionModifier(maxDays)).changes;
    }
    if (opts.maxRows != null) {
      // Keep the newest maxRows by id (monotonic with ts). Delete everything else.
      deleted += db
        .prepare(
          `DELETE FROM audit_events
             WHERE id NOT IN (
               SELECT id FROM audit_events ORDER BY id DESC LIMIT ?
             )`
        )
        .run(opts.maxRows).changes;
    }
  } catch (err) {
    log.error("failed to prune audit events", { err });
  }
  return deleted;
}
