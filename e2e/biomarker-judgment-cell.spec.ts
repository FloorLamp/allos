import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";

// The biomarker row says which band judged it, and what the verdict is called
// (#2315).
//
// WHAT WAS WRONG. The Reference cell printed `reference_range` — the free-text
// string the lab document stated — beside a flag `reconciledFlag` derived from the
// CANONICAL reference range and the CANONICAL optimal band. The printed string is
// provenance, not a threshold: it reaches that function only as an input to the
// #761 unit-mislabel detector. So the row showed the one range that never judges it
// and hid both that do, and the severity word ("High" vs "Above optimal") that
// separates a red row from an amber one travelled by color alone for a sighted
// reader.
//
// Fixture hygiene (#868): the first two tests are READ-ONLY against the shared seeded
// admin profile — every assertion is bounded by an explicit filter and is
// presence-shaped, never an exact count of a shared-seed aggregate. The third owns its
// one row: the UNJUDGED case needs an analyte the vocabulary does not carry, and every
// seeded analyte is canonical by design, so the row is planted and deleted here.

const DB_PATH = workerDbPath();

// An analyte no curated entry covers, so `metricJudgment` answers nothing and the
// printed string genuinely IS the deciding range. Clearly fictional.
const UNJUDGED_ANALYTE = "Fictional Marker Twelve";
const UNJUDGED_PRINTED = "3.4-8.5";

// Three days before the frozen clock — newer than every seeded draw, never "today".
const UNJUDGED_DATE = new Date(frozenNow().getTime() - 3 * 24 * 3600 * 1000)
  .toISOString()
  .slice(0, 10);

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(DB_PATH);
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function removeUnjudgedRow() {
  withDb((db) =>
    db
      .prepare(
        "DELETE FROM medical_records WHERE profile_id = 1 AND canonical_name = ?"
      )
      .run(UNJUDGED_ANALYTE)
  );
}

// `sr-only` clips its element to a 1px box; a rendered word is wider. This is the
// assertion that separates "in the accessibility tree" from "in the visible text",
// which `toBeVisible()` cannot do — an sr-only span is visible to Playwright.
async function expectRenderedWide(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(4);
}

test("the Reference cell states the bands the flag came from, and keeps the lab's string as provenance", async ({
  page,
}) => {
  // A panel facet narrows the index AND expands every matching group (#1651), so
  // the readings are on the page without a disclosure tap.
  await page.goto("/results/readings?panel=lipids&current=1");
  const table = page.getByTestId("biomarkers-table");
  await expect(table).toBeVisible();

  // ApoB is the issue's own example: the document printed `<90`, and the amber
  // "Above optimal" verdict comes from the canonical optimal band (≤60) that the
  // printed string never mentions. Both bands show, because which one you crossed
  // is exactly what the amber/red split means.
  const row = table
    .getByRole("row")
    .filter({ hasText: "Apolipoprotein B (ApoB)" });
  const cell = row.getByTestId("biomarker-reference");
  await expect(cell).toHaveText("ref ≤ 90 · optimal ≤ 60");
  await expect(cell).toHaveAttribute("data-judged", "true");
  // The lab's own string did not disappear — it moved from assertion to
  // provenance, on the cell that replaced it.
  await expect(cell).toHaveAttribute("title", "Lab reference: <90");

  // Nothing on this filtered view falls back: every lipid analyte is canonical, so
  // no row is still printing the lab's range as if it were the deciding one.
  await expect(
    table.locator('[data-testid="biomarker-reference"][data-judged="false"]')
  ).toHaveCount(0);
});

test("a flagged row's severity word is in the visible text, not only the accessibility tree", async ({
  page,
}) => {
  // Every row under this filter is out of range, so each one must carry a word.
  await page.goto("/results/readings?range=oor&current=1");
  const table = page.getByTestId("biomarkers-table");
  await expect(table).toBeVisible();

  const words = table.locator(
    '[data-testid="medical-flag-text"][data-visible="true"]'
  );
  await expect(words).not.toHaveCount(0);
  await expectRenderedWide(words.first()); // first-ok: every row under this filter is flagged, so which word is measured is irrelevant — only that it is drawn, not clipped
  for (const t of await words.allTextContents()) {
    expect(["High", "Low", "Abnormal"]).toContain(t.trim());
  }

  // And the deciding band is rendered beside the value on the same rows.
  await expect(
    table.locator('[data-testid="biomarker-reference"][data-judged="true"]')
  ).not.toHaveCount(0);
});

// #2344: the unjudged cell says which case it is in, standing alone.
//
// `referenceCell` returns label "Lab reference" for this case, but that prop is the
// CARD-mode label — on the desktop table the column header is one `<th>` shared by
// every row and reads "Reference" regardless, which is the viewport the default
// Playwright project runs at. So the distinction has to be in the cell's own content,
// by the same prefix mechanism the judged case already uses.
test.describe("an unjudged Reference cell", () => {
  test.beforeAll(() => {
    removeUnjudgedRow();
    withDb((db) =>
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit,
              canonical_name, reference_range)
           VALUES (1, ?, 'lab', ?, '5', 5, 'units/L', ?, ?)`
        )
        .run(UNJUDGED_DATE, UNJUDGED_ANALYTE, UNJUDGED_ANALYTE, UNJUDGED_PRINTED)
    );
  });

  test.afterAll(removeUnjudgedRow);

  test("prefixes the lab's own range, so the desktop table needs no second channel", async ({
    page,
  }) => {
    // A `q` filter narrows the index, and a narrowed index arrives with every group
    // expanded (#1651), so the row is on the page without a disclosure tap.
    await page.goto(`/results/readings?q=${encodeURIComponent(UNJUDGED_ANALYTE)}`);
    const table = page.getByTestId("biomarkers-table");
    await expect(table).toBeVisible();

    const row = table.getByRole("row").filter({ hasText: UNJUDGED_ANALYTE });
    const cell = row.getByTestId("biomarker-reference");
    await expect(cell).toHaveAttribute("data-judged", "false");
    // The lab's digits, unchanged — and named as the lab's, in the cell itself.
    await expect(cell).toHaveText(`lab ${UNJUDGED_PRINTED}`);
    // No hover provenance here: the content already IS the printed string, so a
    // title repeating it would say the same thing twice.
    await expect(cell).not.toHaveAttribute("title", /./);
  });

  test("reads differently from a judged cell under the same shared header", async ({
    page,
  }) => {
    // The two cases side by side, which is the comparison #2344 is about: both sit
    // under one "Reference" `<th>`, and each one states which range decided it.
    await page.goto("/results/readings?panel=lipids&current=1");
    const judged = page
      .getByTestId("biomarkers-table")
      .getByRole("row")
      .filter({ hasText: "Apolipoprotein B (ApoB)" })
      .getByTestId("biomarker-reference");
    await expect(judged).toHaveText(/^ref /);

    await page.goto(`/results/readings?q=${encodeURIComponent(UNJUDGED_ANALYTE)}`);
    const unjudged = page
      .getByTestId("biomarkers-table")
      .getByRole("row")
      .filter({ hasText: UNJUDGED_ANALYTE })
      .getByTestId("biomarker-reference");
    await expect(unjudged).toHaveText(/^lab /);
  });
});
