import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import { followLink } from "./helpers";
import { workerDbPath } from "./worker-env";

// Command-palette hits land on their TARGET, not a hub (#1568).
//
// The assertion that matters here is the DESTINATION. The original bug was
// invisible as a navigation failure: an activity hit's href was the constant
// `/training`, so selecting it FROM /training — the natural place to be when
// searching for a workout — was a same-route push. The palette closed and
// nothing on screen changed, which reads as a dead control. A spec that only
// asserted "the palette closed" would have passed straight over it, so both
// cases below start on the source route and assert the URL they end up at.
//
// Fixture ownership (#868): this spec plants its OWN activity and medication
// under unique markers and deletes them, so it never exact-counts or perturbs a
// shared-seed row. Synthetic data only.
const DB_PATH = workerDbPath();
const ACTIVITY_MARKER = "E2E palette deeplink ride";
const MED_MARKER = "E2E palette deeplink Zolpiquine";
// The #1595 entity domains share ONE marker word, so a single query pulls a hit
// from each new group and the assertion covers the whole set rather than one
// domain per spec.
const ENTITY_MARKER = "Larkspur";
const PROVIDER_NAME = `${ENTITY_MARKER} Dental Group`;
const PROVIDER_KEY = "e2e-palette-larkspur-dental";
const ENCOUNTER_TYPE = `${ENTITY_MARKER} dental visit`;
const IMAGING_REGION = `${ENTITY_MARKER} knee`;
const GENOMIC_LAB = `${ENTITY_MARKER} Genetics`;
const DENTAL_NAME = `${ENTITY_MARKER} crown`;
const SKIN_LABEL = `${ENTITY_MARKER} mole`;
const EPISODE_SITUATION = `${ENTITY_MARKER} cold`;
const PROTOCOL_NAME = `${ENTITY_MARKER} sauna block`;
const PRACTICE_NAME = `${ENTITY_MARKER} plunge`;
const EQUIPMENT_NAME = `${ENTITY_MARKER} trap bar`;
// Deep past on purpose: a per-record ride detail must resolve independently of
// the Journal's newest window (#451).
const ACTIVITY_DATE = "2019-03-14";

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function cleanup() {
  withDb((db) => {
    db.prepare("DELETE FROM activities WHERE title = ?").run(ACTIVITY_MARKER);
    db.prepare("DELETE FROM intake_items WHERE name = ?").run(MED_MARKER);
    // Children that reference the planted provider go FIRST, then the provider
    // itself — the registry row is global, so leaving it behind would leak into
    // another spec's palette.
    db.prepare("DELETE FROM imaging_studies WHERE body_region = ?").run(
      IMAGING_REGION
    );
    db.prepare("DELETE FROM genomic_variants WHERE source_lab = ?").run(
      GENOMIC_LAB
    );
    db.prepare("DELETE FROM dental_procedures WHERE name = ?").run(DENTAL_NAME);
    db.prepare("DELETE FROM skin_lesions WHERE label = ?").run(SKIN_LABEL);
    db.prepare("DELETE FROM encounters WHERE type = ?").run(ENCOUNTER_TYPE);
    db.prepare("DELETE FROM providers WHERE dedup_key = ?").run(PROVIDER_KEY);
    db.prepare("DELETE FROM illness_episodes WHERE situation = ?").run(
      EPISODE_SITUATION
    );
    db.prepare("DELETE FROM protocols WHERE name = ?").run(PROTOCOL_NAME);
    db.prepare("DELETE FROM practice_logs WHERE practice = ?").run(
      PRACTICE_NAME
    );
    db.prepare("DELETE FROM equipment WHERE name = ?").run(EQUIPMENT_NAME);
  });
}

let medId = 0;
let episodeId = 0;
let protocolId = 0;
let equipmentId = 0;
let activityId = 0;

test.beforeAll(() => {
  cleanup();
  medId = withDb((db) => {
    activityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (1, ?, 'cardio', ?, 45)`
        )
        .run(ACTIVITY_DATE, ACTIVITY_MARKER).lastInsertRowid
    );
    return Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active)
           VALUES (1, ?, 'medication', 1)`
        )
        .run(MED_MARKER).lastInsertRowid
    );
  });
  // One row per newly searchable domain, all carrying ENTITY_MARKER (#1595), so a
  // single query fills every new group at once.
  withDb((db) => {
    const providerId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, specialty, dedup_key)
           VALUES (?, 'organization', 'Dentistry', ?)`
        )
        .run(PROVIDER_NAME, PROVIDER_KEY).lastInsertRowid
    );
    // The registry is global, so a provider is searchable only through a record of
    // THIS profile that names it.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, provider_id)
       VALUES (1, '2026-02-10', ?, ?)`
    ).run(ENCOUNTER_TYPE, providerId);
    db.prepare(
      `INSERT INTO imaging_studies
         (profile_id, modality, body_region, laterality, study_date, impression)
       VALUES (1, 'mri', ?, 'left', '2026-02-11', 'No meniscal tear.')`
    ).run(IMAGING_REGION);
    db.prepare(
      `INSERT INTO genomic_variants
         (profile_id, gene, star_allele, result_type, source_lab, report_date)
       VALUES (1, 'CYP2C19', '*2/*17', 'pharmacogenomic', ?, '2025-11-04')`
    ).run(GENOMIC_LAB);
    db.prepare(
      `INSERT INTO dental_procedures
         (profile_id, name, status, tooth, procedure_date, provider_id)
       VALUES (1, ?, 'completed', '30', '2026-02-12', ?)`
    ).run(DENTAL_NAME, providerId);
    db.prepare(
      `INSERT INTO skin_lesions
         (profile_id, label, body_region, body_side, size_mm, status, observed_date)
       VALUES (1, ?, 'forearm', 'left', 4, 'watch', '2026-02-13')`
    ).run(SKIN_LABEL);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date)
       VALUES (1, ?, '2026-02-14')`
    ).run(PRACTICE_NAME);
    episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at)
           VALUES (1, ?, '2026-03-01')`
        )
        .run(EPISODE_SITUATION).lastInsertRowid
    );
    protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols (profile_id, name, start_date)
           VALUES (1, ?, '2026-03-01')`
        )
        .run(PROTOCOL_NAME).lastInsertRowid
    );
    equipmentId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name, category)
           VALUES (1, ?, 'Barbell')`
        )
        .run(EQUIPMENT_NAME).lastInsertRowid
    );
  });
});

