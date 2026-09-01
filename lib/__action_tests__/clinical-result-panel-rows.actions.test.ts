// SERVER-ACTION TIER — the expand-a-panel loader (issue #1651).
//
// The Clinical results index ships a BOUNDED payload: a collapsed panel group arrives
// with no rows, so expanding one asks the server for that panel's results. This
// tier pins the action's contract at the request boundary — it resolves its own
// scope, returns ONE panel's rows out of the SAME filtered set the page would have
// rendered (derived indices included), honors the URL filters it is replayed with,
// and refuses a panel slug that isn't in the closed taxonomy. Auth is mocked
// (harness), the DB is real.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { loadClinicalResultPanelRows } from "@/app/(app)/results/actions";
import { PANEL_ROW_LIMIT } from "@/lib/biomarker-panel-groups";
import { seedActor, createLogin, createProfile, actAs } from "./harness";

const DRAW = "2024-05-01";

function seedLab(
  profileId: number,
  name: string,
  value: number,
  date = DRAW
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'lab', ?, ?, 'mg/dL', ?, ?)`
  ).run(profileId, date, name, String(value), name, value);
}

// A lipid panel plus one analyte from another panel, so "only this panel" is
// observable.
function seedTwoPanels(profileId: number): void {
  seedLab(profileId, "Total Cholesterol", 205);
  seedLab(profileId, "LDL Cholesterol", 128);
  seedLab(profileId, "HDL Cholesterol", 47);
  seedLab(profileId, "Thyroxine, Free (Free T4)", 1.3);
}

function namesOf(res: Awaited<ReturnType<typeof loadClinicalResultPanelRows>>) {
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  return res.rows.map((r) => r.canonical_name ?? r.name);
}

describe("loadClinicalResultPanelRows", () => {
  it("returns bounded, stable pages and clamps past the panel end", async () => {
    const { profile } = seedActor();
    for (let day = 1; day <= PANEL_ROW_LIMIT + 2; day += 1)
      seedLab(
        profile.id,
        "Total Cholesterol",
        180 + day,
        `2024-05-${String(day).padStart(2, "0")}`
      );
    const [first, second, pastEnd] = await Promise.all(
      [1, 2, 99].map((page) =>
        loadClinicalResultPanelRows({
          panel: "lipids",
          searchParams: {},
          page,
        })
      )
    );
    if (!first.ok || !second.ok || !pastEnd.ok)
      throw new Error("expected every page to load");
    expect([first.page, first.limit, first.total, first.rows.length]).toEqual([
      1,
      PANEL_ROW_LIMIT,
      PANEL_ROW_LIMIT + 2,
      PANEL_ROW_LIMIT,
    ]);

    expect([second.page, second.rows.map((row) => row.date)]).toEqual([
      2,
      ["2024-05-02", "2024-05-01"],
    ]);
    expect(pastEnd.page).toBe(2);
  });

  it("returns one panel's stored and derived results", async () => {
    const { profile } = seedActor();
    seedTwoPanels(profile.id);

    const names = namesOf(
      await loadClinicalResultPanelRows({ panel: "lipids", searchParams: {} })
    );
    expect(names).toContain("Total Cholesterol");
    expect(names).toContain("HDL Cholesterol");
    // The derived indices are part of the panel the header counted, so an expansion
    // that omitted them would show fewer analytes than the header promised.
    expect(names).toContain("Non-HDL Cholesterol");
    expect(names).toContain("Cholesterol/HDL Ratio");
    // The thyroid analyte belongs to another group, which pays for its own rows.
    // Named by its canonical spelling (#2335) so it really does resolve to `thyroid`
    // — a name that resolves to no panel at all would pass this assertion for the
    // wrong reason.
    expect(names).not.toContain("Thyroxine, Free (Free T4)");
  });

  it("applies the URL filters it is replayed with", async () => {
    const { profile } = seedActor();
    seedTwoPanels(profile.id);
    seedLab(profile.id, "Total Cholesterol", 190, "2023-05-01");

    // Two draws of total cholesterol, and `current=1` keeps only the newest.
    const all = namesOf(
      await loadClinicalResultPanelRows({ panel: "lipids", searchParams: {} })
    ).filter((n) => n === "Total Cholesterol");
    expect(all).toHaveLength(2);

    const currentOnly = await loadClinicalResultPanelRows({
      panel: "lipids",
      searchParams: { current: "1" },
    });
    expect(
      namesOf(currentOnly).filter((n) => n === "Total Cholesterol")
    ).toHaveLength(1);

    // A free-text search narrows the same way the page's own gather does.
    const searched = namesOf(
      await loadClinicalResultPanelRows({
        panel: "lipids",
        searchParams: { q: "HDL Cholesterol" },
      })
    );
    expect(searched).toContain("HDL Cholesterol");
    expect(searched).not.toContain("Total Cholesterol");
  });

  it("refuses a panel outside the closed taxonomy", async () => {
    const { profile } = seedActor();
    seedTwoPanels(profile.id);

    const res = await loadClinicalResultPanelRows({
      panel: "Quest Diagnostics",
      searchParams: {},
    });
    expect(res).toEqual({ ok: false, error: "Unknown panel." });
  });

  it("returns only the acting scope's results", async () => {
    const login = createLogin();
    const acting = createProfile("Acting", login.id);
    actAs(login, acting);
    seedLab(acting.id, "Total Cholesterol", 205);

    // Another login's profile, which this session cannot reach.
    const stranger = createLogin();
    const strangerProfile = createProfile("Stranger", stranger.id);
    seedLab(strangerProfile.id, "Total Cholesterol", 111);

    expect(
      namesOf(
        await loadClinicalResultPanelRows({
          panel: "lipids",
          searchParams: {},
        })
      )
    ).toEqual(["Total Cholesterol"]);
  });
});
