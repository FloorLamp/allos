// DB INTEGRATION TIER — the grounded record Q&A retrieval seam (issue #878, Phase 2).
//
// retrieveRecordCitations turns a natural-language question into a capped, numbered
// citation set for the ACTIVE profile, reusing the profile-scoped search fan-out. This
// tier proves the load-bearing invariants the pure tier can't see: (1) it retrieves the
// asking profile's OWN rows (a medication + a visit found from the question's terms),
// (2) it NEVER leaks another profile's rows into the set (the active-profile-only scope
// the issue requires + tests), and (3) an empty/stopword-only question yields no
// citations (the deterministic refusal upstream). Synthetic values only (no PHI).

import { describe, it, expect, beforeAll } from "vitest";
import { retrieveRecordCitations } from "@/lib/queries";
import { db } from "@/lib/db";

let mine: number;
let other: number;

beforeAll(() => {
  mine = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('QA-MINE')").run()
      .lastInsertRowid
  );
  other = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('QA-OTHER')").run()
      .lastInsertRowid
  );

  // My records: a medication whose notes name it an antibiotics course, and a visit.
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, active, notes)
     VALUES (?, 'Amoxicillin', 'medication', 1, 'Antibiotics course for a sinus infection')`
  ).run(mine);
  db.prepare(
    `INSERT INTO encounters (profile_id, date, type, reason)
     VALUES (?, '2026-03-04', 'Urgent care', 'Sinus infection — prescribed antibiotics')`
  ).run(mine);

  // Another profile's antibiotics medication — must NEVER reach my citations.
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, active, notes)
     VALUES (?, 'Cephalexin', 'medication', 1, 'Antibiotics for a skin infection')`
  ).run(other);
});

describe("retrieveRecordCitations — grounded, profile-scoped retrieval (#878)", () => {
  it("retrieves the asking profile's own matching rows for a natural-language question", () => {
    const cites = retrieveRecordCitations(
      mine,
      "when did I last take antibiotics?"
    );
    const titles = cites.map((c) => c.title);
    expect(titles).toContain("Amoxicillin");
    // Each citation carries a numbered index and a real link.
    expect(cites[0].index).toBe(1);
    expect(cites.every((c) => typeof c.href === "string" && c.href)).toBe(true);
  });

  it("NEVER leaks another profile's rows into the answer (active-profile-only scope)", () => {
    const cites = retrieveRecordCitations(
      mine,
      "when did I last take antibiotics?"
    );
    expect(cites.map((c) => c.title)).not.toContain("Cephalexin");

    // And the other profile only sees ITS own antibiotics med, not mine.
    const theirs = retrieveRecordCitations(other, "antibiotics");
    expect(theirs.map((c) => c.title)).toContain("Cephalexin");
    expect(theirs.map((c) => c.title)).not.toContain("Amoxicillin");
  });

  it("returns no citations for a stopword-only question (upstream refusal)", () => {
    expect(retrieveRecordCitations(mine, "when did I last take it?")).toEqual(
      []
    );
  });

  it("returns no citations when nothing matches", () => {
    expect(
      retrieveRecordCitations(mine, "chemotherapy radiation dialysis")
    ).toEqual([]);
  });
});
