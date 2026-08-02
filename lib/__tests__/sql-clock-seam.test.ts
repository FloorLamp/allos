import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sqlNow } from "../clock";

// Static boundary guard for the SQL-side clock (issue #1534).
//
// lib/clock.ts is the app's clock seam: `now()` returns the real instant in
// production and the FROZEN ALLOS_TEST_NOW instant under e2e, so a suite can't cross
// midnight out from under its "today"-seeded fixtures. SQL's own `date('now')` /
// `datetime('now')` / CURRENT_TIMESTAMP reads the REAL clock and the seam cannot
// reach it — so a suite that STRADDLES real 00:00 UTC writes rows stamped on one
// side of the boundary and reads them back against a `today()` on the other. That is
// exactly what took 3 of 4 CI shards red on the 2026-07-25→26 night, across two PRs
// (one of them a JSON-only edit), in an exclusively date-keyed failure set: illness
// episode day counts, the #1460 dose-date window, sleep nights, import time-windows.
// #1464's forward nudge fixed only the JS half.
//
// The rule this guard freezes: **a now-read whose value is later reduced to a
// calendar DAY must come from the seam** — bind `sqlNow()` (or derive the date from
// `today(profileId)`), never SQL's `datetime('now')`. "Reduced to a calendar day"
// means a SQL `date(col)` / `substr(col, 1, 10)`, a JS `.slice(0, 10)` /
// `dateFromCreatedAt`, a `YYYY-MM-DD` string comparison, or a per-day GROUP BY that
// meets a `today()`-derived value.
//
// Everything else deliberately KEEPS SQL's real clock, because the seam must never
// own a DURATION (see lib/clock.ts's header): session/token expiry, lease and claim
// timeouts, rate-limit windows, retention cutoffs, rolling "last N days" windows, and
// plain "last modified" audit stamps. Those are the allowlist below — every entry
// carries the reason it is not date-semantic.
//
// This test reads the repo's own source as TEXT (no DB, no network) so it stays
// "pure" in the vitest sense — the same shape as lib/__tests__/immediate-tx.test.ts
// and lib/__tests__/telegram-chokepoint.test.ts.
//
// SCOPE / KNOWN GAP: the scan sees raw now-reads in QUERY TEXT. A column DEFAULT of
// `(datetime('now'))` lives in a shipped, immutable migration and cannot be scanned
// here — the write sites that must not rely on such a default (intake_items,
// intake_item_doses, medical_documents, conditions, allergies, imaging_studies,
// goals, injuries) instead bind `sqlNow()` explicitly, each with a comment naming
// #1534. The CI midnight backstop (.github/actions/e2e-setup) is the belt to this
// test's braces for whatever the audit missed.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for production source.
const SCAN_DIRS = ["lib", "app", "scripts"];

// A raw now-read in SQL text: any SQLite date/time function given the 'now'
// time-value (with or without modifiers), plus the CURRENT_TIMESTAMP keyword.
const NOW_READ_RE =
  /(?:\b(?:date|datetime|julianday|strftime|unixepoch)\s*\(\s*[^)]*'now')|\bCURRENT_TIMESTAMP\b/g;

