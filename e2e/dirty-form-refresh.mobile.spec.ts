import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { workerAuthPath, workerDbPath } from "./worker-env";

// The complementary half of the dirty-form registry (issue #1878): a refresh the
// USER asked for is never deferred.
//
// Pull-to-refresh is the sharpest case. It exists only in the installed PWA,
// where there is no URL bar and therefore no other way to say "give me current
// data" — a gesture whose entire meaning is that request. Swallowing it because
// some form on the page is dirty would be its own bug, and a worse one than the
// wipe: the user would pull, see nothing happen, and have no recourse.
//
// So the distinction is an opt-in at the call site, not a heuristic: the chrome
// actors call `useChromeRefresh`, PullToRefresh keeps calling `router.refresh()`
// itself. This spec proves that from the outside — with a record form genuinely
// dirty, the pull still refreshes, and the registry never even hears about it
// (`data-owed` stays 0, so nothing was queued and silently swallowed).
//
// Since the #1878 ruling the chrome half includes the toasters' POLL, which now
// observes over a route handler so only `useChromeRefresh` can repaint. That makes
// this spec sharper rather than redundant: one page, one dirty form, both actors
// firing — the user's pull goes through immediately, and the poll's repaint sits
// owed at the same moment. Neither behaviour is inferable from the other.
//
// The two emulation seams (standalone display-mode, and counting refreshes at
// all) are the ones e2e/pull-to-refresh.mobile.spec.ts documents; this reuses
// them. Read-only through the UI: it types into a form and never submits.
//
// Spec-owned fixture: one medical document it inserts and deletes.

const INDICATOR = "pull-to-refresh";
const DB_PATH = workerDbPath();
const DOC = "e2e-dirty-form-pull.pdf";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle.prepare("DELETE FROM medical_documents WHERE filename = ?").run(DOC);
  } finally {
    handle.close();
  }
}

/** Park a document mid-extraction so the toaster polls at its fast cadence. */
function seedProcessingDocument() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, extracted_count)
         VALUES (1, ?, ?, 'processing', 0)`
      )
      .run(DOC, `data/uploads/${DOC}`);
  } finally {
    handle.close();
  }
}

/** Finish it, from outside the browser — the background event the chrome reacts to. */
function finishDocument() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `UPDATE medical_documents
            SET extraction_status = 'done', extracted_count = 2
          WHERE filename = ?`
      )
      .run(DOC);
  } finally {
    handle.close();
  }
}

async function emulateStandalone(page: Page) {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => {
      if (query !== "(display-mode: standalone)") return real(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  });
}

async function pullDown(page: Page, distance: number) {
  await page.evaluate((dy) => {
    const startY = 200;
    const touch = (y: number) =>
      new Touch({
        identifier: 1,
        target: document.body,
        clientX: 195,
        clientY: y,
      });
    const fire = (type: string, y: number, ending = false) =>
      window.dispatchEvent(
        new TouchEvent(type, {
          touches: ending ? [] : [touch(y)],
          targetTouches: ending ? [] : [touch(y)],
          changedTouches: [touch(y)],
          bubbles: true,
          cancelable: true,
        })
      );
    fire("touchstart", startY);
    for (const step of [0.3, 0.6, 1]) fire("touchmove", startY + dy * step);
    fire("touchend", startY + dy, true);
  }, distance);
}

test.beforeEach(cleanup);
test.afterAll(cleanup);

test("a pull-to-refresh still refreshes while a record form holds unsaved input", async ({
  browser,
}) => {
  test.slow();
  seedProcessingDocument();
  const context = await browser.newContext({
    // A raw context does not inherit the `mobile` project's `use` block.
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    storageState: workerAuthPath(),
  });
  const page = await context.newPage();
  await emulateStandalone(page);
  try {
    await page.goto("/records/history/visits");
    await expect(page.getByTestId("visits-upcoming")).toBeVisible();

    const indicator = page.getByTestId(INDICATOR);
    const registry = page.getByTestId("dirty-form-registry");
    await expect(indicator).toHaveAttribute("data-refreshes", "0");
    await expect(registry).toHaveAttribute("data-dirty", "0");

    // Make the form genuinely dirty — the exact state that defers a CHROME
    // refresh.
    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    const title = dialog.getByLabel("Reason / title");
    await expect(title).toBeVisible();
    await title.fill("E2E pull-through-dirty visit");
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // The user asks for current data anyway.
    await pullDown(page, 200);

    // It happened. Counting the calls is what makes this a fact rather than an
    // absence of symptoms.
    await expect(indicator).toHaveAttribute("data-refreshes", "1");
    // And it never entered the registry: nothing was owed, so nothing was
    // queued-and-swallowed on the way.
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "0");

    // The form is still dirty. Now the CHROME acts, on the same page, in the same
    // breath: the background extraction finishes and the toaster's poll sees it.
    // Its repaint is owed — the opposite treatment from the pull above, decided by
    // WHO asked rather than by anything about the page.
    finishDocument();
    await expect(page.getByText(`${DOC}: imported 2 records.`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(registry).toHaveAttribute("data-owed", "1");
    await expect(registry).toHaveAttribute("data-refreshes", "0");
    // The user's pull is untouched by any of it — still exactly the one refresh
    // they asked for, never re-run and never rolled into the chrome's debt.
    await expect(indicator).toHaveAttribute("data-refreshes", "1");
  } finally {
    await context.close();
  }
});
