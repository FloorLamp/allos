import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { followLink, settledClick } from "./helpers";

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
    const visitLink = page.getByRole("link", { name: "Office Visit" }).first(); // first-ok: opens an Office Visit encounter detail (asserts the detail's structure, not a specific one) — order-agnostic
    await expect(visitLink).toBeVisible();
    expect(await visitLink.getAttribute("href")).toMatch(/^\/encounters\/\d+$/);

    // The Timeline entry is a Next <Link>; a click landing in the pre-hydration
    // window is swallowed (the URL never advances — #500/#830). followLink retries
    // until the detail route commits (#868).
    await followLink(page, visitLink, /\/encounters\/\d+$/);

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
    await page.goto("/records/history/visits");
    // EncounterList is a client component; clicking a row's <Link> before it
    // hydrates swallows the client navigation (the URL never changes). followLink
    // retries the click until the router commits the detail URL — no networkidle
    // hydration gate needed (#868).
    const rowLink = page.getByRole("link", { name: "Office Visit" }).first(); // first-ok: opens an Office Visit encounter detail (asserts the detail's structure, not a specific one) — order-agnostic
    await expect(rowLink).toHaveAttribute("href", /\/encounters\/\d+$/);
    await followLink(page, rowLink, /\/encounters\/\d+$/);
    await expect(page.getByTestId("encounter-detail")).toBeVisible();
  });
});

// The single "Add visit" entry (issue #566): switching the tense toggle to "Already
// happened" and entering a past date logs a real encounter that lands in the Past
// section — the encounter branch end-to-end (the appointment branch is covered by
// visits-lifecycle.spec). Self-cleaning via a unique reason marker so the shared
// e2e DB stays pristine across CI retries (raw connection, like the specs above).
test.describe("Visits — single Add visit entry logs a past visit (#566)", () => {
  const MARKER = "E2E 566 logged past visit";

  function cleanup() {
    const handle = new Database(DB_PATH);
    try {
      handle.prepare("DELETE FROM encounters WHERE reason = ?").run(MARKER);
    } finally {
      handle.close();
    }
  }

  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("choosing 'Already happened' logs an encounter into Past", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits");
    const add = page.getByTestId("visits-add");
    await expect(add).toBeVisible();

    // Branch to the encounter (past) shape and fill it. A past date is entered
    // directly; the toggle already selected the encounter branch.
    await add.getByTestId("visit-tense-past").click();
    await add.getByLabel("Visit type").fill("Office Visit");
    await add.getByLabel("Date", { exact: true }).fill("2024-03-04");
    await add.getByLabel("Reason (chief complaint)").fill(MARKER);
    // The Add button submits a Server Action that logs the encounter and
    // revalidates; settledClick awaits that POST so the "Visit saved" assertion
    // can't race the action (#868).
    await settledClick(
      page,
      add.getByRole("button", { name: "Add", exact: true })
    );
    await expect(page.getByText("Visit saved")).toBeVisible();

    // The logged visit appears in the Past (visit-history) section by its reason.
    const past = page.getByTestId("visits-past");
    await expect(past.getByText(MARKER)).toBeVisible({ timeout: 15_000 });
  });
});

// Issue #794 (cluster 11a): imported/user notes are multi-line free text, but the
// encounter-detail Notes block used to render them bare — flattening line breaks to
// one run-on paragraph. They now render through <NotesText> with whitespace-pre-wrap
// + break-words. seed-events plants a fixed-id imported visit (9071) whose notes
// carry a real newline; this pins that the break survives in the DOM AND that the
// element is styled to display it (white-space: pre-wrap), not collapse it.
test.describe("Visit detail — multi-line notes render with line breaks (#794)", () => {
  test("imported notes preserve their line breaks", async ({ page }) => {
    await page.goto("/encounters/9071");

    const notes = page.getByRole("main").getByTestId("encounter-notes");
    await expect(notes).toBeVisible();
    await expect(notes).toContainText("E2E imported note line one.");
    await expect(notes).toContainText("E2E imported note line two.");

    // The newline is preserved in the text node…
    const text = await notes.textContent();
    expect(text).toContain("\n");
    // …and the element is styled to show it as a real break, not collapse it.
    const whiteSpace = await notes.evaluate(
      (el) => getComputedStyle(el).whiteSpace
    );
    expect(whiteSpace).toBe("pre-wrap");
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
