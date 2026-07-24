import Database from "better-sqlite3";
import { test, expect } from "../db-per-worker.fixture";

// SPIKE proof spec: demonstrates that each Playwright worker truly runs against its
// OWN server + OWN DB, and that a write in one worker is invisible to the other.
//
// Runs under playwright.db-per-worker.config.ts (workers=2) ONLY. It is a `.poc.ts`
// file so the main *.spec.ts suite never picks it up.

test.describe.configure({ mode: "parallel" });

// 1) Distinct server + DB per worker. The fixture assigns port = 3200 + parallelIndex
//    and db = e2e/.data/worker-<idx>.db. Assert the baseURL the page actually uses
//    matches this worker's assignment — i.e. the two workers are NOT sharing a server.
test("worker gets its own server + db (port/db keyed on parallelIndex)", async ({
  workerServer,
  baseURL,
  page,
}, testInfo) => {
  const idx = testInfo.parallelIndex;
  expect(workerServer.port).toBe(3200 + idx);
  expect(workerServer.dbPath).toContain(`worker-${idx}.db`);
  expect(baseURL).toBe(`http://localhost:${3200 + idx}`);

  // The page (built-in fixture, using the per-worker storageState) is authenticated
  // against THIS server — a shared cookie from another DB would bounce to /login.
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp(`^http://localhost:${3200 + idx}/`));
  await expect(page.getByRole("link", { name: "Data" })).toBeVisible();

  // eslint-disable-next-line no-console
  console.log(
    `[db-isolation] worker ${idx} authenticated on ${baseURL} db=${workerServer.dbPath}`
  );
});

// 2) Write-invisibility across workers. Each of the two tests below writes a
//    supplement stamped with ITS worker index, then asserts the supplements page
//    shows its OWN marker and NONE bearing a different index. With workers=2 and
//    parallel mode, the two tests run concurrently on the two workers; if the DBs
//    were shared, one worker would observe the other's marker. Separate DBs → never.
async function writeAndAssertIsolation(
  page: import("@playwright/test").Page,
  workerServer: { dbPath: string },
  idx: number
) {
  const marker = `ISO-W${idx}-supp`;
  await page.goto("/nutrition?tab=supplements");
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add supplement" });
  await addCard.getByLabel("Name").fill(marker);
  await addCard.getByLabel("Amount").first().fill("100 mg");
  await addCard.getByLabel("Time of day").first().selectOption("Morning");
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // Our own marker landed.
  await expect(
    page.locator("div.card").filter({ hasText: marker }).first()
  ).toBeVisible();

  // No OTHER worker's marker is visible on this page.
  const otherIdx = idx === 0 ? 1 : 0;
  await expect(
    page.getByText(`ISO-W${otherIdx}-supp`, { exact: false })
  ).toHaveCount(0);

  // Belt-and-braces: open THIS worker's DB directly and confirm the sibling's
  // marker is not present in this DB either.
  const db = new Database(workerServer.dbPath, { readonly: true });
  try {
    const mine = db
      .prepare("SELECT COUNT(*) AS n FROM intake_items WHERE name = ?")
      .get(marker) as { n: number };
    const theirs = db
      .prepare("SELECT COUNT(*) AS n FROM intake_items WHERE name = ?")
      .get(`ISO-W${otherIdx}-supp`) as { n: number };
    expect(mine.n).toBeGreaterThan(0);
    expect(theirs.n).toBe(0);
  } finally {
    db.close();
  }
}

test("write in one worker is invisible to the other — case A", async ({
  page,
  workerServer,
}, testInfo) => {
  await writeAndAssertIsolation(page, workerServer, testInfo.parallelIndex);
});

test("write in one worker is invisible to the other — case B", async ({
  page,
  workerServer,
}, testInfo) => {
  await writeAndAssertIsolation(page, workerServer, testInfo.parallelIndex);
});
