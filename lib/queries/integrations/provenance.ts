// SYNC PROVENANCE — one of the three submodules behind lib/queries/integrations.ts
// (issue #5171): how many provenance rows each sync event recorded, the captured
// raw-payload ref for one event, and the per-row "what this wrote" drill-in resolved
// to typed deep links. Every read is profile-scoped, through the parent event where
// the child table has no profile_id of its own.

import { db } from "@/lib/db";
import { getTimezone } from "@/lib/settings";
import type { ProvenanceTable } from "@/lib/integrations/sync-log";
import { dateFromCreatedAt } from "@/lib/timeline-format";
import {
  historyDayHref,
  clinicalResultDetailHref,
  importHref,
  type AppRoute,
} from "@/lib/hrefs";

// How many provenance rows each of a source's recent sync events RECORDED (#1771,
// counted rather than merely detected in #1991). The "What this wrote" drill-in
// promises record-level detail, so it may only be offered for an event that has some,
// and it must promise exactly as many as it will list — whether an event has any, and
// how many, is a fact about
// the EVENT, not about the source: Weather legitimately records none (it writes
// cells of the global location-keyed forecast cache, which name no user record —
// #1212's scoping decision), and genuine pre-#1333 legacy events of the other
// sources have none either. Both used to render an expander that apologized 100%
// of the time.
//
// One indexed seek per source rather than a per-event existence check: sync-event
// ids are monotonic, so the events being rendered are exactly those at or above the
// oldest id in the rendered set, and `integration_sync_rows` is keyed on event_id.
// PROFILE-SCOPED through the parent event (the child-table convention — the table has
// no own profile_id).
export function provenanceCountsByEvent(
  profileId: number,
  sourceId: string,
  minEventId: number
): Record<number, number> {
  const rows = db
    .prepare(
      `SELECT r.event_id AS event_id, COUNT(*) AS n
         FROM integration_sync_rows r
         JOIN integration_sync_events e ON e.id = r.event_id
        WHERE e.profile_id = ? AND e.source_id = ? AND r.event_id >= ?
        GROUP BY r.event_id`
    )
    .all(profileId, sourceId, minEventId) as {
    event_id: number;
    n: number;
  }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.event_id] = r.n;
  return out;
}

