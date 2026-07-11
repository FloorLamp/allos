import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// The isolated e2e DB path (mirrors the default in playwright.config.ts). The test
// process gets no ALLOS_DB_PATH override, so it resolves to the same file the
// webServer booted against. A raw connection (not lib/db) avoids re-running
// migrate()/bootstrap side effects on import.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

// Visit detail + timeline deeplink. The seed (scripts/seed)
// plants a recent "Office Visit" encounter with a chief complaint ("Annual physical")
// and diagnoses ("Essential hypertension; Hyperlipidemia"). We assert a Timeline
// visit entry deep-links to /encounters/[id], and that the detail page renders the
// captured fields (proving the page actually mounts, not just that the route exists).
test.describe("Visit detail page", () => {
  test("a timeline visit entry deep-links to its detail page", async ({
    page,
  }) => {
    // Filter the timeline to visits so the entry is unambiguous.
    await page.goto("/timeline?category=visit");

    // The most recent visit renders as a clickable entry titled by its type, whose
    // link targets the new per-visit detail route (not the old list page).
    const visitLink = page.getByRole("link", { name: "Office Visit" }).first();
    await expect(visitLink).toBeVisible();
    expect(await visitLink.getAttribute("href")).toMatch(/^\/encounters\/\d+$/);

    await visitLink.click();
    await expect(page).toHaveURL(/\/encounters\/\d+$/);

    // The detail page renders the visit's captured detail.
    const detail = page.getByTestId("encounter-detail");
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId("encounter-reason")).toHaveText(
      "Annual physical"
    );
    await expect(detail.getByTestId("encounter-diagnoses")).toContainText(
      "Essential hypertension"
    );
    // Back-link returns to the Visits list.
    await expect(
      detail.getByRole("link", { name: "Back to visits" })
    ).toBeVisible();
  });

  test("the Visits list row links to the detail page", async ({ page }) => {
    await page.goto("/encounters");
    // EncounterList is a client component; clicking a row's <Link> before it
    // hydrates swallows the client navigation (the URL never changes). Wait for
    // the network to settle so hydration has run, then assert the link resolved
    // to its detail href before clicking — so the click always navigates.
    await page.waitForLoadState("networkidle");
    const rowLink = page.getByRole("link", { name: "Office Visit" }).first();
    await expect(rowLink).toBeVisible();
    await expect(rowLink).toHaveAttribute("href", /\/encounters\/\d+$/);
    await rowLink.click();
    await expect(page).toHaveURL(/\/encounters\/\d+$/);
    await expect(page.getByTestId("encounter-detail")).toBeVisible();
  });
});

// Issue #211: on the detail page the "View source document" link (only shown when the
// encounter carries a document_id) was placed INLINE beside the Source label value, so
// it read as a stray button jammed against the source name. It should sit on its own
// line below the label. The seeded visits have no document_id, so this spec plants a
// throwaway encounter linked to a throwaway medical_documents row (profile 1 — the
// e2e session's active profile), asserts the link stacks below the label, then removes
// both rows so the shared e2e DB stays clean.
test.describe("Visit detail — source document link placement (#211)", () => {
  // Unique markers so cleanup targets exactly this spec's rows.
  const DOC_FILENAME = "e2e-issue-211-source.pdf";
  const ENC_EXTERNAL_ID = "e2e-issue-211-encounter";
  let encounterId = 0;

  test.beforeAll(() => {
    const handle = new Database(DB_PATH);
    try {
      const doc = handle
        .prepare(
          `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status)
           VALUES (1, ?, ?, 'done')`
        )
        .run(DOC_FILENAME, `uploads/medical/1/${DOC_FILENAME}`);
      const docId = Number(doc.lastInsertRowid);
      // Relative date so the fixture never ages out of any window.
      const date = new Date().toISOString().slice(0, 10);
      const enc = handle
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, source, document_id, external_id)
           VALUES (1, ?, 'Office Visit', 'extracted', ?, ?)`
        )
        .run(date, docId, ENC_EXTERNAL_ID);
      encounterId = Number(enc.lastInsertRowid);
    } finally {
      handle.close();
    }
  });

  test.afterAll(() => {
    const handle = new Database(DB_PATH);
    try {
      handle
        .prepare("DELETE FROM encounters WHERE external_id = ?")
        .run(ENC_EXTERNAL_ID);
      handle
        .prepare("DELETE FROM medical_documents WHERE filename = ?")
        .run(DOC_FILENAME);
    } finally {
      handle.close();
    }
  });

  test("the View source document link sits on its own line below the label", async ({
    page,
  }) => {
    await page.goto(`/encounters/${encounterId}`);

    // Scope to the primary content region so a doubled shell testid can't confuse us.
    const main = page.getByRole("main");
    await expect(main.getByTestId("encounter-detail")).toBeVisible();

    const source = main.getByTestId("encounter-source");
    const link = main.getByRole("link", { name: "View source document" });
    await expect(source).toBeVisible();
    await expect(link).toBeVisible();

    const sourceBox = await source.boundingBox();
    const linkBox = await link.boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(linkBox).not.toBeNull();

    // The link starts at or below the bottom of the source label — a real vertical
    // stack, not an inline button beside it (the pre-fix bug).
    expect(linkBox!.y).toBeGreaterThanOrEqual(sourceBox!.y + sourceBox!.height);
    // …and shares the label's left edge (same column), confirming the stack.
    expect(Math.abs(linkBox!.x - sourceBox!.x)).toBeLessThan(4);
  });
});
