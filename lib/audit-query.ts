// Audit log read layer (issue #22), for the admin-only Settings → Audit viewer.
// Reads the GLOBAL `audit_events` table (never profile-owned, so no profile_id
// scoping applies) with server-side filtering + LIMIT/OFFSET pagination — the
// whole table is never shipped to the client. login_id / active_profile_id carry
// no FK (the audit record must outlive a deleted login/profile), so usernames and
// profile names are attached via LEFT JOIN and read as null once the referent is
// gone.

import { db } from "./db";
import {
  AUDIT_PAGE_SIZE,
  actionDomain,
  clampPage,
  pageOffset,
} from "./audit-actions";

export interface AuditRow {
  id: number;
  ts: string;
  login_id: number | null;
  active_profile_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  // Resolved for display; null when the login/profile was since deleted.
  username: string | null;
  profile_name: string | null;
}

export interface AuditFilters {
  loginId?: number | null;
  profileId?: number | null;
  // An action DOMAIN prefix (e.g. "login", "medical-file"); matches the exact
  // action or any action under that domain.
  actionPrefix?: string | null;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
}

// Build the shared WHERE clause + bound params for a filter set. Returned as a
// fragment so the count and page queries stay in lockstep.
function buildWhere(filters: AuditFilters): {
  clause: string;
  params: (string | number)[];
} {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (filters.loginId != null) {
    conds.push("a.login_id = ?");
    params.push(filters.loginId);
  }
  if (filters.profileId != null) {
    conds.push("a.active_profile_id = ?");
    params.push(filters.profileId);
  }
  if (filters.actionPrefix) {
    // Exact action, or any action in that domain ("login" → "login.%").
    conds.push("(a.action = ? OR a.action LIKE ?)");
    params.push(filters.actionPrefix, filters.actionPrefix + ".%");
  }
  return {
    clause: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
}

// One page of audit events, newest first, plus the total matching count (for the
// pager). page is 1-based; pageSize defaults to AUDIT_PAGE_SIZE.
export function queryAuditEvents(
  filters: AuditFilters = {},
  page = 1,
  pageSize = AUDIT_PAGE_SIZE
): AuditPage {
  const { clause, params } = buildWhere(filters);

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM audit_events a ${clause}`)
      .get(...params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT a.id, a.ts, a.login_id, a.active_profile_id, a.action,
              a.target, a.detail,
              l.username AS username, p.name AS profile_name
         FROM audit_events a
         LEFT JOIN logins l ON l.id = a.login_id
         LEFT JOIN profiles p ON p.id = a.active_profile_id
         ${clause}
        ORDER BY a.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, pageOffset(page, pageSize)) as AuditRow[];

  return { rows, total, page: clampPage(page), pageSize };
}

export interface LoginOption {
  id: number;
  username: string;
}
export interface ProfileOption {
  id: number;
  name: string;
}

// Filter dropdown sources. Logins + profiles come from their own (global) tables
// so the picker lists every current login/profile, not only those that happen to
// appear in the log.
export function auditFilterOptions(): {
  logins: LoginOption[];
  profiles: ProfileOption[];
  actionDomains: string[];
} {
  const logins = db
    .prepare("SELECT id, username FROM logins ORDER BY username COLLATE NOCASE")
    .all() as LoginOption[];
  const profiles = db
    .prepare("SELECT id, name FROM profiles ORDER BY name COLLATE NOCASE")
    .all() as ProfileOption[];
  // Distinct action domains actually present in the log, sorted.
  const actions = (
    db.prepare("SELECT DISTINCT action FROM audit_events").all() as {
      action: string;
    }[]
  ).map((r) => r.action);
  const actionDomains = [...new Set(actions.map(actionDomain))].sort();
  return { logins, profiles, actionDomains };
}
