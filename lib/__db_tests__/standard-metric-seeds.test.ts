// DB INTEGRATION TIER — issue #1487: the standard Overview metric tiles become
// DEFAULT-SAVED `saved_items` rows (the data half), and Overview then renders the
// saved set and nothing else (the rendering half).
//
// The binding test here is the BYTE-IDENTICAL one, and it now spans BOTH halves. The
// promise of #1487 is that day-one appearance does not change: a profile that never
// curated anything sees exactly the tiles, in exactly the order, it saw when the four
// standard tiles were a hardcoded sampler. Seeding alone could satisfy that trivially;
// the flip is where it could break. So the test holds a FROZEN COPY of the pre-#1487
// composition (`legacyOverviewTileKeys` — the unconditional metric sampler plus saved
// biomarkers, split saved-first by the retired `partitionSaved`) and asserts, for every
// curation shape, that the sequence the LIVE membership-driven composition renders
// after seeding equals the sequence the old sampler rendered before it.
//
// The shapes: never curated, stars with no explicit positions, an explicitly ordered
// set, a profile that already saved a standard metric, a positioned/unpositioned mix,
// an age-restricted profile (training volume gated), and an infant (body fat hidden).
// The last two are the saved-ref-with-no-tile case: age gates stay a RENDER-time
// filter, so a gated metric is skipped, never rendered empty.
//
// The second describe covers the migration itself at the 113 standard: it builds a
// genuine pre-114 database, runs up(), and asserts per-profile isolation, dedupe
// against an existing save, existing curation staying ahead of the seeds, and a
// replay that is a pure no-op.
//
// All fixture values are SYNTHETIC (no PHI) — profile names are obviously fictional
// and the analyte names are canonical vocabulary, not patient data.

import Database from "better-sqlite3";
import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { MIGRATIONS } from "@/lib/migrations/versions";
import { up as up114 } from "@/lib/migrations/versions/114-standard-metric-seeds";
import {
  STANDARD_TREND_METRIC_IDS,
  seedStandardMetricSaves,
} from "@/lib/standard-metric-seeds";
import { getSavedItems } from "@/lib/queries/saved";
import {
  metricSeriesKey,
  partitionOverviewTiles,
  savedRefFromSeriesKey,
} from "@/lib/saved-items";
import {
  buildMetricSeries,
  buildSavedBiomarkerTile,
  type TrendSeries,
} from "@/lib/trends-series";
import { isTrainingRestricted, setMinTrainingAge } from "@/lib/age-gate";
import { setProfileSetting } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { defaultTrendsRange } from "@/lib/timeline-format";
import type { DateRange } from "@/lib/timeline-format";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

const SEEDS_MIGRATION = 114;

// ── The Overview composition under test ──────────────────────────────────────
// A faithful replay of app/(app)/trends/OverviewSection.tsx as it stands NOW: one
// tile per saved ref, in saved order, with a saved metric the age gate removed
// simply skipped. This is the membership grid.
function overviewTileKeys(
  profileId: number,
  loginId: number,
  range: DateRange
): string[] {
  const restricted = isTrainingRestricted(profileId);
  const todayStr = today(profileId);
  const metricByKey = new Map(
    buildMetricSeries(profileId, loginId, range, restricted).map((t) => [
      t.key,
      t,
    ])
  );
  const tiles: TrendSeries[] = [];
  for (const ref of getSavedItems(profileId)) {
    if (ref.kind === "trend-metric") {
      const tile = metricByKey.get(metricSeriesKey(ref.key));
      if (tile) tiles.push(tile);
    } else {
      tiles.push(buildSavedBiomarkerTile(profileId, ref.key, range, todayStr));
    }
  }
  return tiles.map((t) => t.key);
}

