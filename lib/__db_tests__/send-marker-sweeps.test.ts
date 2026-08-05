// DB INTEGRATION TIER (#448) — the send-marker registry's RETENTION claims, against the
// real settings tiers (issue #2036).
//
// The registry states, per namespace, what sweeps a marker once its subject is gone. A
// claim like that is only worth something if something checks it, and the check has to
// be at this tier: the sweeps are DB writes across two settings tiers (profile_settings
// and the global settings table), and the pure registry guard can only see the prose.
//
// So each test here writes a marker exactly as production mints it (through the declared
// key builder), runs the sweep the registry NAMES, and asserts the key is gone — and
// asserts along the way that every key it wrote resolves back to its own registry entry,
// which is what ties the census to the behaviour.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getProfileSetting,
  setProfileSetting,
  getSetting,
  setSetting,
  deleteSetting,
} from "@/lib/settings";
import { sendMarkerEntryFor } from "@/lib/notifications/send-markers";
import {
  intakeItemDoseIds,
  sweepIntakeItemMarkers,
} from "@/lib/intake-marker-cleanup";
import { refillMarkerKey, poolRefillMarkerKey } from "@/lib/refill-nudge";
import { escalationMarkerKey } from "@/lib/notifications/escalation-keys";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function itemWithDoses(profileId: number, name: string, doses: number): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'daily', 'must', 10, 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  for (let i = 0; i < doses; i++)
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 tablet', 'morning', 'any', ?)`
    ).run(itemId, i);
  return itemId;
}

describe("send-marker retention: the intake-item sweep (#203/#328/#2036)", () => {
  it("clears the refill marker and EVERY dose's escalation marker on delete", () => {
    const p = newProfile("marker sweep");
    const itemId = itemWithDoses(p, "Fictional tablet", 3);
    const doseIds = intakeItemDoseIds(p, itemId);
    expect(doseIds).toHaveLength(3);

    const keys = [
      refillMarkerKey(itemId),
      ...doseIds.map((d) => escalationMarkerKey(d)),
    ];
    for (const key of keys) {
      // Every key production mints must be a key the registry knows about.
      expect(sendMarkerEntryFor(key), key).not.toBeNull();
      setProfileSetting(p, key, "2026-03-04");
    }

    // The registry names this function as the sweep for both namespaces.
    sweepIntakeItemMarkers(p, itemId, doseIds);

    for (const key of keys)
      expect(getProfileSetting(p, key), key).toBeUndefined();
  });

  it("is a no-op for an item that never had markers", () => {
    // The sweep runs on every delete, including the overwhelming majority that never
    // triggered a nudge; it must not throw or write.
    const p = newProfile("marker sweep empty");
    const itemId = itemWithDoses(p, "Fictional capsule", 1);
    expect(() =>
      sweepIntakeItemMarkers(p, itemId, intakeItemDoseIds(p, itemId))
    ).not.toThrow();
    expect(getProfileSetting(p, refillMarkerKey(itemId))).toBeUndefined();
  });

  it("never reaches another profile's marker for the same id space", () => {
    // Markers are profile-tier, and the sweep is profile-scoped. Two profiles can hold
    // markers for different items whose ids happen to be near neighbours; clearing one
    // must not touch the other.
    const a = newProfile("marker sweep a");
    const b = newProfile("marker sweep b");
    const itemA = itemWithDoses(a, "Fictional A", 1);
    const itemB = itemWithDoses(b, "Fictional B", 1);
    setProfileSetting(a, refillMarkerKey(itemA), "2026-03-04");
    setProfileSetting(b, refillMarkerKey(itemB), "2026-03-04");

    sweepIntakeItemMarkers(a, itemA, intakeItemDoseIds(a, itemA));

    expect(getProfileSetting(a, refillMarkerKey(itemA))).toBeUndefined();
    expect(getProfileSetting(b, refillMarkerKey(itemB))).toBe("2026-03-04");
  });
});

describe("send-marker retention: the pool marker's tier (#1374/#2036)", () => {
  it("lives in the GLOBAL settings tier, not on any profile", () => {
    // The registry declares `store: "settings"` for this namespace, and the reason is
    // load-bearing: a per-profile marker would let one shared bottle re-nudge once per
    // linked member, which is the exact thing the pool exists to prevent.
    const p = newProfile("pool marker tier");
    const key = poolRefillMarkerKey(4242);
    expect(sendMarkerEntryFor(key)?.store).toBe("settings");

    setSetting(key, "2026-03-04");
    expect(getSetting(key)).toBe("2026-03-04");
    expect(getProfileSetting(p, key)).toBeUndefined();

    // The eager clear the registry names (the pool delete seam).
    deleteSetting(key);
    expect(getSetting(key)).toBeUndefined();
  });
});
