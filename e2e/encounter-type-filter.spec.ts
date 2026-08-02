import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";

// Canonical encounter types (#1233): the Visits list keeps the source's visit type
// without a redundant ActEncounterCode badge and offers a canonical-kind filter
// ("show ED visits") keyed on the ONE encounterKind() identity function. This
// spec OWNS its fixtures — two throwaway encounters on profile 1 (the e2e session's
// active profile) with DISTINCT classes (Emergency + Ambulatory) and unique reason
// markers — and asserts only on those rows (presence/absence under a filter), never an
// exact count of the shared seed. Both rows are removed afterward so the shared DB
// stays clean across CI retries.
const DB_PATH = workerDbPath();

const EMER_MARKER = "E2E 1233 emergency filter marker";
const AMB_MARKER = "E2E 1233 ambulatory filter marker";
const EMER_EXTERNAL = "e2e-1233-emer";
const AMB_EXTERNAL = "e2e-1233-amb";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM encounters WHERE external_id IN (?, ?)")
      .run(EMER_EXTERNAL, AMB_EXTERNAL);
  } finally {
    handle.close();
  }
}

test.describe("Visits — canonical encounter class label + kind filter (#1233)", () => {
  test.beforeAll(() => {
    cleanup();
    const handle = new Database(DB_PATH);
    try {
      const date = frozenNow().toISOString().slice(0, 10);
      const ins = handle.prepare(
        `INSERT INTO encounters (profile_id, date, type, class_code, reason, source, external_id)
         VALUES (1, ?, ?, ?, ?, 'manual', ?)`
      );
      ins.run(date, "E2E ER Visit", "EMER", EMER_MARKER, EMER_EXTERNAL);
      ins.run(date, "E2E Clinic Visit", "AMB", AMB_MARKER, AMB_EXTERNAL);
    } finally {
      handle.close();
    }
  });

  test.afterAll(cleanup);

  test("the visit type stands alone without a duplicate class badge", async ({
    page,
  }) => {
    await page.goto("/records/history/visits");
    const list = page.getByTestId("records-visits");

    // The source's own visit type is the single label. Neither the friendly class
    // label nor its raw code is repeated beside it as a badge.
    const emerRow = list.locator("tr", { hasText: EMER_MARKER });
    await expect(
      emerRow.getByRole("link", { name: "E2E ER Visit" })
    ).toBeVisible();
    await expect(emerRow).not.toContainText("Emergency");
    await expect(emerRow).not.toContainText("EMER");

    const ambRow = list.locator("tr", { hasText: AMB_MARKER });
    await expect(
      ambRow.getByRole("link", { name: "E2E Clinic Visit" })
    ).toBeVisible();
    await expect(ambRow).not.toContainText("Ambulatory");
    await expect(ambRow).not.toContainText("AMB");
  });

  test("the kind filter shows only the selected kind's visits", async ({
    page,
  }) => {
    await page.goto("/records/history/visits");
    const list = page.getByTestId("records-visits");

    // Both fixture rows are visible unfiltered.
    await expect(list.getByText(EMER_MARKER)).toBeVisible();
    await expect(list.getByText(AMB_MARKER)).toBeVisible();

    // The filter appears (≥2 kinds present) and offers an Emergency chip.
    const filter = page.getByTestId("encounter-kind-filter");
    await expect(filter).toBeVisible();

    // Filter to Emergency → the ED visit stays, the ambulatory one drops out.
    await filter.getByTestId("encounter-kind-emergency").click();
    await expect(list.getByText(EMER_MARKER)).toBeVisible();
    await expect(list.getByText(AMB_MARKER)).toHaveCount(0);

    // Filter to Ambulatory → the reverse.
    await filter.getByTestId("encounter-kind-ambulatory").click();
    await expect(list.getByText(AMB_MARKER)).toBeVisible();
    await expect(list.getByText(EMER_MARKER)).toHaveCount(0);

    // Back to All → both return.
    await filter.getByTestId("encounter-kind-all").click();
    await expect(list.getByText(EMER_MARKER)).toBeVisible();
    await expect(list.getByText(AMB_MARKER)).toBeVisible();
  });
});
