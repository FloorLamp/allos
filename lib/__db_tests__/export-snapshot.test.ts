// DB INTEGRATION TIER — full-account export SNAPSHOT (issue #135, item 1).
//
// The /api/export/full streamer now reads every dataset + the FHIR passport input +
// the medical-file list in ONE SQLite read transaction (collectExportSnapshot) so a
// concurrent write can't tear the archive between stream pulls. This exercises that
// collector against a seeded profile: it must (a) cover exactly the DATASETS set,
// (b) agree row-for-row with the direct dataset queries, (c) stay scoped to the
// asked profile, and (d) close its transaction (leave the handle usable).

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { DATASETS, getDataset } from "@/lib/export";
import { collectExportSnapshot } from "@/lib/export-full";
import { seedProfile, type SeededProfile } from "./fixtures";

let a: SeededProfile;
let b: SeededProfile;

beforeAll(() => {
  a = seedProfile("SNAPA");
  b = seedProfile("SNAPB");
});

describe("collectExportSnapshot (issue #135 item 1)", () => {
  it("covers exactly the DATASETS set, in order", () => {
    const snap = collectExportSnapshot(a.profileId, "Snap A");
    expect(snap.datasets.map((d) => d.key)).toEqual(DATASETS.map((d) => d.key));
    for (const d of snap.datasets) {
      const decl = getDataset(d.key)!;
      expect(d.columns).toEqual(decl.columns);
    }
  });

  it("agrees row-for-row with the direct dataset queries", () => {
    const snap = collectExportSnapshot(a.profileId, "Snap A");
    for (const d of snap.datasets) {
      expect(d.rows).toEqual(getDataset(d.key)!.rows(a.profileId));
    }
  });

  it("carries the FHIR passport input and the file list", () => {
    const snap = collectExportSnapshot(a.profileId, "Snap A Display");
    // profile.name falls back to the passed display name when no full_name is set.
    expect(snap.fhirInput.profile?.name).toBe("Snap A Display");
    expect(Array.isArray(snap.fhirInput.observations)).toBe(true);
    expect(Array.isArray(snap.files)).toBe(true);
  });

  it("is scoped to the asked profile (no cross-profile bleed)", () => {
    const snapA = collectExportSnapshot(a.profileId, "Snap A");
    const supplements = snapA.datasets.find((d) => d.key === "supplements")!;
    expect(supplements.rows.length).toBeGreaterThan(0);
    // Every seeded item name is tag-prefixed, so a leak would surface SNAPB rows.
    expect(
      supplements.rows.every((r) => String(r.name).startsWith(a.tag))
    ).toBe(true);
    expect(supplements.rows.some((r) => String(r.name).startsWith(b.tag))).toBe(
      false
    );
  });

  it("closes its read transaction (the handle stays usable afterward)", () => {
    collectExportSnapshot(a.profileId, "Snap A");
    expect(db.inTransaction).toBe(false);
    // A follow-up write succeeds — the snapshot didn't leave a txn open.
    expect(() =>
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("SNAP-AFTER")
    ).not.toThrow();
  });
});
