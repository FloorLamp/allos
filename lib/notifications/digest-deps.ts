// THE DIGEST'S CHEAP PRE-CHECK (issue #2069).
//
// ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
//
// The prose reconciler (./reconcile.ts) keeps the morning digest's SENTENCES honest by
// re-running `buildDigest` and editing when the render differs. That is the right
// mechanism, but it was being paid for on every hourly tick for the rest of the day:
// the pointer stays live until rollover, so ~15-20 times per profile per day the sweep
// ran the FULL `gatherDigestInput` — a fresh `recommendWorkout` coaching scan, a fresh
// `collectUpcoming` across ~20 domains, and a per-document footprint loop — purely to
// hash the result and usually discover nothing had changed.
//
// This module answers the much cheaper question that comes first:
//
//     "has anything the digest reports on been written since we last rebuilt it?"
//
// ── WHAT IT IS, AND WHAT IT IS NOT ───────────────────────────────────────────
//
// It is an ACCELERATOR, not an oracle. The stamp below is a curated set of narrow,
// indexed aggregates over the ledgers whose INSERTS and DELETES are the user's act of
// resolving something the digest claimed — logging the dose it called missed, recording
// the workout it said was due, dismissing the item it listed. Those are the changes that
// have to reach the chat PROMPTLY, and the stamp catches every one of them on the very
// next tick, exactly as before.
//
// It deliberately does NOT try to be a complete change-data-capture over everything the
// digest can read. An in-place UPDATE of a row it does not window (an edited activity
// title, a renamed item, a changed preference) moves no counter here, and there is no
// per-row version column in this schema to key on. That hole is closed by the FLOOR, not
// by pretending the stamp is total: `DIGEST_REGATHER_FLOOR_MS` forces a full rebuild
// regardless of the stamp once one is old enough, so the stamp can only ever make a
// correction FASTER — never lose one. The worst case is a correction that lands within
// the floor instead of within the hour, against a cost that drops from every tick to at
// most one gather per floor window.
//
// That division is the honest one to keep in mind when adding to the list: an entry
// makes its domain PROMPT, and forgetting one costs latency, never correctness.
//
// ONE DOMAIN IS DELIBERATELY ABSENT. The daily check-in's store is store-PRIVATE by the
// #992 contract — no flag, retest, streak or import engine may name that table, and a
// dependency stamp is no more entitled to than any of them. The check-in therefore
// reconciles on the floor rather than on the stamp, which is exactly the trade this
// design is built to make: latency, never a claim left standing.

import { db, today } from "../db";
import { shiftDateStr } from "../date";
import { createHash } from "node:crypto";

// How far back the stamp's windows reach. The digest reads today and yesterday for
// adherence and a two-week trailing window for sleep/steps context, so anything older
// than this cannot move a claim it makes today, and windowing is what keeps every
// aggregate here an indexed lookup over tens of rows rather than a table scan.
export const DIGEST_DEP_WINDOW_DAYS = 14;

// The floor the stamp may not push past (#2069). Hourly ticks, so this is "rebuild on
// the stamp, and in any case every third tick". It is what makes the curated list above
// safe to be incomplete.
export const DIGEST_REGATHER_FLOOR_MS = 3 * 60 * 60 * 1000;

interface DigestDependency {
  // The ledger this entry watches, for the stamp's own labelling.
  table: string;
  // The aggregate expression that becomes this entry's contribution to the stamp.
  select: string;
  // Its FROM/WHERE, bound with (profileId, since). Profile-scoped like every other
  // statement in lib/ — directly where the table carries `profile_id`, and through its
  // parent where it does not (the child-table convention).
  from: string;
  // Which digest claim this makes prompt.
  why: string;
}