// ── The composition it replaced (FROZEN — do not "fix") ──────────────────────
// app/(app)/trends/OverviewSection.tsx before #1487: every standard metric series
// rendered unconditionally, saved biomarkers earned a tile, and the two were split
// saved-first by lib/saved-items.ts's `partitionSaved` (retired with the sampler, so
// its ordering logic is reproduced here rather than imported). The RENDERED sequence
// was the saved row followed by the unsaved grid. This is the baseline the flip must
// reproduce; it is a historical artifact and must not be updated to match new
// behavior — that would delete the test's meaning.
function legacyOverviewTileKeys(
  profileId: number,
  loginId: number,
  range: DateRange
): string[] {
  const restricted = isTrainingRestricted(profileId);
  const todayStr = today(profileId);
  const savedRefs = getSavedItems(profileId).map((s) => ({
    kind: s.kind,
    key: s.key,
  }));
  const tiles: TrendSeries[] = [
    ...buildMetricSeries(profileId, loginId, range, restricted),
    ...savedRefs
      .filter((r) => r.kind === "biomarker")
      .map((r) => buildSavedBiomarkerTile(profileId, r.key, range, todayStr)),
  ];
  const refId = (kind: string, key: string) => `${kind}|${key.toLowerCase()}`;
  const byRef = new Map<string, TrendSeries>();
  for (const t of tiles) {
    const ref = savedRefFromSeriesKey(t.key);
    if (ref) byRef.set(refId(ref.kind, ref.key), t);
  }
  const claimed = new Set<TrendSeries>();
  const saved: TrendSeries[] = [];
  for (const ref of savedRefs) {
    const found = byRef.get(refId(ref.kind, ref.key));
    if (found && !claimed.has(found)) {
      claimed.add(found);
      saved.push(found);
    }
  }
  return [...saved, ...tiles.filter((t) => !claimed.has(t))].map((t) => t.key);
}

let seq = 0;
function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}-${seq++}`)
      .lastInsertRowid
  );
}

function star(profileId: number, kind: string, key: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO saved_items (profile_id, kind, key) VALUES (?, ?, ?)`
  ).run(profileId, kind, key);
}

function savedRow(
  profileId: number,
  kind: string,
  key: string
): { position: number | null; created_at: string } {
  const row = db
    .prepare(
      `SELECT position, created_at FROM saved_items
        WHERE profile_id = ? AND kind = ? AND key = ?`
    )
    .get(profileId, kind, key) as
    { position: number | null; created_at: string } | undefined;
  expect(row, `${kind}:${key} should be saved`).toBeDefined();
  return row!;
}

function savedKeys(profileId: number): string[] {
  return getSavedItems(profileId).map((s) => `${s.kind}:${s.key}`);
}

