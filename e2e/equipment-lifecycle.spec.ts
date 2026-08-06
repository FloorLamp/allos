import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";

const DB_PATH = workerDbPath();
const NAME = "E2E Trap Bar";

// Repeat-safe (#868): the add rejects a duplicate name (app/(app)/equipment/actions.ts
// — "You already have equipment named …"), so a --repeat-each iteration that re-added
// this marker would get that error instead of "Equipment added" and hang the first
// assert. Delete just this marker (scoped, like imaging.spec) before + after every run.
function cleanup() {
  const db = new Database(DB_PATH);
  try {
    db.prepare("DELETE FROM equipment WHERE name = ?").run(NAME);
  } finally {
    db.close();
  }
}

// #341: equipment lifecycle. The equipment manager (now the /equipment registry
// index — issue #343) gains a Retire/Restore toggle (soft-retire, mirroring dose
// retire) alongside the existing edit/delete, and the Type picker offers the
// expanded, grouped category set. This drives the manager: add a piece of gear,
// retire it (it stays listed with a "Retired" badge), then restore it — proving
// the round-trip renders on the real page.
test.beforeEach(cleanup);
test.afterEach(cleanup);

test("retire and restore equipment from the manager (#341)", async ({
  page,
}) => {
  await page.goto("/equipment");

  await expect(
    page.getByRole("heading", { name: "Your equipment" })
  ).toBeVisible();

  // Add a distinctive, synthetic implement.
  await page.getByRole("button", { name: "Add equipment" }).click();
  await page.getByLabel("Name").fill("E2E Trap Bar");
  // The expanded category set is grouped; Kettlebell is one of the new strength
  // options, proving the enum expansion reached the UI.
  await page.getByLabel("Type").selectOption("Kettlebell");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Equipment added")).toBeVisible();

  const row = page
    .getByTestId("equipment-row")
    .filter({ hasText: "E2E Trap Bar" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-retired", "0");

  // Retire it — the row stays listed (history-preserving) but flips to retired and
  // shows the badge. Row actions live in the shared ⋯ menu (#1491): open it,
  // then click the (portaled) Retire item.
  await row.getByRole("button", { name: "Equipment actions" }).click();
  await page.getByTestId("equipment-retire-toggle").click();
  await expect(page.getByText("Retired E2E Trap Bar")).toBeVisible();
  const retiredRow = page
    .getByTestId("equipment-row")
    .filter({ hasText: "E2E Trap Bar" });
  // Badge/attr flips on the toggle action's revalidated tree — cold-shard budget (imaging precedent).
  await expect(retiredRow).toHaveAttribute("data-retired", "1", {
    timeout: 15_000,
  });
  await expect(retiredRow.getByText("Retired")).toBeVisible();

  // Restore it.
  await retiredRow.getByRole("button", { name: "Equipment actions" }).click();
  await page.getByTestId("equipment-retire-toggle").click();
  await expect(page.getByText("Restored E2E Trap Bar")).toBeVisible();
  await expect(
    page.getByTestId("equipment-row").filter({ hasText: "E2E Trap Bar" })
  ).toHaveAttribute("data-retired", "0", { timeout: 15_000 });
});

// #2138: retire is a typed, changes-checked transition and the manager RENDERS the
// refusal. A page whose row was retired behind its back still offers "Retire"; the
// tap must answer with the state that actually holds — in the error tone — never
// with the stale render's "Retired …" success toast (the silent-no-op this issue
// closed used to keep offering sold gear).
test("a stale page's retire tap renders the typed refusal (#2138)", async ({
  page,
}) => {
  // Unique marker so a CI retry / repeat-each and the sibling test above can't
  // collide on the per-profile name-uniqueness guard.
  const name = `E2E Stale Retire Bar ${Date.now()}`; // clock-ok: unique-name suffix, never a stored timestamp
  await page.goto("/equipment");
  await page.getByRole("button", { name: "Add equipment" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Equipment added")).toBeVisible();
  const row = page.getByTestId("equipment-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("data-retired", "0");

  // Another session retires it behind this page's back (name-scoped direct write —
  // this worker's own database, this test's own fixture row).
  const db = new Database(DB_PATH);
  try {
    db.prepare("UPDATE equipment SET retired = 1 WHERE name = ?").run(name);
  } finally {
    db.close();
  }

  // The stale row still offers "Retire". The tap lands on the CAS, which refuses,
  // and the refusal is toasted — nothing claims a flip that did not happen.
  await row.getByRole("button", { name: "Equipment actions" }).click();
  await page.getByTestId("equipment-retire-toggle").click();
  await expect(
    page.getByText("That equipment is already retired.")
  ).toBeVisible({ timeout: 15_000 });

  // Cleanup this test's own marker (the file-level hooks only sweep NAME).
  const cleanupDb = new Database(DB_PATH);
  try {
    cleanupDb.prepare("DELETE FROM equipment WHERE name = ?").run(name);
  } finally {
    cleanupDb.close();
  }
});
