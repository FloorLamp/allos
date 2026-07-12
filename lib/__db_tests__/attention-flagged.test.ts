// The unified attention model against a real schema (issues #283, #524). Pins the
// query-layer behaviors the pure tier can't see:
//   1. the flagged-biomarker window is the model's OWN stable trailing window —
//      sending a Telegram digest (which advances notify_digest_last_at) must not
//      change the model's items, while the digest's own read DOES advance;
//   2. flagged items go through the shared findings bus (`biomarker-flag:<name>`
//      dismiss/snooze/restore), and repeat flags of one analyte collapse to one
//      canonical-named item;
//   3. the card is a strict SUBSET of the page: a far-future (`later`-band) item
//      lives on the page (and the full model) but is EXCLUDED from the card subset
//      and the household count; a flagged reading lands on BOTH surfaces; and the
//      counts reconcile over one fixture.
// All fixture values are synthetic (obviously-fictional profiles, plain lab
// names) — no real PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  collectAttentionModel,
  collectSuppressedAttention,
  attentionCountForProfile,
} from "@/lib/queries/attention";
import {
  collectUpcoming,
  dismissFinding,
  restoreFinding,
} from "@/lib/queries/upcoming";
import {
  attentionCardItems,
  groupAttentionForPage,
  moreInUpcomingCount,
} from "@/lib/attention";
import {
  digestSince,
  getNewlyFlaggedBiomarkers,
} from "@/lib/notifications/digest-data";
import { getCurrentFlaggedBiomarkers } from "@/lib/queries/medical";
import { setProfileSetting } from "@/lib/settings";

function createProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The datetime('now')-format window start N days ago — the same shape the hero's
// stable window (FLAGGED_ATTENTION_WINDOW_DAYS) passes into getNewlyFlaggedBiomarkers.
function flaggedSince(days: number): string {
  return (
    db.prepare("SELECT datetime('now', ?) AS s").get(`-${days} days`) as {
      s: string;
    }
  ).s;
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

describe("model flagged-biomarker window (issue #283)", () => {
  it("sending a digest does not change the model's items (stable window, not the send cursor)", () => {
    const pid = createProfile("Attention Test A");
    const td = today(pid);
    insertFlagged(pid, { name: "Glucose", canonical: "Glucose" });

    const before = collectAttentionModel(pid, td).filter(
      (i) => i.domain === "biomarker-flag"
    );
    expect(before.map((i) => i.key)).toEqual(["biomarker-flag:glucose"]);

    // Simulate a delivered digest: runDigest advances notify_digest_last_at to
    // now, which under the OLD coupling emptied the model immediately.
    const now = (
      db.prepare("SELECT datetime('now') AS n").get() as { n: string }
    ).n;
    setProfileSetting(pid, "notify_digest_last_at", now);

    const after = collectAttentionModel(pid, td).filter(
      (i) => i.domain === "biomarker-flag"
    );
    expect(after).toEqual(before);

    // …while the digest's OWN read did advance past the already-reported flag.
    expect(getNewlyFlaggedBiomarkers(pid, digestSince(pid))).toEqual([]);
  });

  it("flags older than the stable window drop off the model", () => {
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
      collectAttentionModel(pid, td).filter(
        (i) => i.domain === "biomarker-flag"
      )
    ).toEqual([]);
  });

  it("repeat flags of one analyte collapse to ONE canonical-named ACTION item (#524/#526)", () => {
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

    const flagged = collectAttentionModel(pid, td).filter(
      (i) => i.domain === "biomarker-flag"
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].key).toBe("biomarker-flag:ldl cholesterol");
    // The action verb + series deep-link (the #526 fix), not a bare analyte name.
    expect(flagged[0].title).toBe("Review LDL Cholesterol");
    expect(flagged[0].href).toBe("/biomarkers/view?name=LDL%20Cholesterol");
    expect(flagged[0].suppressible).toBe(true);
  });

  it("a findings-bus dismissal hides a flagged item everywhere; restore (via the page's suppressed list) brings it back", () => {
    const pid = createProfile("Attention Test D");
    const td = today(pid);
    insertFlagged(pid, { name: "Glucose", canonical: "Glucose" });

    const key = "biomarker-flag:glucose";
    dismissFinding(pid, key);
    expect(collectAttentionModel(pid, td).some((i) => i.key === key)).toBe(
      false
    );
    // The dismissed flag is now restorable from the Upcoming page's "Snoozed &
    // dismissed" list (issue #524 — a flag dismissed on either surface stays
    // restorable, not a dead end).
    expect(
      collectSuppressedAttention(pid, td).some((s) => s.signalKey === key)
    ).toBe(true);

    restoreFinding(pid, key);
    expect(collectAttentionModel(pid, td).some((i) => i.key === key)).toBe(
      true
    );
  });
});