describe("#1487 standard metric seeds — the Overview tile sequence is unchanged", () => {
  // Both a real (90-day default) window and all-time, so a window-dependent tile
  // (the #1485 G sparse fallback) can't hide a difference in one of them.
  const RANGES: [string, DateRange][] = [];
  beforeAll(() => {
    RANGES.push(
      ["all-time", {}],
      ["default 90D", defaultTrendsRange(today(1))]
    );
  });

  // Each case builds a profile in some curation state; the assertion is the same.
  const CASES: [name: string, setup: (profileId: number) => void][] = [
    ["never curated", () => {}],
    [
      "stars with no explicit position",
      (p) => {
        star(p, "biomarker", "LDL Cholesterol");
        star(p, "biomarker", "ApoB");
      },
    ],
    [
      "an explicitly ordered saved set",
      (p) => {
        star(p, "biomarker", "LDL Cholesterol");
        star(p, "biomarker", "ApoB");
        db.prepare(
          `UPDATE saved_items SET position = 0 WHERE profile_id = ? AND key = 'ApoB'`
        ).run(p);
        db.prepare(
          `UPDATE saved_items SET position = 1 WHERE profile_id = ? AND key = 'LDL Cholesterol'`
        ).run(p);
      },
    ],
    [
      "a standard metric the user already saved",
      (p) => {
        star(p, "trend-metric", "weight");
        star(p, "biomarker", "hs-CRP");
      },
    ],
    [
      "a mix of positioned and unpositioned saves",
      (p) => {
        star(p, "trend-metric", "resting_hr");
        star(p, "biomarker", "Lipoprotein(a)");
        star(p, "biomarker", "hs-CRP");
        db.prepare(
          `UPDATE saved_items SET position = 0 WHERE profile_id = ? AND kind = 'trend-metric'`
        ).run(p);
      },
    ],
    [
      "an age-restricted profile (training volume gated)",
      (p) => {
        setMinTrainingAge(18);
        setProfileSetting(p, "birthdate", shiftDateStr(today(p), -365 * 10));
        star(p, "biomarker", "LDL Cholesterol");
      },
    ],
    [
      "an infant profile (body fat hidden)",
      (p) => {
        setProfileSetting(p, "birthdate", shiftDateStr(today(p), -548));
      },
    ],
  ];

  for (const [name, setup] of CASES) {
    it(`renders what the pre-#1487 sampler rendered — ${name}`, () => {
      const p = newProfile("Seed Fixture");
      setup(p);
      try {
        for (const [label, range] of RANGES) {
          // The old grid, on the profile as it was BEFORE seeding: the sampler's
          // unconditional metric tiles plus this profile's own curation.
          const before = legacyOverviewTileKeys(p, 1, range);
          // Seeding is idempotent, so running it inside the range loop is safe and
          // asserts the invariant against the SAME profile at both windows.
          seedStandardMetricSaves(db, p);
          // The new grid: membership only. Same tiles, same order — which is the
          // whole claim of #1487, and the reason the seeds are unpositioned and
          // epoch-stamped (a positioned seed would sort ahead of the user's saves
          // and this assertion would fail).
          const after = overviewTileKeys(p, 1, range);
          expect(after, `${name} @ ${label}`).toEqual(before);
        }
      } finally {
        setMinTrainingAge(null); // global setting — never leak into a sibling case
      }
    });
  }

  it("drops a standard tile when it is unstarred, and restores it when re-starred", () => {
    // The capability the flip unlocks — and the one thing the old grid could not do.
    // A metric tile is removable now; SaveTrendPicker is the way back, which is why
    // it offers metrics as well as biomarkers.
    const p = newProfile("Unstar Metric");
    seedStandardMetricSaves(db, p);
    expect(overviewTileKeys(p, 1, {})).toContain("metric:volume");

    db.prepare(
      `DELETE FROM saved_items WHERE profile_id = ? AND kind = 'trend-metric' AND key = 'volume'`
    ).run(p);
    const without = overviewTileKeys(p, 1, {});
    expect(without).not.toContain("metric:volume");
    // …and only that tile went: unstarring one metric is not a grid reset.
    expect(without).toEqual([
      "metric:weight",
      "metric:bodyfat",
      "metric:resting_hr",
    ]);

    star(p, "trend-metric", "volume");
    // Re-starred, it comes back as a fresh save — at the FRONT, like any other star.
    expect(overviewTileKeys(p, 1, {})[0]).toBe("metric:volume");
  });

  it("renders nothing at all once every save is removed", () => {
    // The empty state's precondition (OverviewSection falls back to the EmptyState +
    // picker). Under the sampler this state was unreachable.
    const p = newProfile("Fully Unstarred");
    seedStandardMetricSaves(db, p);
    db.prepare(`DELETE FROM saved_items WHERE profile_id = ?`).run(p);
    expect(overviewTileKeys(p, 1, {})).toEqual([]);
  });

  it("sinks a tile with nothing to show below the populated ones, keeping saved-order indexes", () => {
    // #1485 A, over the real composition: a never-measured saved analyte compacts to
    // a one-line row at the bottom, while its slot in the SAVED order (what the
    // reorder controls move within) is unchanged.
    const p = newProfile("Empty Sink");
    star(p, "biomarker", "Ferritin"); // never measured on this profile
    seedStandardMetricSaves(db, p);
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, ?, 70, 'manual')`
    ).run(p, today(p));

    const restricted = isTrainingRestricted(p);
    const metricByKey = new Map(
      buildMetricSeries(p, 1, {}, restricted).map((t) => [t.key, t])
    );
    const tiles: TrendSeries[] = [];
    for (const ref of getSavedItems(p)) {
      if (ref.kind === "trend-metric") {
        const tile = metricByKey.get(metricSeriesKey(ref.key));
        if (tile) tiles.push(tile);
      } else {
        tiles.push(buildSavedBiomarkerTile(p, ref.key, {}, today(p)));
      }
    }
    const { populated, empty } = partitionOverviewTiles(tiles);
    expect(populated.map((s) => s.tile.key)).toEqual(["metric:weight"]);
    // Ferritin is saved first (a real star, ahead of the epoch seeds) but draws last.
    expect(empty[0].tile.key).toBe("bio:Ferritin");
    expect(empty[0].index).toBe(0);
  });

  it("seeds every standard metric, in tile order, after existing curation", () => {
    const p = newProfile("Curation Ahead");
    star(p, "biomarker", "LDL Cholesterol");
    star(p, "biomarker", "ApoB");
    seedStandardMetricSaves(db, p);

    // The user's two saves keep the front of the order; the four seeds follow in
    // tile order. This is the shape wave 2b's membership-driven grid will render.
    expect(savedKeys(p)).toEqual([
      "biomarker:ApoB", // newest star first — the pre-seed canonical order
      "biomarker:LDL Cholesterol",
      ...STANDARD_TREND_METRIC_IDS.map((id) => `trend-metric:${id}`),
    ]);
    // The seeds are UNPOSITIONED and epoch-stamped — that, not a position, is what
    // holds them behind the user's saves (and behind any star made later).
    for (const id of STANDARD_TREND_METRIC_IDS) {
      const row = savedRow(p, "trend-metric", id);
      expect(row.position).toBeNull();
      expect(row.created_at.startsWith("1970-01-01")).toBe(true);
    }
  });

  it("keeps a star made AFTER seeding ahead of the seeds", () => {
    // The reason the seeds are unpositioned: a newly starred biomarker must still
    // land at the FRONT of the grid, exactly where it lands today. Positioned seeds
    // would sort ahead of every later ★ and push it behind the standard tiles.
    const p = newProfile("Later Star");
    seedStandardMetricSaves(db, p);
    star(p, "biomarker", "Ferritin");
    expect(savedKeys(p)[0]).toBe("biomarker:Ferritin");
  });

  it("keeps a metric the user already saved untouched — one row, not two", () => {
    const p = newProfile("Dedupe");
    star(p, "trend-metric", "weight");
    star(p, "biomarker", "ApoB");
    seedStandardMetricSaves(db, p);

    const rows = db
      .prepare(
        `SELECT COUNT(*) AS c FROM saved_items
          WHERE profile_id = ? AND kind = 'trend-metric' AND key = 'weight'`
      )
      .get(p) as { c: number };
    expect(rows.c).toBe(1);
    // Its own row survives: a REAL created_at, not the epoch sentinel, so it keeps
    // sorting as the deliberate save it is — ahead of the seeds.
    expect(savedRow(p, "trend-metric", "weight").created_at).not.toContain(
      "1970-01-01"
    );
    expect(savedKeys(p).indexOf("trend-metric:weight")).toBeLessThan(
      savedKeys(p).indexOf("trend-metric:bodyfat")
    );
  });

  it("is a pure no-op on a second run (never resurrects an unstarred metric in one pass)", () => {
    const p = newProfile("Idempotent");
    star(p, "biomarker", "hs-CRP");
    seedStandardMetricSaves(db, p);
    const first = savedKeys(p);
    const stamps = STANDARD_TREND_METRIC_IDS.map(
      (id) => savedRow(p, "trend-metric", id).created_at
    );

    seedStandardMetricSaves(db, p);
    expect(savedKeys(p)).toEqual(first);
    expect(
      STANDARD_TREND_METRIC_IDS.map(
        (id) => savedRow(p, "trend-metric", id).created_at
      )
    ).toEqual(stamps);
  });

  it("touches only the profile it is given", () => {
    const a = newProfile("Isolation A");
    const b = newProfile("Isolation B");
    star(b, "biomarker", "ApoB");
    seedStandardMetricSaves(db, a);
    expect(savedKeys(b)).toEqual(["biomarker:ApoB"]);
  });

  it("seeds exactly the metric ids buildMetricSeries renders, in the same order", () => {
    // The list is a hand-maintained copy of METRIC_DEFS' ids; this is what stops the
    // two drifting (a new standard tile that never seeds would silently vanish from
    // Overview once the grid is membership-driven).
    const p = newProfile("Tile Order");
    const built = buildMetricSeries(p, 1, {}, false).map((s) =>
      s.key.replace(/^metric:/, "")
    );
    expect(built).toEqual([...STANDARD_TREND_METRIC_IDS]);
  });
});

describe("#1487 migration 114 — seeding the installed base", () => {
  // A database at exactly user_version 113 — every migration BEFORE the seeds. FKs
  // stay off, mirroring how the runner applies migrations.
  function preSeedDb(): Database.Database {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = OFF");
    for (const m of MIGRATIONS) {
      if (m.id >= SEEDS_MIGRATION) break;
      m.up(fresh);
    }
    return fresh;
  }

  function profile(handle: Database.Database, name: string): number {
    return Number(
      handle.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
  }

  function rows(
    handle: Database.Database,
    profileId: number
  ): { kind: string; key: string; position: number | null }[] {
    return handle
      .prepare(
        // The app's saved order, in SQL: positioned rows first ascending, then
        // unpositioned ones newest-first. Mirrors orderSavedRefs / getSavedItems,
        // which is what the Overview grid actually reads — ordering by `position`
        // alone would sort the unpositioned seeds FIRST and hide the very thing
        // these tests exist to check.
        `SELECT kind, key, position FROM saved_items
          WHERE profile_id = ?
          ORDER BY (position IS NULL), position, created_at DESC, id DESC`
      )
      .all(profileId) as {
      kind: string;
      key: string;
      position: number | null;
    }[];
  }

  it("seeds every existing profile, per-profile, with the standard set", () => {
    const handle = preSeedDb();
    const a = profile(handle, "Test Patient A");
    const b = profile(handle, "Test Patient B");
    up114(handle);

    for (const p of [a, b]) {
      expect(rows(handle, p).map((r) => r.key)).toEqual([
        ...STANDARD_TREND_METRIC_IDS,
      ]);
      // Unpositioned by design — the epoch stamp, not a position, orders them.
      expect(rows(handle, p).map((r) => r.position)).toEqual([
        null,
        null,
        null,
        null,
      ]);
      expect(rows(handle, p).every((r) => r.kind === "trend-metric")).toBe(
        true
      );
    }
  });

  it("puts existing curation AHEAD of the seeds, positioned or not", () => {
    const handle = preSeedDb();
    const p = profile(handle, "Test Patient Curated");
    // One explicitly positioned save (a pin folded by 113) and one plain ★ with no
    // position — the two shapes that coexist in the installed base.
    handle
      .prepare(
        `INSERT INTO saved_items (profile_id, kind, key, position) VALUES (?, 'biomarker', 'ApoB', 0)`
      )
      .run(p);
    handle
      .prepare(
        `INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', 'hs-CRP')`
      )
      .run(p);
    up114(handle);

    const ordered = rows(handle, p);
    expect(ordered.map((r) => r.key)).toEqual([
      "ApoB",
      "hs-CRP",
      ...STANDARD_TREND_METRIC_IDS,
    ]);
    // No existing row was rewritten: the pinned save keeps its position, the plain
    // ★ keeps its NULL, and the seeds sort last on their epoch stamp alone.
    expect(ordered.map((r) => r.position)).toEqual([
      0,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("dedupes against a metric the profile had already saved", () => {
    const handle = preSeedDb();
    const p = profile(handle, "Test Patient Pinned Weight");
    handle
      .prepare(
        `INSERT INTO saved_items (profile_id, kind, key, position) VALUES (?, 'trend-metric', 'weight', 0)`
      )
      .run(p);
    up114(handle);

    const ordered = rows(handle, p);
    expect(ordered.filter((r) => r.key === "weight")).toHaveLength(1);
    expect(ordered.map((r) => r.key)).toEqual([
      "weight",
      "bodyfat",
      "resting_hr",
      "volume",
    ]);
  });

  it("replays as a pure no-op", () => {
    const handle = preSeedDb();
    const p = profile(handle, "Test Patient Replay");
    handle
      .prepare(
        `INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', 'ApoB')`
      )
      .run(p);
    up114(handle);
    const once = rows(handle, p);
    up114(handle);
    expect(rows(handle, p)).toEqual(once);
  });

  it("seeds nothing when there are no profiles yet (a fresh database)", () => {
    // On a fresh DB the runner completes BEFORE bootstrapAuth creates profile 1, so
    // this migration legitimately has nothing to do — the creation path seeds instead.
    const handle = preSeedDb();
    expect(() => up114(handle)).not.toThrow();
    expect(
      (
        handle.prepare(`SELECT COUNT(*) AS c FROM saved_items`).get() as {
          c: number;
        }
      ).c
    ).toBe(0);
  });
});