test.afterAll(cleanup);

test("a ride hit picked FROM /training navigates to its ride detail", async ({
  page,
}) => {
  test.slow();
  // Starting on /training is load-bearing: it is the one surface where the old
  // constant `/training` href made the bug invisible.
  await page.goto("/training");

  const input = await openCommandPalette(page);
  await input.fill(ACTIVITY_MARKER);

  const results = page.getByRole("listbox", { name: "Results" });
  const hit = results
    .getByRole("option")
    .filter({ hasText: ACTIVITY_MARKER })
    .first(); // first-ok: filtered to a marker THIS spec planted — exactly one activity carries it
  await expect(hit).toBeVisible();

  // The destination, not merely "the palette closed": the per-record ride URL.
  await followLink(page, hit, new RegExp(`/training/rides/${activityId}$`));

  await expect(page.getByTestId("ride-detail")).toBeVisible();
  await expect(page.getByRole("main")).toContainText(ACTIVITY_MARKER);
});

test("a medication hit navigates to that medication's detail page", async ({
  page,
}) => {
  test.slow();
  // Same shape from the medications list: the hit used to stop at the list hub.
  await page.goto("/medications");

  const input = await openCommandPalette(page);
  await input.fill(MED_MARKER);

  const results = page.getByRole("listbox", { name: "Results" });
  const hit = results
    .getByRole("option")
    .filter({ hasText: MED_MARKER })
    .first(); // first-ok: filtered to a marker THIS spec planted — exactly one medication carries it
  await expect(hit).toBeVisible();

  await followLink(page, hit, new RegExp(`/medications/${medId}$`));
  await expect(page.getByRole("main")).toContainText(MED_MARKER);
});

test("the entity domains added in #1595 are searchable and land on their own surface", async ({
  page,
}) => {
  test.slow();
  // Start on Upcoming: none of the destinations below is the current route, so
  // every navigation below is real.
  await page.goto("/upcoming");

  const input = await openCommandPalette(page);
  await input.fill(ENTITY_MARKER);

  const results = page.getByRole("listbox", { name: "Results" });
  // One query, one hit per new domain — the groups are what the issue's ask is
  // about ("providers, imaging, dental, skin lesions, genomics, episodes,
  // protocols, practices, equipment are unsearchable").
  //
  // The FIRST assertion carries a longer budget: the debounced server search can
  // outlive the default assertion window under shard contention (the same reason
  // smoke.spec.ts waits 15s on its palette group), and waiting on the result
  // itself keeps that patience honest — no network-quiet guessing.
  for (const label of [
    "Imaging",
    "Genomics",
    "Providers",
    "Illness Episodes",
    "Dental",
    "Skin",
    "Protocols",
    "Practices",
    "Equipment",
  ]) {
    await expect(results.getByText(label, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  }

  const option = (text: string) =>
    results.getByRole("option").filter({ hasText: text }).first(); // first-ok: filtered to a marker THIS spec planted — exactly one row per domain carries it

  // Each hit names its record the way that record's own page does — the domain's
  // canonical display label, not a re-invented one. (Imaging, genomics, dental,
  // skin, and practices render no per-row anchor, so their hits land on the owning
  // list surface; the four below deep-link a detail route.)
  await expect(option("MRI Left")).toBeVisible();
  await expect(option("CYP2C19 *2/*17")).toBeVisible();
  await expect(option(`${DENTAL_NAME} · #30`)).toBeVisible();
  await expect(option(PROVIDER_NAME)).toBeVisible();
  await expect(option(SKIN_LABEL)).toBeVisible();
  await expect(option(PRACTICE_NAME)).toBeVisible();

  // A protocol hit deep-links its detail route, not a hub (#1568).
  await followLink(
    page,
    option(PROTOCOL_NAME),
    new RegExp(`/protocols/${protocolId}$`)
  );
  await expect(page.getByRole("main")).toContainText(PROTOCOL_NAME);

  // Same for an episode and a piece of equipment, each from a different route.
  await page.goto("/medical/episodes");
  const episodeInput = await openCommandPalette(page);
  await episodeInput.fill(EPISODE_SITUATION);
  await followLink(
    page,
    page
      .getByRole("listbox", { name: "Results" })
      .getByRole("option")
      .filter({ hasText: EPISODE_SITUATION })
      .first(), // first-ok: filtered to a marker THIS spec planted — exactly one episode carries it
    new RegExp(`/medical/episodes/${episodeId}$`)
  );

  await page.goto("/equipment");
  const gearInput = await openCommandPalette(page);
  await gearInput.fill(EQUIPMENT_NAME);
  await followLink(
    page,
    page
      .getByRole("listbox", { name: "Results" })
      .getByRole("option")
      .filter({ hasText: EQUIPMENT_NAME })
      .first(), // first-ok: filtered to a marker THIS spec planted — exactly one equipment row carries it
    new RegExp(`/equipment/${equipmentId}$`)
  );
  await expect(page.getByRole("main")).toContainText(EQUIPMENT_NAME);
});
