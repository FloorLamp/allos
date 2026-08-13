// DB INTEGRATION TIER (#2543) — the DIGEST half of #2386, end to end.
//
// #2386 asked that a fatigued finding "stop appearing in the digest's routine set".
// #2538 shipped the dashboard half and left the digest half, on the reading that no
// digest line has a family to accumulate against. That reading is wrong, and this file
// is where it is disproved against the real store rather than in prose: the
// records-recency ask is keyed `records-recency:<source>:<frontier>`, which is exactly
// the `<topic stem>:<episode anchor>` shape the mechanism needs, and the frontier only
// moves when the source actually delivered something newer — so two stored keys under
// one source are two genuinely separate staleness episodes, both declined.
//
// What only this tier can prove:
//
//   • the ask really does reach the digest's Today section, and really does leave it
//     once its topic has been declined across separate raisings;
//   • it stays on `collectUpcoming` — the pull surface — while it is gone from the send,
//     which is the difference between "quieted" and "silenced" and the whole reason this
//     is a permissible unilateral reduction;
//   • a digest line with NO declared family is untouched however many keys sit in the
//     store, so the mechanism cannot reach the care tier by accident.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries";
import { dismissFinding } from "@/lib/queries/upcoming/suppressions";
import { clinicalRecencyItems } from "@/lib/queries/upcoming/records-recency";
import {
  clinicalRecencyHorizonDays,
  recordsRecencyDedupeKey,
  recordsRecencyFamily,
} from "@/lib/records-recency";
import { QUIET_AFTER_DISMISSED_RAISINGS } from "@/lib/dismissal-fatigue";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import type { BandGroup } from "@/lib/upcoming";

const MANUAL_SOURCE = "clinical-records";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function labResult(profileId: number, collectedOn: string, name: string): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name)
     VALUES (?, ?, 'lab', ?, '82', 82, 'ng/mL', ?)`
  ).run(profileId, collectedOn, name, name);
}

// A profile whose newest lab COLLECTION date is well past the horizon the preventive
// catalog implies, so the manual-upload ask (#2176) is live.
function staleRecordsProfile(tag: string): {
  profileId: number;
  today: string;
  frontier: string;
} {
  const profileId = makeProfile(`Fatigue ${tag}`);
  const t = today(profileId);
  const frontier = shiftDateStr(t, -(clinicalRecencyHorizonDays(null) + 40));
  labResult(profileId, frontier, "Ferritin");
  return { profileId, today: t, frontier };
}

function digestKeys(profileId: number): string[] {
  const groups: BandGroup[] = gatherDigestInput(
    profileId,
    "Fatigue"
  ).todayGroups;
  return groups.flatMap((g) => g.items.map((i) => i.key));
}

describe("the digest drops a topic declined across separate raisings (#2543)", () => {
  it("carries the records-recency ask before anything has been declined", () => {
    const f = staleRecordsProfile("carries");
    const key = recordsRecencyDedupeKey(MANUAL_SOURCE, f.frontier);
    expect(clinicalRecencyItems(f.profileId, f.today)[0].key).toBe(key);
    expect(digestKeys(f.profileId)).toContain(key);
  });

  it("declares the topic stem, and it is a strict prefix of the key", () => {
    const f = staleRecordsProfile("declares");
    const item = clinicalRecencyItems(f.profileId, f.today)[0];
    const family = recordsRecencyFamily(MANUAL_SOURCE);
    expect(item.episodeFamily).toBe(family);
    expect(item.key.startsWith(`${family}:`)).toBe(true);
  });

  it("leaves the digest after two declined raisings, and stays on Upcoming", () => {
    const f = staleRecordsProfile("quiets");
    const key = recordsRecencyDedupeKey(MANUAL_SOURCE, f.frontier);

    // Two EARLIER staleness episodes of the same source, each declined at the time.
    // Separate frontiers, so separate keys — the store's unique (profile, signal_key)
    // makes these two raisings rather than two taps on one.
    for (let n = 0; n < QUIET_AFTER_DISMISSED_RAISINGS; n++) {
      dismissFinding(
        f.profileId,
        recordsRecencyDedupeKey(
          MANUAL_SOURCE,
          shiftDateStr(f.frontier, -(365 * (n + 1)))
        )
      );
    }

    // Gone from the SEND…
    expect(digestKeys(f.profileId)).not.toContain(key);
    // …and still on the surface the user opens, undismissed and unchanged. This is the
    // line between a §2 reduction the system may make on its own and a silence it may
    // not: nothing was written, and the ask is exactly where it was.
    expect(
      collectUpcoming(f.profileId, f.today).some((i) => i.key === key)
    ).toBe(true);
    expect(clinicalRecencyItems(f.profileId, f.today)[0].key).toBe(key);
  });

  it("one declined raising is not enough — a single decline stays a per-appearance mute", () => {
    const f = staleRecordsProfile("one");
    dismissFinding(
      f.profileId,
      recordsRecencyDedupeKey(MANUAL_SOURCE, shiftDateStr(f.frontier, -365))
    );
    expect(digestKeys(f.profileId)).toContain(
      recordsRecencyDedupeKey(MANUAL_SOURCE, f.frontier)
    );
  });

  it("does not reach a line that declares no family, however many keys are stored", () => {
    // A dose is the case that must never move: `dose:<id>` names its SUBJECT, so one key
    // is all there can ever be and the count cannot reach the threshold — and the dose
    // reminder is safety-ungated besides, refused before any count is read.
    const f = staleRecordsProfile("unanchored");
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, obligation, active)
           VALUES (?, 'Fixture Med', 'medication', 'must', 1)`
        )
        .run(f.profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day)
       VALUES (?, '1 tablet', '08:00')`
    ).run(itemId);

    const doseKeys = () =>
      collectUpcoming(f.profileId, f.today)
        .filter((i) => i.domain === "dose")
        .map((i) => i.key);
    const before = doseKeys();
    expect(before.length).toBeGreaterThan(0);
    for (const k of before) expect(digestKeys(f.profileId)).toContain(k);

    // Ten dismissals under the dose namespace. None of them is a raising of anything,
    // because the dose item declares no family.
    for (let n = 0; n < 10; n++)
      dismissFinding(f.profileId, `dose:${itemId}:episode-${n}`);
    for (const k of before) expect(digestKeys(f.profileId)).toContain(k);
  });
});