// The captured raw-payload ref for one sync event, scoped to the profile — powers
// the admin-only raw viewer route (app/api/integrations/raw/[id]). Profile-scoped
// (id AND profile_id) so one profile can never resolve another's payload by id;
// the route additionally requires the acting login to be an admin.
export function getSyncEventRawRef(
  profileId: number,
  id: number
): string | null {
  const row = db
    .prepare(
      `SELECT raw_ref FROM integration_sync_events
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as { raw_ref: string | null } | undefined;
  return row?.raw_ref ?? null;
}

// ---- Per-row sync provenance drill-in (issue #1333) -------------------------

// One record a sync inserted/updated, resolved to a human label + a typed deep link
// to the surface that owns it (#285). `deleted` marks a target that no longer resolves
// (the record was later removed) — its link still points at the day/list, but the label
// says so. `date` is the record's own date, used to build the timeline-day link.
export interface SyncRowLink {
  id: number;
  targetTable: ProvenanceTable;
  targetId: number;
  disposition: "inserted" | "updated";
  date: string | null;
  label: string;
  href: AppRoute;
  deleted: boolean;
}

// The records a single sync event wrote, newest-persisted first, each resolved to a
// deep link. PROFILE-SCOPED at both ends: the event must belong to `profileId` (the
// join naming e.profile_id), and every target lookup filters the owned table by
// profile_id too, so one profile can never resolve another's records by id. Legacy
// events (before #1333) have no provenance rows and return []; the caller then shows
// the pre-existing inert window text. Only inserted/updated rows were ever recorded
// (the volume cap — see recordSyncRows), so this never lists an unchanged re-send.
export function getSyncRowProvenance(
  profileId: number,
  eventId: number
): SyncRowLink[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.target_table, r.target_id, r.disposition
         FROM integration_sync_rows r
         JOIN integration_sync_events e ON e.id = r.event_id
        WHERE r.event_id = ? AND e.profile_id = ?
        ORDER BY r.id`
    )
    .all(eventId, profileId) as {
    id: number;
    target_table: ProvenanceTable;
    target_id: number;
    disposition: "inserted" | "updated";
  }[];

  // Per-table, profile-scoped resolvers (literal SQL so the profile-scoping guard can
  // read the profile_id filter directly). Each returns the record's date + a label, or
  // undefined when the row was since deleted.
  const findActivity = db.prepare(
    "SELECT date, title, type FROM activities WHERE id = ? AND profile_id = ?"
  );
  const findBody = db.prepare(
    "SELECT date FROM body_metrics WHERE id = ? AND profile_id = ?"
  );
  const findSample = db.prepare(
    "SELECT date, metric FROM metric_samples WHERE id = ? AND profile_id = ?"
  );
  const findRecord = db.prepare(
    "SELECT date, name, canonical_name FROM medical_records WHERE id = ? AND profile_id = ?"
  );
  const findPractice = db.prepare(
    "SELECT date, practice FROM practice_logs WHERE id = ? AND profile_id = ?"
  );
  // A DELIVERED DOCUMENT (#2999) — the one target that is not a record. Its date is the
  // document's own clinical date when it has one, falling back to when it arrived, and
  // its link is the import page that already shows what the document produced. Same
  // literal profile_id filter as its five siblings.
  const findDocument = db.prepare(
    "SELECT document_date, uploaded_at, filename FROM medical_documents WHERE id = ? AND profile_id = ?"
  );

  const timeZone = getTimezone(profileId);
  const out: SyncRowLink[] = [];
  for (const r of rows) {
    let date: string | null = null;
    let label = "";
    let href: AppRoute = historyDayHref(""); // replaced below
    let deleted = false;
    if (r.target_table === "activities") {
      const rec = findActivity.get(r.target_id, profileId) as
        { date: string; title: string | null; type: string | null } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = rec?.title || rec?.type || "Activity";
      href = date ? historyDayHref(date) : historyDayHref("");
    } else if (r.target_table === "body_metrics") {
      const rec = findBody.get(r.target_id, profileId) as
        { date: string } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = "Body metrics";
      href = date ? historyDayHref(date) : historyDayHref("");
    } else if (r.target_table === "metric_samples") {
      const rec = findSample.get(r.target_id, profileId) as
        { date: string; metric: string } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = rec?.metric ?? "Metric";
      href = date ? historyDayHref(date) : historyDayHref("");
    } else if (r.target_table === "medical_records") {
      // medical_records → the reading's OWN detail surface (#1932): the metric
      // detail page for a continuous vital, the reference-range page for a lab,
      // the list without a canonical name. The helper owns that choice.
      const rec = findRecord.get(r.target_id, profileId) as
        | { date: string; name: string | null; canonical_name: string | null }
        | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      // Canonical FIRST (#1501): the label and the href below must name the same
      // identity — the link already commits to the canonical analyte, so a raw-first
      // label reads "URIC ACID" on a row that opens "Uric Acid".
      label = rec?.canonical_name?.trim() || rec?.name || "Lab result";
      href = clinicalResultDetailHref(
        rec?.canonical_name ?? null,
        rec?.name ?? null
      );
    } else if (r.target_table === "medical_documents") {
      const rec = findDocument.get(r.target_id, profileId) as
        | {
            document_date: string | null;
            uploaded_at: string;
            filename: string;
          }
        | undefined;
      deleted = !rec;
      // `document_date` IS a day; `uploaded_at` is an INSTANT and the fallback used to
      // take its first ten characters — the UTC day, which is not this profile's for
      // part of every day (#3836). The Review row prints the result as a date.
      date = rec
        ? (rec.document_date ??
          dateFromCreatedAt(rec.uploaded_at, timeZone) ??
          rec.uploaded_at.slice(0, 10))
        : null;
      label = rec?.filename || "Document";
      href = importHref(r.target_id);
    } else {
      const rec = findPractice.get(r.target_id, profileId) as
        { date: string; practice: string } | undefined;
      deleted = !rec;
      date = rec?.date ?? null;
      label = rec?.practice || "Wellness practice";
      href = date ? historyDayHref(date) : historyDayHref("");
    }
    out.push({
      id: r.id,
      targetTable: r.target_table,
      targetId: r.target_id,
      disposition: r.disposition,
      date,
      label,
      href,
      deleted,
    });
  }
  return out;
}