// Files permitted to keep raw now-reads, frozen at their current count with the
// reason each is NOT date-semantic. A NEW raw now-read anywhere fails this test; so
// does a stale count, so the ledger keeps shrinking as reads are converted or
// deleted. Adding an entry means asserting "this value's calendar day is never
// compared to today()" — say why.
const ALLOW: Record<string, { count: number; why: string }> = {
  "app/(app)/data/actions.ts": {
    count: 5,
    why: "import_jobs.updated_at — a job-state audit stamp, also the stuck-job lease the boot sweep reaps by DURATION. Never day-reduced.",
  },
  "app/(app)/immunizations/actions.ts": {
    count: 1,
    why: "immunization_overrides.created_at — audit stamp on an upsert keyed by (profile_id, vaccine). Never day-reduced.",
  },
  "lib/activity-write.ts": {
    count: 1,
    why: "journal updated_at — a 'last modified' audit stamp. (Moved with saveActivityCore's extraction out of app/(app)/training/activity-actions.ts, #1596.)",
  },
  "app/(app)/settings/family/page.tsx": {
    count: 1,
    why: "sessions.expires_at > now — session EXPIRY, a duration comparison.",
  },
  "app/(auth)/login/actions.ts": {
    count: 3,
    why: "login_attempts rate-limit window + its cleanup — durations, not days.",
  },
  "lib/ai.ts": {
    count: 1,
    why: "insights.created_at — audit stamp; the row's day is its own `date` column, supplied by the caller.",
  },
  "lib/api-tokens.ts": {
    count: 4,
    why: "api_tokens created_at / last_used_at / revoked_at (#1734) — credential LIFECYCLE stamps. Nothing reduces them to a calendar day: created/last-used are rendered as full UTC timestamps in the management UI, and revoked_at is read only for IS NULL (liveness), never compared to a today()-derived date.",
  },
  "lib/portals.ts": {
    count: 8,
    why: "portals.created_at, portal_accounts.created_at (x2 — the implicit login minted with a portal, and a named one added later), and portal_identities.created_at/updated_at (x2 since #1836: the bind/ignore upsert and remapPortalIdentity's compare-and-swap both re-stamp updated_at; x3 since #1889: the per-identity declined write is the third)  (#1739) — registry and binding AUDIT stamps ('when was this portal registered', 'when was this patient last re-bound'). Nothing reduces them to a calendar day: the card renders them as timestamps and no query compares them to a today()-derived date. The one pair here that IS reduced to a day — pending_portal_identities.first_seen_at/last_seen_at, which the card prints as 'first seen 2026-01-02' — deliberately goes through sqlNow() instead and so does not appear in this count. The acquirer's own dated data arrives as documents, which carry their own clock-seam stamps.",
  },
  "lib/audit.ts": {
    count: 2,
    why: "audit_events retention DELETE (ts < now - N) — a duration cutoff.",
  },
  "lib/auth-tokens.ts": {
    count: 4,
    why: "auth-token expiry/consume/cleanup — token lifetimes, durations.",
  },
  "lib/auth.ts": {
    count: 12,
    why: "session create/slide/expire/reap — session TTLs, which lib/clock.ts's header explicitly bars the seam from owning.",
  },
  "lib/extraction-claim.ts": {
    count: 1,
    why: "medical_documents.processing_started_at — an extraction LEASE the reaper compares by duration.",
  },
  "lib/extraction-reaper.ts": {
    count: 1,
    why: "the reap side of that lease (processing_started_at < now - N minutes).",
  },
  "lib/followup-write.ts": {
    count: 1,
    why: "care_plan_items.resolved_at — a 'when was this closed' audit stamp; the follow-up's dates are its planned_date/target_date columns.",
  },
  "lib/integrations/connections.ts": {
    count: 8,
    why: "connection last_sync_at/updated_at/refresh_claimed_at, the sync-event feed stamp, its retention sweep, and the 1-hour error-flood guard — audit stamps, claim leases and durations.",
  },
  "lib/integrations/weather-cache.ts": {
    count: 2,
    why: "weather cache fetched_at, once per grain (the hourly weather_uv_hours upsert and the daily weather_days one, #1726) — TTL/provenance stamps. Neither is ever compared to a today()-derived calendar day: the CALENDAR identity of a cached row is its own hour_ts / date column, which comes from the provider in the location's local time, not from the clock.",
  },
  "lib/medical-pipeline.ts": {
    count: 1,
    why: "processing_started_at on the reserved row — the extraction lease (uploaded_at on the same INSERT is bound from sqlNow).",
  },
  "lib/migrations/boot-tasks.ts": {
    count: 5,
    why: "stuck-extraction / stuck-import boot sweeps — duration cutoffs plus the updated_at audit stamp they write.",
  },
  "lib/mobility-log-write.ts": {
    count: 3,
    why: "activities.updated_at — a 'last modified' audit stamp; the activity's day is its own `date` column.",
  },
  "lib/notifications/digest-data.ts": {
    count: 2,
    why: "the digest send cursor (last-digest stamp, else 24h ago) — a rolling window over stored timestamps, not a calendar day.",
  },
  "lib/notifications/post-workout-imports.ts": {
    count: 1,
    why: "recent-import lookback (created_at >= now - N) — a duration window.",
  },
  "lib/notifications/push.ts": {
    count: 3,
    why: "push_subscriptions created_at/last_used_at — audit stamps.",
  },
  "lib/offline/writes.ts": {
    count: 7,
    why: "the mood store's updated_at audit stamps + the replayed_keys retention DELETE. The check-in upsert, the three per-column past-day corrections and the two optional-rating clears (#1488, extended per rating column by #1408) each stamp updated_at; the column can't be interpolated without making the SQL unreadable to the profile-scoping scanner, so one literal statement per column means one stamp per statement. An audit stamp records when the write happened; nothing compares its calendar DAY to a today()-derived value.",
  },
  "lib/queries/attention.ts": {
    count: 1,
    why: "the hero's flagged-biomarker window start (now - 14 days) — a rolling duration compared lexically against stored created_at values.",
  },
  "lib/queries/coverage.ts": {
    count: 1,
    why: "coverage ai_generated_at — a generation audit stamp.",
  },
  "lib/queries/intake/medications.ts": {
    count: 3,
    why: "medication_courses.created_at — an audit stamp. The course's DATES (started_on/stopped_on) come from the caller or from date(intake_items.created_at), which IS bound from sqlNow at every write site.",
  },
  "lib/queries/intake/refill.ts": {
    count: 2,
    why: "supply/shared-supply updated_at — audit stamps on a counter.",
  },
  "lib/queries/intake/supply-pool.ts": {
    count: 1,
    why: "shared_supplies.updated_at — an audit stamp.",
  },
  "lib/queries/integrations.ts": {
    count: 1,
    why: "import_pair_decisions.created_at — audit stamp on a decision keyed by pair_signature.",
  },
  "lib/queries/med-links.ts": {
    count: 1,
    why: "med-link decision created_at — an audit stamp.",
  },
  "lib/queries/narratives.ts": {
    count: 1,
    why: "narratives.created_at — audit stamp; the anchor is the explicit period_start/period_end.",
  },
  "lib/queries/upcoming/preventive.ts": {
    count: 1,
    why: "preventive decision created_at — an audit stamp.",
  },
  "lib/queries/upcoming/suppressions.ts": {
    count: 2,
    why: "upcoming_dismissals.dismissed_at — read only for PRESENCE (IS NOT NULL). The day-compared sibling `snooze_until` is a JS-bound date derived from today().",
  },
  "lib/queries/visit-links.ts": {
    count: 1,
    why: "visit-link decision created_at — an audit stamp.",
  },
  "lib/two-factor.ts": {
    count: 5,
    why: "TOTP challenge issue/expiry/cleanup + recovery-code used_at — challenge lifetimes and an audit stamp.",
  },
  "lib/undo-delete-db.ts": {
    count: 2,
    why: "deleted_rows undo-window retention — duration cutoffs.",
  },
  "lib/unit-mislabel-correction.ts": {
    count: 1,
    why: "upcoming_dismissals.dismissed_at — presence only, same as the suppressions writer.",
  },
  "lib/workout-finish.ts": {
    count: 1,
    why: "activities.updated_at — a 'last modified' audit stamp (end_time is bound from the clock seam).",
  },
};

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    // Shipped migrations are immutable (lib/migrations/manifest.json) and their
    // now-reads are column DEFAULTs / one-shot boot-time data moves, not request
    // paths. A fix there is an appended migration, never an edit.
    rel.startsWith("lib/migrations/versions/")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Strip line and block comments so PROSE about `datetime('now')` — of which this
