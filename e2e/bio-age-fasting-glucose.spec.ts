import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";

// The #2334 draw, in the browser: nine PhenoAge analytes where glucose arrives under
// the curated "Glucose, Fasting" entry (what a lab reporting a fasting panel imports
// as) and hs-CRP is reported BELOW its detection limit ("<0.2"). Before the fix this
// shape produced no biological age at all, and nothing on the page could explain why
// — every analyte was plainly there.
//
// What the hero must now show: the number, the fasting entry as the glucose input it
// was built from, the reported "<0.2" beside the value it stood in for, and — because
// a single number has no hollow dot to draw — the censoring said in words, naming the
// input and the direction of the bias the substitution introduces. Since #2367 the
// hero renders on /longevity; the Biomarkers page keeps the input panel, which this
// file also covers because it owns the draw that makes both states meaningful.
//
// Fixture ownership (#868): the spec plants ONE draw on a date no seeded reading
// occupies (the newest seeded lab draw is 30 days back), so it owns the hero's latest
// draw for the length of this file and deletes the rows afterwards. Synthetic values.
const DB_PATH = workerDbPath();
const CRP = "High-Sensitivity C-Reactive Protein (hs-CRP)";

// Five days before the frozen clock: newer than every seeded draw, never "today".
const DRAW_DATE = new Date(frozenNow().getTime() - 5 * 24 * 3600 * 1000)
  .toISOString()
  .slice(0, 10);

// [canonical name, unit, value string, exact numeric or null]. Ordinary adult
// numbers. hs-CRP carries NO value_num — the reading is the censored string, exactly
// as a below-detection result imports.
const DRAW: [string, string, string, number | null][] = [
  ["Albumin", "g/dL", "4.4", 4.4],
  ["Creatinine", "mg/dL", "0.9", 0.9],
  ["Glucose, Fasting", "mg/dL", "90", 90],
  [CRP, "mg/L", "<0.2", null],
  ["Lymphocytes", "%", "32", 32],
  ["Mean Corpuscular Volume (MCV)", "fL", "89", 89],
  ["Red Cell Distribution Width (RDW)", "%", "13", 13],
  ["Alkaline Phosphatase", "U/L", "62", 62],
  ["White Blood Cell Count", "10^3/uL", "5.5", 5.5],
];

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
  withDb((db) =>
    db
      .prepare("DELETE FROM medical_records WHERE profile_id = 1 AND date = ?")
      .run(DRAW_DATE)
  );
}

test.beforeAll(() => {
  cleanup();
  withDb((db) => {
    const add = db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit, canonical_name)
       VALUES (1, ?, 'lab', ?, ?, ?, ?, ?)`
    );
    for (const [name, unit, value, valueNum] of DRAW)
      add.run(DRAW_DATE, name, value, valueNum, unit, name);
  });
});

test.afterAll(cleanup);

test("the hero computes from a fasting-glucose draw and says it rests on a censored input", async ({
  page,
}) => {
  test.slow();
  // The hero renders on Longevity and nowhere else since #2367.
  await page.goto("/longevity");

  const hero = page.getByRole("main").getByTestId("bio-age-hero");
  await expect(hero).toBeVisible();
  // A number, not a missing-inputs panel: the draw is complete.
  await expect(hero.getByTestId("bio-age-value")).toBeVisible();

  // The censoring, in words — which input, at what limit, and which way it biases.
  const censored = hero.getByTestId("bio-age-censored");
  await expect(censored).toContainText("Rests on a censored input");
  await expect(censored).toContainText(CRP);
  await expect(censored).toContainText("below its detection limit");
  await expect(censored).toContainText("can only be too high");

  // The per-input list names the entry the glucose value actually came from…
  const inputs = hero.getByTestId("bio-age-input");
  await expect(inputs.filter({ hasText: "Glucose, Fasting" })).toHaveCount(1);
  // …and keeps the lab's "<" beside the substituted limit, never a laundered 0.2.
  const crpRow = inputs.filter({ hasText: CRP });
  await expect(crpRow).toContainText("<0.2 mg/L");
  // The censored input's leave-one-out effect (#2366) is still stated — it is a real
  // comparison, just one resting on the substituted limit, which the row's own
  // tooltip says. Never a blank, and never a silent zero.
  await expect(crpRow.getByTestId("bio-age-effect")).toContainText(
    /[+−±]\d+\.\d yr/
  );
  await expect(crpRow.getByTestId("bio-age-effect")).toHaveAttribute(
    "title",
    /substituted limit/
  );
  // The glucose row DOES have a curated target here (the fasting entry carries a
  // band; the unqualified one deliberately does not), so it states one.
  await expect(inputs.filter({ hasText: "Glucose, Fasting" })).toContainText(
    "(optimal)"
  );
});

// The results page's half of the split (#2367): a complete panel, so nothing is
// missing — but the input panel still renders, says so, and points at the hero.
test("the biomarkers page keeps the inputs and links to the hero", async ({
  page,
}) => {
  await page.goto("/results");
  const main = page.getByRole("main");
  await expect(main.getByTestId("bio-age-hero")).toHaveCount(0);
  const card = main.getByTestId("bio-age-inputs-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("bio-age-input")).toHaveCount(9);
  await expect(card.getByTestId("bio-age-hero-link")).toHaveAttribute(
    "href",
    "/longevity#bio-age"
  );
});
