// DB INTEGRATION TIER — what an offline snapshot is allowed to put at rest on a device
// (#2908, review finding R4).
//
// The offline read snapshots are the largest device-local PHI surface this app has: they
// are readable at /offline with NO SESSION, by whoever is holding the unlocked phone.
// The rule the builders follow is therefore narrower than "what does the query return" —
// A FIELD EARNS ITS PLACE IN THE PAYLOAD BY BEING ON THE SCREEN.
//
// `buildMedicationListData` was the one builder that did not project. It reused
// `buildMedicationList`, which answers a "bring your medication list to an appointment"
// artifact, so `prescriber` — a named third party, someone's cardiologist — plus
// `startedOn` and `rx` were stored on the device and rendered by nothing.
// `buildDoseSchedule` carried `time` the same way: read by the sort key, printed nowhere.
//
// Both were projected, and nothing pinned the projection — the whole snapshot-build
// module had no DB-tier test, so a later editor spreading one more field would put a
// prescriber back on every device and no gate would notice. These assert the EXACT key
// set, so widening the payload is a decision someone has to make on purpose.
//
// Runs via `npm run test:db` (vitest.db.config.ts); the `db` singleton is a throwaway
// per-file temp DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { buildSnapshot, snapshotContext } from "@/lib/offline/snapshot-build";

// A named third party, low-entropy per the fixture rules, and deliberately distinctive
// so the whole-payload check below can look for it as a string.
const PRESCRIBER = "Doctor Nakamura Cardiology";

function seedProfileWithMedication(): number {
  const profileId = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run("Offline Projection").lastInsertRowid
  );
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            rx, prescriber, brand, product)
         VALUES (?, ?, 1, 'medication', 'daily', 'must', 1, ?, ?, ?)`
      )
      .run(profileId, "Sertraline", PRESCRIBER, "Zoloft", "tablet")
      .lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '50 mg', 'morning', 'any', 0)`
  ).run(itemId);
  return profileId;
}

function payloadRows(profileId: number, kind: "medication-list"): unknown[];
function payloadRows(profileId: number, kind: "dose-schedule"): unknown[];
function payloadRows(profileId: number, kind: string): unknown[] {
  const snap = buildSnapshot(
    kind as "medication-list",
    snapshotContext(profileId, 1),
    new Date("2026-08-16T12:00:00Z")
  );
  const data = snap.data as { rows?: unknown[]; entries?: unknown[] };
  return data.rows ?? data.entries ?? [];
}

describe("an offline snapshot stores only what /offline renders (#2908 R4)", () => {
  it("medication-list carries no prescriber, startedOn or rx", () => {
    const profileId = seedProfileWithMedication();
    const rows = payloadRows(profileId, "medication-list") as Record<
      string,
      unknown
    >[];

    // The fixture really did produce a row — an empty list would satisfy every
    // assertion below without proving anything.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Sertraline");

    // The EXACT set the offline card reads (OfflineSnapshotView renders name, subtitle,
    // dose and schedule; id is the React key). Adding a field here is a deliberate act.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "dose",
      "id",
      "name",
      "schedule",
      "subtitle",
    ]);
  });

  it("the prescriber's name is nowhere in the payload that reaches the device", () => {
    // Stated over the whole serialized snapshot rather than one row's keys, because
    // that is the actual risk: not "is the field named prescriber" but "can a named
    // third party be read off this phone".
    const profileId = seedProfileWithMedication();
    const snap = buildSnapshot(
      "medication-list",
      snapshotContext(profileId, 1),
      new Date("2026-08-16T12:00:00Z")
    );
    expect(JSON.stringify(snap)).not.toContain("Nakamura");
  });

  it("dose-schedule carries no wall-clock time, which it sorts by and never shows", () => {
    const profileId = seedProfileWithMedication();
    const entries = payloadRows(profileId, "dose-schedule") as Record<
      string,
      unknown
    >[];

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(Object.keys(entry)).not.toContain("time");
    }
  });
});
