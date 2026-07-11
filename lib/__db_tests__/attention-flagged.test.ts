// Issue #283 — the "Needs attention" hero against a real schema. Pins the three
// query-layer behaviors the pure tier can't see:
//   1. the flagged-biomarker window is the hero's OWN stable trailing window —
//      sending a Telegram digest (which advances notify_digest_last_at) must not
//      change the hero's items, while the digest's own read DOES advance;
//   2. flagged items go through the shared findings bus (`biomarker-flag:<name>`
//      dismiss/snooze/restore), and repeat flags of one analyte collapse to one
//      canonical-named item;
//   3. far-future (`later`-band) Upcoming items stay on the Upcoming page but are
//      excluded from the hero and the household attention count.
// All fixture values are synthetic (obviously-fictional profiles, plain lab
// names) — no real PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  collectAttention,
  attentionCountForProfile,
} from "@/lib/queries/attention";
import {
  collectUpcoming,
  dismissFinding,
  restoreFinding,
} from "@/lib/queries/upcoming";
import {
  digestSince,
  getNewlyFlaggedBiomarkers,
} from "@/lib/notifications/digest-data";
import { setProfileSetting } from "@/lib/settings";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A flagged lab reading. `createdAtModifier` is a SQLite datetime modifier
// relative to now (e.g. '-20 days') so window tests are deterministic.
function insertFlagged(
  profileId: number,
  opts: {
    name: string;
    canonical?: string | null;
    value?: string;
    flag?: string;
    createdAtModifier?: string;
    date?: string;
  }
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
     VALUES (?, ?, 'lab', ?, ?, 'mg/dL', ?, ?, datetime('now', ?))`
  ).run(
    profileId,
    opts.date ?? today(profileId),
    opts.name,
    opts.value ?? "130",
    opts.canonical ?? null,
    opts.flag ?? "high",
    opts.createdAtModifier ?? "+0 seconds"
  );
}

describe("hero flagged-biomarker window (issue #283)", () => {
  it("sending a digest does not change the hero's items (stable window, not the send cursor)", () => {
    const pid = createProfile("Attention Test A");
    const td = today(pid);
    insertFlagged(pid, { name: "Glucose", canonical: "Glucose" });

    const before = collectAttention(pid, td).filter(
      (i) => i.domain === "biomarker-flag"
    );
    expect(before.map((i) => i.key)).toEqual(["biomarker-flag:glucose"]);

    // Simulate a delivered digest: runDigest advances notify_digest_last_at to
    // now, which under the OLD coupling emptied the hero immediately.
    const now = (
      db.prepare("SELECT datetime('now') AS n").get() as { n: string }
    ).n;
    setProfileSetting(pid, "notify_digest_last_at", now);

    const after = collectAttention(pid, td).filter(
      (i) => i.domain === "biomarker-flag"
    );
    expect(after).toEqual(before);

    // …while the digest's OWN read did advance past the already-reported flag.
    expect(getNewlyFlaggedBiomarkers(pid, digestSince(pid))).toEqual([]);
  });

  it("flags older than the stable window drop off the hero", () => {
    const pid = createProfile("Attention Test B");
    const td = today(pid);
    insertFlagged(pid, {
      name: "Ferritin",
      canonical: "Ferritin",
      flag: "low",
      createdAtModifier: "-20 days",
      date: shiftDateStr(td, -20),
    });
    expect(
      collectAttention(pid, td).filter((i) => i.domain === "biomarker-flag")
    ).toEqual([]);
  });

  it("repeat flags of one analyte collapse to ONE canonical-named item with a series deep link", () => {
    const pid = createProfile("Attention Test C");
    const td = today(pid);
    // Two flagged readings whose RAW names differ but snap to one canonical name
    // — exactly what canonical-snapping produces on import.
    insertFlagged(pid, {
      name: "LDL-C",
      canonical: "LDL Cholesterol",
      value: "160",
    });
    insertFlagged(pid, {
      name: "LDL Chol (calc)",
      canonical: "LDL Cholesterol",
      value: "155",
      createdAtModifier: "-1 day",
      date: shiftDateStr(td, -1),
    });

    const flagged = collectAttention(pid, td).filter(
      (i) => i.domain === "biomarker-flag"
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].key).toBe("biomarker-flag:ldl cholesterol");
    expect(flagged[0].title).toBe("LDL Cholesterol");
    // Canonicalized → deep-links to the series the view page can resolve.
    expect(flagged[0].href).toBe("/biomarkers/view?name=LDL%20Cholesterol");
    expect(flagged[0].suppressible).toBe(true);
  });

  it("a findings-bus dismissal hides a flagged item; restore brings it back", () => {
    const pid = createProfile("Attention Test D");
    const td = today(pid);
    insertFlagged(pid, { name: "Glucose", canonical: "Glucose" });

    const key = "biomarker-flag:glucose";
    dismissFinding(pid, key);
    expect(collectAttention(pid, td).some((i) => i.key === key)).toBe(false);

    restoreFinding(pid, key);
    expect(collectAttention(pid, td).some((i) => i.key === key)).toBe(true);
  });
});

describe("hero later-band exclusion (issue #283)", () => {
  it("a far-future appointment stays on Upcoming but off the hero and the household count", () => {
    const pid = createProfile("Attention Test E");
    const td = today(pid);
    const apptId = Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, scheduled_at, title, status)
           VALUES (?, ?, 'Far-future physical', 'scheduled')`
        )
        .run(pid, `${shiftDateStr(td, 45)} 10:00`).lastInsertRowid
    );

    const upcomingKeys = collectUpcoming(pid, td).map((i) => i.key);
    expect(upcomingKeys).toContain(`appointment:${apptId}`);

    const attention = collectAttention(pid, td);
    expect(attention.map((i) => i.key)).not.toContain(`appointment:${apptId}`);
    // The household badge is the same computation — it can't count it either.
    expect(attentionCountForProfile(pid, td)).toBe(attention.length);
  });
});
