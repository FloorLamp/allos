// DB INTEGRATION TIER — the two reads in this sweep (#3573) that resolve a
// profile-local day themselves, rather than being handed one.
//
// THE DEFECT, once, because both sites had the identical shape: a stored INSTANT was
// turned into a rendered calendar DAY by taking its first ten characters. Those ten
// characters are the UTC day. For a profile east or west of UTC they are the wrong day
// for part of every day — and on a health record the wrong day is not cosmetic. The
// project rule is explicit: preserve the distinction between an instant and a
// profile-local day.
//
// WHY THE FIXTURES LOOK LIKE THIS. Every stamp below STRADDLES: it is chosen so the
// UTC day and the profile's local day genuinely differ. A stamp at local midday agrees
// with UTC in every zone, so a fixture built that way is green against the bug — which
// is exactly how these eight sites survived a tree that already had the conversion.
// Both directions are covered because a fixed-sign mistake (adding the offset where it
// should be subtracted) passes one and fails the other: Pacific/Auckland is UTC+12/+13
// and America/Los_Angeles is UTC−7/−8.
//
// The two sites resolve the zone rather than taking it as a parameter because both
// already hold the profile id — the repo idiom for a DB-touching module. The three
// remaining surfaces in #3573 convert in a server page (no profile-less lib layer to
// hold the conversion); their proof is the narrowed prop types, which no longer let an
// instant reach the component at all.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import {
  listDocumentTombstones,
  writeDocumentTombstone,
} from "@/lib/document-tombstones";
import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  identitySyncStatuses,
} from "@/lib/portals";
import { deliveredDocumentCountsByAccount } from "@/lib/portal-visibility";
import { portalLoginStatus } from "@/lib/portal-status";
import { revisionSummary } from "@/lib/lab-result-lifecycle";
import { getObservationRevisions } from "@/lib/queries/medical";
import { getSyncRowProvenance } from "@/lib/queries/integrations";
import { searchAll } from "@/lib/queries/search";
import { getProfileSummary } from "@/lib/profile-summary-load";
import {
  recordSyncEvent,
  recordSyncRows,
} from "@/lib/integrations/connections";
import { seedActor } from "@/lib/__action_tests__/harness";
import { testAuthorizedIds } from "../__tests__/authorized-ids";

// zone, an instant, and the calendar day that instant falls on THERE. 22:30Z has
// already tipped into the next day in Auckland; 02:30Z has not yet reached the stated
// day in Los Angeles. Neither equals the UTC day, which is what makes them proofs.
const STRADDLING = [
  ["Pacific/Auckland", "2026-03-04 22:30:00", "2026-03-05"],
  ["America/Los_Angeles", "2026-03-04 02:30:00", "2026-03-03"],
] as const;

// The UTC day both fixtures share, and therefore the answer the truncation gave. Both
// sites returned exactly this on origin/main, in both zones — off by one in opposite
// directions, which is the whole reason a single-zone fixture cannot see the defect.
const UTC_DAY = "2026-03-04";

// The straddle is a PROPERTY OF THE FIXTURE, so it is checked rather than asserted in
// prose above: if someone later "tidies" a stamp to midday, this fires instead of the
// test quietly going green against the bug it exists for.
it.each(STRADDLING)(
  "%s: %s is the UTC day %s, not the local one",
  (_tz, at) => {
    expect(at.slice(0, 10)).toBe(UTC_DAY);
  }
);

describe("a blocked document's 'Deleted' day is the profile's (#3573)", () => {
  it.each(STRADDLING)("%s stamps %s as %s", (tz, at, day) => {
    const { profile } = seedActor();
    setTimezone(profile.id, tz);
    const hash = `doc hash sweep ${day}`;
    writeDocumentTombstone(profile.id, hash, "labs.pdf");
    // The store writes through a column DEFAULT, so the instant is set here — this is
    // about which calendar reads it, not about which clock wrote it.
    db.prepare(
      `UPDATE import_tombstones SET created_at = ?
        WHERE profile_id = ? AND natural_key = ?`
    ).run(at, profile.id, hash);

    const listed = listDocumentTombstones(profile.id).find(
      (t) => t.contentHash === hash
    )!;
    expect(listed.deletedOnDay).toBe(day);
    expect(listed.deletedOnDay).not.toBe(UTC_DAY);
  });
});

