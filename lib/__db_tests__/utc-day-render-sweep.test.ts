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
import { seedActor } from "@/lib/__action_tests__/harness";

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