const DIGEST_DEPENDENCIES: readonly DigestDependency[] = [
  {
    table: "intake_item_logs",
    select: `COUNT(*) || ':' || COALESCE(MAX(l.id), 0)`,
    from: `FROM intake_item_logs l
            JOIN intake_items i ON i.id = l.item_id
           WHERE i.profile_id = ? AND l.date >= ?`,
    why: "The adherence fraction and the named missed item — the digest's sharpest claim, and the one the owner's question was about. A take, a skip and an undo all move it.",
  },
  {
    table: "activities",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM activities
           WHERE profile_id = ? AND date >= ?`,
    why: "The Activities section, the workout preview's rest/train decision, and yesterday's workout-day dueness.",
  },
  {
    table: "practice_logs",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM practice_logs
           WHERE profile_id = ? AND date >= ?`,
    why: "A practice logged in the app clears the shortfall the Today section lists.",
  },
  {
    table: "food_log_events",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM food_log_events
           WHERE profile_id = ? AND date >= ?`,
    why: "The append-only twin of food_log: every serving logged is an event row, so the counter moves even though food_log itself upserts in place.",
  },
  {
    table: "symptom_logs",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM symptom_logs
           WHERE profile_id = ? AND date >= ?`,
    why: "Symptom entries drive the illness/recent-changes lines.",
  },
  {
    table: "body_metrics",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM body_metrics
           WHERE profile_id = ? AND date >= ?`,
    why: "A weight logged after the digest went out changes the body line it carries.",
  },
  {
    table: "metric_samples",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM metric_samples
           WHERE profile_id = ? AND date >= ?`,
    why: "Sleep, steps and light exposure arrive here from the hourly integration sync — the digest's most common mid-day change that the USER did not make.",
  },
  {
    table: "medical_records",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM medical_records
           WHERE profile_id = ? AND created_at >= ?`,
    why: "Newly flagged results. Windowed on ARRIVAL (created_at) rather than collection date, because that is what the digest's 'new since last digest' cursor keys on.",
  },
  {
    table: "medical_documents",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM medical_documents
           WHERE profile_id = ? AND uploaded_at >= ?`,
    why: "The new-documents section, whose per-document footprint loop is one of the three costs this pre-check exists to stop paying every tick.",
  },
  {
    table: "upcoming_dismissals",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM upcoming_dismissals
           WHERE profile_id = ? AND created_at >= ?`,
    why: "A dismissal or snooze on the Upcoming page silences a line the digest is still listing (#1108) — the one case where the resolving act writes NO domain row at all.",
  },
  {
    table: "preventive_events",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM preventive_events
           WHERE profile_id = ? AND created_at >= ?`,
    why: "Marking a screening done removes it from the Today section.",
  },
  {
    table: "appointments",
    select: `COUNT(*) || ':' || COALESCE(MAX(id), 0)`,
    from: `FROM appointments
           WHERE profile_id = ? AND created_at >= ?`,
    why: "A visit booked today can appear in the same day's Today section.",
  },
  {
    table: "illness_episodes",
    select: `COUNT(*) || ':' || COALESCE(MAX(COALESCE(ended_at, started_at)), '')`,
    from: `FROM illness_episodes
           WHERE profile_id = ? AND COALESCE(ended_at, started_at, '') >= ?`,
    why: "The episode headline. Closing an episode is an in-place UPDATE, so this one aggregates the LIFECYCLE timestamps rather than the row count — the shape any future entry whose resolving act is an update should copy.",
  },
];

// The whole stamp in ONE statement: a UNION ALL of the aggregates above, bound
// (profileId, since) per entry. Built once, lazily, so the prepared statement is
// compiled at most once per process.
type Prepared = ReturnType<typeof db.prepare>;

let stampStmt: Prepared | null = null;

// The whole stamp as one statement, composed from the declaration above. Exported so the
// DB tier can assert what the profile-scoping scan cannot read off a statement it did
// not find as a literal: that every arm is profile-scoped and every arm actually runs.
export function digestStampSql(): string {
  return DIGEST_DEPENDENCIES.map(
    (d) => `SELECT '${d.table}' AS t, ${d.select} AS s ${d.from}`
  ).join("\n UNION ALL\n");
}

function statement(): Prepared {
  return (stampStmt ??= db.prepare(digestStampSql()));
}

// A short fingerprint of the digest's watched ledgers for one profile. Cheap by
// construction: every aggregate is an indexed lookup over a bounded date window.
export function digestDependencyStamp(profileId: number): string {
  const since = shiftDateStr(today(profileId), -DIGEST_DEP_WINDOW_DAYS);
  const params: (number | string)[] = [];
  for (const _ of DIGEST_DEPENDENCIES) params.push(profileId, since);
  const rows = statement().all(params) as { t: string; s: string }[];
  // Read back in DECLARED order rather than result order: the fingerprint must not
  // depend on how SQLite happened to lay out the UNION.
  const by = new Map(rows.map((r) => [r.t, r.s]));
  return createHash("sha256")
    .update(
      DIGEST_DEPENDENCIES.map((d) => `${d.table}=${by.get(d.table) ?? ""}`).join(
        "\n"
      )
    )
    .digest("hex")
    .slice(0, 32);
}

// Exposed for the DB tier's coverage assertion, which reads the declared list rather
// than a copy of it.
export { DIGEST_DEPENDENCIES };