describe("current-reading filter (issue #557)", () => {
  it("a superseded historical out-of-range reading (old low, current normal) is NOT flagged", () => {
    const pid = createProfile("Attention Test G");
    const td = today(pid);
    // A 5-year-old out-of-range Vitamin D, since replaced by a normal reading.
    insertFlagged(pid, {
      name: "Vitamin D",
      canonical: "Vitamin D",
      value: "18",
      flag: "low",
      createdAtModifier: "-1800 days",
      date: shiftDateStr(td, -1800),
    });
    // The current reading is normal (flag NULL) — collected today, imported today.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
       VALUES (?, ?, 'lab', 'Vitamin D', '45', 'ng/mL', 'Vitamin D', NULL, datetime('now'))`
    ).run(pid, td);

    // Neither the digest/hero read nor the unified model surfaces it: the current
    // reading is fine, so the analyte is not currently flagged.
    expect(getNewlyFlaggedBiomarkers(pid, flaggedSince(14))).toEqual([]);
    expect(
      collectAttentionModel(pid, td).filter(
        (i) => i.domain === "biomarker-flag"
      )
    ).toEqual([]);
  });

  it("an analyte whose LATEST reading is out-of-range still IS flagged", () => {
    const pid = createProfile("Attention Test H");
    const td = today(pid);
    // An older normal reading, superseded by a current out-of-range one.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
       VALUES (?, ?, 'lab', 'Ferritin', '90', 'ng/mL', 'Ferritin', NULL, datetime('now','-40 days'))`
    ).run(pid, shiftDateStr(td, -40));
    insertFlagged(pid, {
      name: "Ferritin",
      canonical: "Ferritin",
      value: "12",
      flag: "low",
    });

    const flagged = getNewlyFlaggedBiomarkers(pid, flaggedSince(14));
    expect(flagged.map((f) => f.name)).toEqual(["Ferritin"]);
    expect(flagged[0].flag).toBe("low");
    expect(
      collectAttentionModel(pid, td)
        .filter((i) => i.domain === "biomarker-flag")
        .map((i) => i.key)
    ).toEqual(["biomarker-flag:ferritin"]);
  });

  it("a bulk backfill of old flagged labs (created_at now, collection date years ago) does NOT light the window", () => {
    const pid = createProfile("Attention Test I");
    const td = today(pid);
    // Simulate a history import: every row stamped created_at = today (import
    // time), but the actual collection dates are years in the past. These ARE the
    // current readings for their analytes (no newer reading exists), so the
    // current-filter alone wouldn't exclude them — only the collection-date window
    // does (issue #557 fix 2).
    for (const [name, yearsAgo] of [
      ["Cholesterol", 3],
      ["Triglycerides", 4],
      ["ALT", 5],
    ] as const) {
      db.prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
         VALUES (?, ?, 'lab', ?, '999', 'mg/dL', ?, 'high', datetime('now'))`
      ).run(pid, shiftDateStr(td, -365 * yearsAgo), name, name);
    }

    // Freshly imported (created_at today) but old by collection — the digest/hero
    // window must not fire on them.
    expect(getNewlyFlaggedBiomarkers(pid, flaggedSince(14))).toEqual([]);
    expect(
      collectAttentionModel(pid, td).filter(
        (i) => i.domain === "biomarker-flag"
      )
    ).toEqual([]);

    // But they DO remain currently-flagged when read without a recency window —
    // the passport/household surfaces (getCurrentFlaggedBiomarkers, no `since`)
    // still see them, so the fix narrows only the "newly flagged" window, not the
    // whole current-flagged set.
    expect(
      getCurrentFlaggedBiomarkers(pid)
        .map((r) => r.name)
        .sort()
    ).toEqual(["ALT", "Cholesterol", "Triglycerides"]);
  });
});

describe("card ⊂ page — the strict subset invariant (issue #524)", () => {
  it("a far-future appointment is on the page/model but EXCLUDED from the card subset and the household count", () => {
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

    // On the Upcoming due-signal collector AND the full model (the page shows it)…
    expect(collectUpcoming(pid, td).map((i) => i.key)).toContain(
      `appointment:${apptId}`
    );
    const model = collectAttentionModel(pid, td);
    expect(model.map((i) => i.key)).toContain(`appointment:${apptId}`);
    // …but NOT on the card's act-now subset.
    const card = attentionCardItems(model, td);
    expect(card.map((i) => i.key)).not.toContain(`appointment:${apptId}`);
    // The household badge is the card subset count — it can't count the far-future item.
    expect(attentionCountForProfile(pid, td)).toBe(card.length);
  });

  it("card + page agree end-to-end over ONE fixture: flagged HDL on BOTH surfaces, counts reconcile", () => {
    const pid = createProfile("Attention Test F");
    const td = today(pid);

    // One fixture: a recent flagged HDL (act-now signal), an overdue appointment
    // (act-now scheduled), and a far-future appointment (page-only planning item).
    insertFlagged(pid, {
      name: "HDL Cholesterol",
      canonical: "HDL Cholesterol",
      value: "35",
      flag: "low",
    });
    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, title, status)
       VALUES (?, ?, 'Overdue follow-up', 'scheduled')`
    ).run(pid, `${shiftDateStr(td, -3)} 09:00`);
    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, title, status)
       VALUES (?, ?, 'Annual physical', 'scheduled')`
    ).run(pid, `${shiftDateStr(td, 40)} 09:00`);

    const model = collectAttentionModel(pid, td);
    const card = attentionCardItems(model, td);
    const modelKeys = new Set(model.map((i) => i.key));
    const flagKey = "biomarker-flag:hdl cholesterol";

    // The flagged HDL is on the PAGE (its own "Flagged" group) AND the CARD
    // ("Needs review") — same analyte, one item, both surfaces (the #524 defect
    // was it appearing only on the card).
    const pageGroups = groupAttentionForPage(model, td);
    const flaggedGroup = pageGroups.find((g) => g.kind === "flagged");
    expect(flaggedGroup?.items.map((i) => i.key)).toContain(flagKey);
    expect(card.map((i) => i.key)).toContain(flagKey);

    // Strict subset: every card key is a page key.
    for (const item of card) expect(modelKeys.has(item.key)).toBe(true);

    // Counts reconcile: the card count plus "+N more in Upcoming" equals the page
    // total, and the far-future physical is exactly the hidden item.
    const more = moreInUpcomingCount(model, card.length);
    expect(card.length + more).toBe(model.length);
    expect(card.map((i) => i.key)).not.toContain(`appointment`);
    // The overdue follow-up IS on the card (Urgent); the far-future physical is NOT.
    const cardTitles = card.map((i) => i.title);
    expect(cardTitles).toContain("Overdue follow-up");
    expect(cardTitles).not.toContain("Annual physical");
  });
});
