import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
import { workerAuthPath, workerDbPath } from "./worker-env";
import { withVisitFact } from "./visit-form-helpers";

// Who a pull-to-refresh belongs to while a record form holds unsaved input
// (issues #1878, #2725, #2774).
//
// ── THE RULING THIS SPEC WAS UPDATED TO (#2774, consequence A) ───────────────
//
// It used to pin the opposite: that a pull STILL refreshes while a ModalShell
// record form holds unsaved input. That was correct for the tree it was written
// against and is deliberately flipped here — DO NOT "fix" it back.
//
// The reason is not a change of mind about #1878. It is that the surface
// changed. ModalShell was a centred card with no gesture of any kind, so a pull
// under it could not be anybody else's gesture; #2774 converged its consumers
// onto the responsive sheet primitive, which is a BODY-LOCKING, DRAG-OWNING
// surface. `lib/pull-to-refresh.ts`'s clause 1 asks exactly one question — does
// an overlay own the vertical drag — and the honest answer for these surfaces is
// now yes. Standing down is that rule applying, not a new attention heuristic
// sneaking in through the back door.
//
// #1878's spirit survives intact, in three pieces this spec pins:
//
//   1. NO SILENT DEFERRAL. The pull under the sheet is REFUSED, not queued: the
//      registry never hears about it (`data-owed` stays 0), so there is no
//      swallowed request sitting in a queue the user cannot see.
//   2. THE RECOURSE IS ONE GESTURE AWAY. Close the sheet and pull: it refreshes
//      immediately. Nothing about the page is stuck.
//   3. THE INSTALLED-APP CONCERN — "there is no URL bar, so a pull is the only
//      way to ask" — is answered by #2471: deploys reload themselves.
//
// ── The half that did not change ─────────────────────────────────────────────
//
// The CHROME's refresh is still deferred while a form is dirty, and it is still
// deferred by WHO ASKED rather than by anything about the page: the toasters'
// poll observes over a route handler so only `useChromeRefresh` can repaint, and
// its repaint sits owed while the same form is dirty. Both actors fire in the
// same breath on one page here, which is what makes this a spec about ownership
// rather than two unrelated assertions.
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

test("a pull stands down under a converged record sheet, and refreshes the moment it closes", async ({
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

    // CONTROL, before anything is open: the pull works on this page, in this
    // context, at this scroll position. Without it "it did not refresh" below
    // would be satisfied by a gesture that never armed for some unrelated
    // reason — the cheaper question wearing the same green.
    await pullDown(page, 200);
    await expect(indicator).toHaveAttribute("data-refreshes", "1");

    // Make the form genuinely dirty, inside the converged dialog — which on a
    // phone is a body-locking, drag-owning sheet.
    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    // The title sits behind a fact chip now (#3223), and its panel is CLOSED again
    // before the registry is asked — which is the state that matters here. A field
    // whose panel unmounted would be invisible to the registry, and a field bound to
    // React state could never be dirty at all (React syncs `defaultValue` onto a
    // controlled field, and the registry reads `defaultValue` as the saved value).
    await withVisitFact(dialog, "reason", async () => {
      const title = dialog.getByLabel("Reason / title");
      await expect(title).toBeVisible();
      await title.fill("E2E pull-under-sheet visit");
    });
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // THE FLIPPED PIN. The sheet owns the vertical drag, so the pull does not
    // arm at all: the count stays where the control left it.
    await pullDown(page, 200);
    await expect(indicator).toHaveAttribute("data-refreshes", "1");
    // And it was REFUSED, not queued: nothing entered the registry, so there is
    // no swallowed request the user cannot see. That is #1878's actual
    // requirement, and it still holds.
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "0");

    // The form is still dirty. Now the CHROME acts, on the same page, in the same
    // breath: the background extraction finishes and the toaster's poll sees it.
    // Its repaint is owed — deferred by WHO asked, exactly as before.
    finishDocument();
    await expect(page.getByText(`${DOC}: imported 2 records.`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(registry).toHaveAttribute("data-owed", "1");
    await expect(registry).toHaveAttribute("data-refreshes", "0");

    // THE RECOURSE. Close the sheet and pull again: the page is released and the
    // refresh the user asked for happens immediately. This is the half that
    // keeps the stand-down from being a dead end.
    await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
    await expect(dialog).toHaveCount(0);
    await pullDown(page, 200);
    await expect(indicator).toHaveAttribute("data-refreshes", "2");
  } finally {
    await context.close();
  }
});