describe("a portal patient's 'Last synced' day is the bound profile's (#3573)", () => {
  it.each(STRADDLING)("%s stamps %s as %s", (tz, at, day) => {
    const { profile } = seedActor();
    setTimezone(profile.id, tz);
    const portal = createPortal(`Clinic ${day}`);
    // A portal is born with its implicit default login; that is the account here.
    const account = accountsForPortal(portal.ok ? portal.id : 0)[0];
    const label = "Dana Wang";
    expect(bindPortalIdentity(account.id, label, profile.id).ok).toBe(true);
    // One ok run and one failed run on the same instant: the row states both days, and
    // a conversion applied to only one of them would pass a single-field assertion.
    for (const ok of [1, 0]) {
      db.prepare(
        `INSERT INTO integration_sync_events
           (profile_id, source_id, at, ok, account_id, patient_label)
         VALUES (?, 'patient-portals', ?, ?, ?, ?)`
      ).run(profile.id, at, ok, account.id, label);
    }

    const status = identitySyncStatuses(profile.id, "patient-portals").find(
      (s) => s.accountId === account.id
    )!;
    expect(status.lastSyncedOnDay).toBe(day);
    expect(status.lastFailedOnDay).toBe(day);
    expect(status.lastSyncedOnDay).not.toBe(UTC_DAY);
  });
});

// ── #3836: the same defect, at the read models #3573's table did not list ─────
//
// Identical shape, identical fixtures — deliberately the same STRADDLING table above,
// because it is one question and a second table would be a second answer to it. Each
// assertion below names one site; the zones are the axis. All of them returned UTC_DAY
// on origin/main, in both zones.
//
// Three sites the issue listed are NOT here, because auditing them found nothing to
// fix, and the reasons are worth keeping:
//   * SessionHeartRateChart's tooltip stamp is a profile-LOCAL wall clock
//     (SessionHeartRatePoint.date, "YYYY-MM-DDTHH:MM" — lib/training-zones.ts), so its
//     first ten characters ARE the local day. Converting it would have introduced the
//     bug, and broken its `date === activityDate` comparison against a day column.
//   * intake-cadence's `unrecordedScheduleChangeOn` and warnings' dose-change day are
//     never rendered — they are compared against `effective_from` / `today`. That is
//     arithmetic, which #3573's own conditional sends to #3572 (the ruling #3835 made
//     for lib/sync-requests.ts).
//   * illness-timeline-view's three slices sit over `encounters.date`,
//     `medication_courses.started_on` and `COALESCE(document_date, date(uploaded_at))`,
//     all declared DAY columns in docs/internals/time-columns.md. Nothing to convert.

