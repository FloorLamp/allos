// DB INTEGRATION TIER — snooze/dismiss filtering in the Upcoming aggregation +
// the "what's due" digest. Seeds two profiles via the shared
// fixture (each gets a pending med dose + a low refill), writes upcoming_dismissals
// rows directly (the actions' write path is covered in the action tier), and proves:
//   - a dismissal hides its item from collectUpcoming and surfaces it in
//     collectSuppressedUpcoming;
//   - an EXPIRED snooze lets the item reappear while a FUTURE snooze hides it;
//   - suppression is profile-scoped (one profile's row never suppresses another's
//     identically-keyed item);
//   - the digest, built from the same collectUpcoming, reflects the suppression.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming, collectSuppressedUpcoming } from "@/lib/queries";
import { groupUpcoming } from "@/lib/upcoming";
import { buildUpcomingDigest } from "@/lib/notifications/upcoming-digest";
import { seedProfile, type SeededProfile } from "./fixtures";

function dismiss(profileId: number, signalKey: string) {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
  ).run(profileId, signalKey);
}
function snooze(profileId: number, signalKey: string, until: string) {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until)
       VALUES (?, ?, ?)`
  ).run(profileId, signalKey, until);
}
function clear(profileId: number) {
  db.prepare("DELETE FROM upcoming_dismissals WHERE profile_id = ?").run(
    profileId
  );
}

let a: SeededProfile;
let b: SeededProfile;
let refillKeyA: string;
let doseKeyA: string;

beforeAll(() => {
  a = seedProfile("SUPA");
  b = seedProfile("SUPB");
  refillKeyA = `refill:${a.supplementId}`;
  const dose = collectUpcoming(a.profileId, a.todayStr).find(
    (i) => i.domain === "dose"
  );
  doseKeyA = dose!.key;
});

describe("dismiss hides an item and lists it as suppressed", () => {
  it("drops the dismissed refill from collectUpcoming, surfaces it in the suppressed set", () => {
    clear(a.profileId);
    // Baseline: the low refill is present.
    expect(
      collectUpcoming(a.profileId, a.todayStr).some((i) => i.key === refillKeyA)
    ).toBe(true);

    dismiss(a.profileId, refillKeyA);
    expect(
      collectUpcoming(a.profileId, a.todayStr).some((i) => i.key === refillKeyA)
    ).toBe(false);

    const suppressed = collectSuppressedUpcoming(a.profileId, a.todayStr);
    const row = suppressed.find((s) => s.signalKey === refillKeyA);
    expect(row).toBeDefined();
    expect(row!.dismissedAt).not.toBeNull();
    expect(row!.snoozeUntil).toBeNull();
    clear(a.profileId);
  });
});

describe("snooze expiry boundary", () => {
  it("hides while snoozed into the future, reappears once expired", () => {
    clear(a.profileId);
    // Future snooze → hidden.
    snooze(a.profileId, doseKeyA, shiftDateStr(a.todayStr, 3));
    expect(
      collectUpcoming(a.profileId, a.todayStr).some((i) => i.key === doseKeyA)
    ).toBe(false);
    clear(a.profileId);

    // Expired snooze (yesterday) → shows again, and is NOT in the suppressed set.
    snooze(a.profileId, doseKeyA, shiftDateStr(a.todayStr, -1));
    expect(
      collectUpcoming(a.profileId, a.todayStr).some((i) => i.key === doseKeyA)
    ).toBe(true);
    expect(
      collectSuppressedUpcoming(a.profileId, a.todayStr).some(
        (s) => s.signalKey === doseKeyA
      )
    ).toBe(false);
    clear(a.profileId);
  });
});

describe("suppression is profile-scoped", () => {
  it("a dismissal on profile B never suppresses profile A's identically-keyed item", () => {
    clear(a.profileId);
    clear(b.profileId);
    // B dismisses a key that identifies one of A's live items; A must be unaffected.
    dismiss(b.profileId, refillKeyA);
    expect(
      collectUpcoming(a.profileId, a.todayStr).some((i) => i.key === refillKeyA)
    ).toBe(true);
    clear(b.profileId);
  });
});

describe("digest reflects suppression", () => {
  it("a dismissed item drops out of the built digest", () => {
    clear(a.profileId);
    const before = buildUpcomingDigest(
      a.tag,
      groupUpcoming(collectUpcoming(a.profileId, a.todayStr), a.todayStr)
    );
    expect(before).not.toBeNull();
    const totalBefore = before!.total;
    expect(totalBefore).toBeGreaterThanOrEqual(2); // dose + refill at least

    dismiss(a.profileId, refillKeyA);
    dismiss(a.profileId, doseKeyA);
    const after = buildUpcomingDigest(
      a.tag,
      groupUpcoming(collectUpcoming(a.profileId, a.todayStr), a.todayStr)
    );
    // Two fewer items than before (the dose + the refill are gone).
    expect(after?.total ?? 0).toBe(totalBefore - 2);
    clear(a.profileId);
  });
});
