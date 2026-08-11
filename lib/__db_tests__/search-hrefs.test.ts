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
    // Deliberately old: the training log renders one newest window (#451), so an
    // anchor-into-the-training log href would strand exactly this row.
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

  it("a cycling activity hit lands on its dedicated ride detail", () => {
    const p = newProfile("palette-ride");
    const id = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, duration_min, components)
           VALUES (?, '2019-03-15', 'cardio', 'PHREF River Loop', 50, ?)`
        )
        .run(p, JSON.stringify([{ name: "Cycling", type: "cardio" }]))
        .lastInsertRowid
    );

    expect(hit(p, "PHREF River", "activity", "PHREF River Loop").href).toBe(
      `/training/rides/${id}`
    );
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

  // #1595 extended the fan-out with nine entity domains, so the same rule has nine
  // more chances to be broken. Every one of those domains that HAS a per-record
  // route must use it — a hit landing on the owning hub instead is the #1568 bug
  // wearing a new domain, and typed routes cannot catch it.
  it("every added domain with a detail route deep-links it, never its hub", () => {
    const p = newProfile("palette-entity-domains");
    const providerId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key)
           VALUES ('PHREF Larkspur Clinic', 'organization', 'phref-larkspur')`
        )
        .run().lastInsertRowid
    );
    // The registry is global; a provider is searchable through this profile's own
    // record links, so the hit needs one.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, provider_id)
       VALUES (?, '2026-04-01', 'PHREF Larkspur visit', ?)`
    ).run(p, providerId);
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, start_date)
           VALUES (?, 'PHREF Larkspur cold', '2026-04-02')`
        )
        .run(p).lastInsertRowid
    );
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols (profile_id, name, start_date)
           VALUES (?, 'PHREF Larkspur block', '2026-04-03')`
        )
        .run(p).lastInsertRowid
    );
    const equipmentId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name, category)
           VALUES (?, 'PHREF Larkspur bar', 'Barbell')`
        )
        .run(p).lastInsertRowid
    );

    expect(
      hit(p, "PHREF Larkspur Clinic", "provider", "PHREF Larkspur Clinic").href
    ).toBe(`/providers/${providerId}`);
    expect(
      hit(p, "PHREF Larkspur cold", "episode", "PHREF Larkspur cold").href
    ).toBe(`/medical/episodes/${episodeId}`);
    expect(
      hit(p, "PHREF Larkspur block", "protocol", "PHREF Larkspur block").href
    ).toBe(`/protocols/${protocolId}`);
    expect(
      hit(p, "PHREF Larkspur bar", "equipment", "PHREF Larkspur bar").href
    ).toBe(`/equipment/${equipmentId}`);

    // And none of them settled for the surface's hub/index.
    const hrefs = searchAll(p, "PHREF Larkspur")
      .filter((g) => g.domain !== "page")
      .flatMap((g) => g.hits.map((h) => h.href));
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    for (const hub of ["/providers", "/medical/episodes", "/equipment"]) {
      expect(hrefs).not.toContain(hub);
    }
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