// codebase has plenty, including the explanations the rewrites added — can't trip
// the scanner. Only real code counts.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function countMatches(text: string): number {
  return (stripComments(text).match(NOW_READ_RE) ?? []).length;
}

describe("SQL clock seam boundary (issue #1534)", () => {
  it("no NEW raw SQL now-read in query text — date-semantic stamps bind sqlNow()", () => {
    const violations: string[] = [];
    const seen = new Set<string>();

    for (const { rel, text } of sourceFiles()) {
      const count = countMatches(text);
      if (count === 0 && !ALLOW[rel]) continue;
      seen.add(rel);
      const allowed = ALLOW[rel]?.count ?? 0;
      if (count > allowed) {
        violations.push(
          `${rel}: ${count} raw SQL now-read(s), allowlist freezes ${allowed}. ` +
            `If the stamp's calendar DAY is ever compared to a today()-derived ` +
            `value, bind sqlNow() from @/lib/clock instead. If it is genuinely a ` +
            `duration/audit stamp, raise its entry in ` +
            `lib/__tests__/sql-clock-seam.test.ts WITH the reason.`
        );
      } else if (count < allowed) {
        violations.push(
          `${rel}: ${count} raw SQL now-read(s) but the allowlist freezes ${allowed}. ` +
            `You removed one — LOWER (or delete) its entry in ` +
            `lib/__tests__/sql-clock-seam.test.ts so the ledger keeps shrinking.`
        );
      }
    }

    for (const rel of Object.keys(ALLOW)) {
      if (!seen.has(rel)) {
        violations.push(
          `${rel}: allowlisted but the file no longer exists (or is no longer ` +
            `scanned) — remove its entry in lib/__tests__/sql-clock-seam.test.ts.`
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("every allowlist entry documents WHY its now-read is not date-semantic", () => {
    const thin = Object.entries(ALLOW)
      .filter(([, v]) => v.why.trim().length < 20)
      .map(([rel]) => rel);
    expect(
      thin,
      `These allowlist entries need a real reason (what the stamp is, and why its ` +
        `calendar day never meets today()):\n${thin.join("\n")}`
    ).toEqual([]);
  });

  it("the sqlNow() seam helper exists in lib/clock.ts", () => {
    const src = fs.readFileSync(path.join(REPO, "lib/clock.ts"), "utf8");
    expect(/export function sqlNow\b/.test(src)).toBe(true);
  });
});

describe("sqlNow()", () => {
  const KEY = "ALLOS_TEST_NOW";

  function withOverride<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[KEY];
      else process.env[KEY] = prior;
    }
  }

  it("renders the frozen instant in SQLite's datetime('now') shape (UTC, no zone)", () => {
    const out = withOverride("2026-03-14T15:09:26.535Z", () => sqlNow());
    expect(out).toBe("2026-03-14 15:09:26");
  });

  it("follows the freeze across a midnight boundary — the whole point of #1534", () => {
    expect(withOverride("2026-07-25T23:58:00Z", () => sqlNow())).toBe(
      "2026-07-25 23:58:00"
    );
    expect(withOverride("2026-07-26T00:02:00Z", () => sqlNow())).toBe(
      "2026-07-26 00:02:00"
    );
  });

  it("truncates to the same calendar day the frozen date() would yield", () => {
    const out = withOverride("2026-01-02T00:00:00Z", () => sqlNow());
    expect(out.slice(0, 10)).toBe("2026-01-02");
  });

  it("is real time — and a valid SQLite datetime string — when unfrozen", () => {
    const before = Date.now();
    const out = withOverride(undefined, () => sqlNow());
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const parsed = Date.parse(out.replace(" ", "T") + "Z");
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("ignores an unparseable override rather than freezing at the epoch", () => {
    const out = withOverride("not-a-date", () => sqlNow());
    expect(Date.parse(out.replace(" ", "T") + "Z")).toBeGreaterThan(
      Date.now() - 60_000
    );
  });
});