describe("the read models #3836 converted", () => {
  it.each(STRADDLING)("%s reads %s as %s", (tz, at, day) => {
    const { profile } = seedActor();
    setTimezone(profile.id, tz);

    // A lab supersession: "Superseded — was 5.4 mmol/L (<day>)" under a clinical result.
    const recordId = Number(
      db
        .prepare(
          `INSERT INTO medical_records (profile_id, date, category, name, value, unit)
           VALUES (?, '2026-03-01', 'lab', 'Potassium', '5.4', 'mmol/L')`
        )
        .run(profile.id).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medical_record_revisions
         (record_id, date, value, value_num, unit, superseded_by_status, superseded_at)
       VALUES (?, '2026-03-01', '5.4', 5.4, 'mmol/L', 'corrected', ?)`
    ).run(recordId, at);
    const revision = getObservationRevisions(profile.id, recordId)[0];
    expect(revision.supersededOnDay).toBe(day);
    expect(revisionSummary(revision)).toBe(
      `Corrected — was 5.4 mmol/L (${day})`
    );

    // A document with no clinical date: both the search-hit subtitle and the Review row
    // fall back to `uploaded_at`, which is an instant.
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (filename, stored_path, mime_type, size_bytes, extraction_status,
              uploaded_at, profile_id)
           VALUES (?, '', 'application/pdf', 20, 'done', ?, ?)`
        )
        .run(`sweep-labs-${day}.pdf`, at, profile.id).lastInsertRowid
    );
    const hit = searchAll(profile.id, "sweep-labs")
      .flatMap((g) => g.hits)
      .find((h) => h.key === `document:${docId}`)!;
    expect(hit.date).toBe(day);

    const eventId = recordSyncEvent(profile.id, "patient-portals", {
      ok: true,
      received: 1,
      written: 1,
      inserted: 1,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    })!;
    recordSyncRows(eventId, [
      {
        target_table: "medical_documents",
        target_id: docId,
        disposition: "inserted",
      },
    ]);
    expect(getSyncRowProvenance(profile.id, eventId)[0].date).toBe(day);

    // The passport's two intake rows: a supplement has no modeled start date and a
    // medication with no course on file has none either, so both date from created_at.
    for (const [name, kind] of [
      ["Sweep Magnesium", "supplement"],
      ["Sweep Lisinopril", "medication"],
    ] as const) {
      db.prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, created_at)
         VALUES (?, ?, 1, ?, 'daily', 'should', ?)`
      ).run(profile.id, name, kind, at);
    }
    const summary = getProfileSummary(profile.id, "Sweep");
    expect(summary.supplements[0].date).toBe(day);
    expect(summary.medications[0].date).toBe(day);

    // Every one of them, and none of them the UTC day.
    expect([
      revision.supersededOnDay,
      hit.date,
      summary.supplements[0].date,
      summary.medications[0].date,
    ]).not.toContain(UTC_DAY);
  });
});

// THE MIXED-GRAIN COMPARISON #3835 CREATED AND FLAGGED (#3836). `delivered.day` was
// grouped UTC-side in SQL while the check clock beside it became local, so
// `checked < on` in portalLoginStatus compared across grains and could flip near UTC
// midnight. Both halves are now the same calendar's, which is what this asserts: the
// SENTENCE, not just the field, because the sentence is where the two meet.
describe("a delivery-only login row states one calendar's days", () => {
  it.each(STRADDLING)("%s reads %s as %s", (tz, at, day) => {
    const { profile } = seedActor();
    const portal = createPortal(`Sweep Clinic ${day}`);
    expect(portal.ok).toBe(true);
    const account = accountsForPortal(portal.ok ? portal.id : 0)[0];
    const label = "Robin Sweep";
    expect(bindPortalIdentity(account.id, label, profile.id).ok).toBe(true);
    const identityId = (
      db
        .prepare(
          "SELECT id FROM portal_identities WHERE account_id = ? AND patient_label = ?"
        )
        .get(account.id, label) as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO medical_documents
         (filename, stored_path, mime_type, size_bytes, extraction_status,
          uploaded_at, delivered_at, profile_id, acquired_identity_id)
       VALUES (?, '', 'application/xml', 20, 'done', ?, ?, ?, ?)`
    ).run(`sweep-bundle-${day}.xml`, at, at, profile.id, identityId);

    const delivered = deliveredDocumentCountsByAccount(
      testAuthorizedIds([profile.id]),
      false,
      tz
    ).get(account.id);
    expect(delivered).toEqual({ count: 1, day });

    // The check clock is the SAME instant two days earlier, so its local day is
    // `day - 2` in either zone and the "portal last checked" suffix must appear. That
    // suffix is emitted only when `checked < on`, which is the comparison that used to
    // straddle two grains — so the sentence is the assertion, not the field.
    const checkedDay = shiftDateStr(day, -2);
    const line = portalLoginStatus(
      {
        at,
        ok: true,
        message: null,
        contacted: false,
        checkedAt: `${shiftDateStr(at.slice(0, 10), -2)}${at.slice(10)}`,
        delivered,
      },
      tz
    );
    expect(line.text).toBe(
      `Delivered 1 document ${day} · portal last checked ${checkedDay}`
    );
  });
});
