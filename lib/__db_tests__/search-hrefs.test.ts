// DB INTEGRATION TIER — command-palette hit DESTINATIONS (#1568).
//
// Four hit builders returned a bare hub route while the row data supported a
// precise one: an activity → `/training`, a goal → `/training`, a medication →
// the medications list, an immunization → the immunizations list. Selecting an
// activity from `/training` — the natural place to be when searching for a
// workout — was therefore a same-route push: the palette closed and nothing
// moved, so the bug read as a dead control rather than a wrong destination.
//
// This is the class typed routes CANNOT catch (#285): `/training` is a live
// pathname, just a stale one for the hit. So the guard is data-level — assert
// each hit's href against the row that produced it.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic
// fixtures only (no PHI).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { searchAll } from "@/lib/queries";
import type { SearchHit } from "@/lib/search-rank";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function hit(
  profileId: number,
  query: string,
  domain: string,
  title: string
): SearchHit {
  const found = searchAll(profileId, query)
    .find((g) => g.domain === domain)
    ?.hits.find((h) => h.title === title);
  if (!found)
    throw new Error(`no ${domain} hit titled ${title} for "${query}"`);
  return found;
}

describe("command-palette hit hrefs deep-link to their target (#1568)", () => {
  it("an activity hit lands on ITS day of the timeline, not the training hub", () => {
    const p = newProfile("palette-activity");
    // Deliberately old: the journal renders one newest window (#451), so an
    // anchor-into-the-journal href would strand exactly this row.
    const date = "2019-03-14";
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'strength', 'PHREF Bench Press', 45)`
    ).run(p, date);

    const h = hit(p, "PHREF Bench", "activity", "PHREF Bench Press");
    expect(h.href).toBe(
      `/timeline?from=${date}&to=${date}#timeline-day-${date}`
    );
    expect(h.href).not.toBe("/training");
  });

  it("a medication hit lands on its detail page; a supplement keeps the kind surface", () => {
    const p = newProfile("palette-intake");
    const medId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active)
           VALUES (?, 'PHREF Testazole', 'medication', 1)`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, kind, active)
       VALUES (?, 'PHREF Testazole Powder', 'supplement', 1)`
    ).run(p);

    expect(
      hit(p, "PHREF Testazole", "supplement", "PHREF Testazole").href
    ).toBe(`/medications/${medId}`);
    // No per-supplement page exists — the kind-level surface (#746) stays right.
    expect(
      hit(p, "PHREF Testazole", "supplement", "PHREF Testazole Powder").href
    ).toBe("/nutrition?tab=supplements");
  });

  it("an immunization hit lands on its per-vaccine page", () => {
    const p = newProfile("palette-immunization");
    db.prepare(
      `INSERT INTO immunizations (profile_id, vaccine, date)
       VALUES (?, 'influenza', '2024-10-02')`
    ).run(p);

    const h = searchAll(p, "Influenza")
      .find((g) => g.domain === "immunization")
      ?.hits.at(0);
    expect(h?.href).toBe("/immunizations/influenza");
  });

  it("a goal hit lands on the Goals tab, not the training hub's default tab", () => {
    const p = newProfile("palette-goal");
    db.prepare(
      `INSERT INTO goals (profile_id, title, metric, target_value, status)
       VALUES (?, 'PHREF Squat 100kg', 'weight', 100, 'active')`
    ).run(p);

    expect(hit(p, "PHREF Squat", "goal", "PHREF Squat 100kg").href).toBe(
      "/training?tab=goals"
    );
  });

  it("no hit for a row-backed domain returns the bare /training hub", () => {
    const p = newProfile("palette-sweep");
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, '2020-01-05', 'cardio', 'PHREF Sweep Run', 30)`
    ).run(p);
    db.prepare(
      `INSERT INTO goals (profile_id, title, metric, target_value, status)
       VALUES (?, 'PHREF Sweep Run 10k', 'distance', 10, 'active')`
    ).run(p);

    const hrefs = searchAll(p, "PHREF Sweep")
      .filter((g) => g.domain === "activity" || g.domain === "goal")
      .flatMap((g) => g.hits.map((h) => h.href));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs).not.toContain("/training");
  });
});
