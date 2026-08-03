import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick, settledFill } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";

// The dirty-form registry, end to end (issue #1878).
//
// THE FAILURE THIS PINS. A background chrome refresh — here the extraction
// toaster's poll noticing a document finish, exactly the class named in the
// issue — re-renders the Server Components under whatever record form the user
// happens to have open. The observed casualty (#1552 → #1877) was the Add-visit
// form: the appointment saved TITLELESS, the write "succeeding" with a hollow
// row. So this drives the real form, takes a real chrome refresh mid-edit, and
// asserts the two things that actually matter to a person: the typed text is
// still there, and the row that gets created carries it.
//
// It also pins the contract underneath, because "the text survived" alone cannot
// distinguish a deferral from a refresh that happened to be harmless:
//   • while the form holds unsaved input the repaint is OWED, not run, and
//   • the moment the form releases (its own submit) the owed repaint LANDS —
//     deferred is never dropped.
// Those counters are the registry's observable contract, the same reason
// PullToRefresh carries `data-refreshes`.
//
// THE POLL ITSELF (the #1878 ruling that closed #1925's residual). `router.refresh()`
// is not the only way a chrome tick repaints: a Server Action's response carries a
// freshly rendered tree the client applies, and the toasters used to poll one. The
// third test below drives that directly — it writes a row BEHIND the page, lets the
// poll observe a finished extraction, and asserts the row is absent from the tree
// while `data-owed` is 1. That assertion failed before the poll moved onto a route
// handler, and it is what separates "deferred" from "merely slow".
//
// The complementary half — a USER-initiated refresh must never defer — is
// e2e/dirty-form-refresh.mobile.spec.ts, which needs the standalone PWA context
// that pull-to-refresh only exists in.
//
// Spec-owned fixture: one medical document it inserts and deletes, and one
// appointment identified by a unique marker.

const DB_PATH = workerDbPath();
const MARKER = "E2E dirty-form dermatology follow-up";
// A row written BEHIND the page, so "did the tree repaint?" is answerable from
// the outside: it can only be on screen if the server re-rendered the list.
const BEHIND = "E2E dirty-form poll-behind cardiology review";
const DOC = "e2e-dirty-form-extraction.pdf";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM appointments WHERE title IN (?, ?)")
      .run(MARKER, BEHIND);
    handle.prepare("DELETE FROM medical_documents WHERE filename = ?").run(DOC);
  } finally {
    handle.close();
  }
}

/**
 * Write an appointment straight into the worker DB — the "new server data" a
 * repaint would deliver. Dated from the FROZEN clock so it lands in the upcoming
 * list the page renders.
 */
function seedAppointmentBehindThePage() {
  const when = new Date(frozenNow().getTime() + 3 * 24 * 3600 * 1000);
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare(
        `INSERT INTO appointments (profile_id, scheduled_at, title, status)
         VALUES (1, ?, ?, 'scheduled')`
      )
      .run(when.toISOString().slice(0, 19).replace("T", " "), BEHIND);
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
            SET extraction_status = 'done', extracted_count = 3
          WHERE filename = ?`
      )
      .run(DOC);
  } finally {
    handle.close();
  }
}

test.describe("Chrome refreshes wait for a half-typed record form (#1878)", () => {
  // Per-test, not per-file: both tests seed the same document filename, and a
  // leftover row would make the completion toast ambiguous.
  test.beforeEach(cleanup);
  test.afterAll(cleanup);

  test("a background extraction finishing mid-edit cannot empty the Add-visit form", async ({
    page,
  }) => {
    test.slow();
    seedProcessingDocument();

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    const registry = page.getByTestId("dirty-form-registry");
    // Nothing is dirty on a freshly loaded page: the registry keys on genuinely
    // unsaved input, never on mount. A form that registered at mount would
    // suppress every background refresh for the life of the page.
    await expect(registry).toHaveAttribute("data-dirty", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "0");

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    const title = dialog.getByLabel("Reason / title");
    await expect(title).toBeVisible();

    // Opening and focusing the form is still not unsaved input.
    await title.click();
    await expect(registry).toHaveAttribute("data-dirty", "0");

    await title.fill(MARKER);
    await dialog.getByLabel("Provider").fill("E2E Dirty Form Clinic");
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // The background event: the document the user uploaded earlier finishes
    // extracting. The toaster notices by polling and asks for a repaint.
    finishDocument();
    await expect(page.getByText(`${DOC}: imported 3 records.`)).toBeVisible({
      timeout: 20_000,
    });

    // THE FIX: that repaint is owed, not taken. It cannot land on the form.
    await expect(registry).toHaveAttribute("data-owed", "1");
    await expect(registry).toHaveAttribute("data-refreshes", "0");

    // THE POINT: what the user typed is still what the form holds.
    await expect(title).toHaveValue(MARKER);
    await expect(dialog.getByLabel("Provider")).toHaveValue(
      "E2E Dirty Form Clinic"
    );

    // And it is what gets saved — the row is created WITH its title, not hollow.
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: MARKER });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // The submit released the form, so the owed repaint DRAINED. A deferral that
    // forgot its debt would leave the page quietly stale forever.
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(registry).toHaveAttribute("data-dirty", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "1");

    // The persisted row carries the title. This is the assertion the CI artifact
    // in #1552 would have failed.
    const handle = new Database(DB_PATH);
    try {
      const saved = handle
        .prepare("SELECT title FROM appointments WHERE title = ?")
        .get(MARKER) as { title: string } | undefined;
      expect(saved?.title).toBe(MARKER);
    } finally {
      handle.close();
    }
  });

  test("a poll that observes a finished job does not repaint the tree under a dirty form", async ({
    page,
  }) => {
    test.slow();
    seedProcessingDocument();

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();
    const registry = page.getByTestId("dirty-form-registry");
    const behind = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: BEHIND });
    await expect(behind).toHaveCount(0);

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    const title = dialog.getByLabel("Reason / title");
    await settledFill(page, title, MARKER);
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // Two background events at once, which is the realistic shape: the extraction
    // the user kicked off earlier finishes, and the data behind the page has moved
    // on meanwhile.
    seedAppointmentBehindThePage();
    finishDocument();

    // OBSERVATION IS NOT DEFERRED. The toast is proof the poll ran, saw the
    // transition and reported it — while the form was dirty. That is the half of
    // the ruling that says a deferred poll must not stall the poll loop: the user
    // still learns their extraction finished at the moment it does.
    await expect(page.getByText(`${DOC}: imported 3 records.`)).toBeVisible({
      timeout: 20_000,
    });

    // THE REPAINT IS DEFERRED. Owed, not run — so the appointment written behind
    // the page is NOT in the rendered tree. This assertion is the whole point:
    // before the poll observed over a route handler it FAILED, because the poll's
    // own Server Action response carried a freshly rendered tree that the client
    // applied with `data-refreshes` still 0.
    await expect(registry).toHaveAttribute("data-owed", "1");
    await expect(registry).toHaveAttribute("data-refreshes", "0");
    await expect(behind).toHaveCount(0);

    // The user finishes with the field (undone, not submitted — this test never
    // writes through the UI). The owed repaint lands, once, CARRYING the new row:
    // deferred was never dropped, and what finally arrives is current data rather
    // than a replay of the moment that asked for it.
    await title.fill("");
    await title.blur();
    await expect(registry).toHaveAttribute("data-dirty", "0");
    await expect(registry).toHaveAttribute("data-refreshes", "1");
    await expect(registry).toHaveAttribute("data-owed", "0");
    await expect(behind).toHaveCount(1, { timeout: 15_000 });
  });

  test("a form the user empties again stops holding refreshes back", async ({
    page,
  }) => {
    test.slow();
    seedProcessingDocument();

    await page.goto("/records/history/visits");
    await expect(page.getByTestId("visits-upcoming")).toBeVisible();
    const registry = page.getByTestId("dirty-form-registry");

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const dialog = page.getByRole("dialog", { name: "Add visit" });
    const title = dialog.getByLabel("Reason / title");
    await expect(title).toBeVisible();

    await title.fill("typed, then thought better of it");
    await expect(registry).toHaveAttribute("data-dirty", "1");

    // Cleared and blurred: there is no unsaved input left to protect, so the
    // registry must let go. This is the release-on-blur-empty rule — without it
    // one abandoned form would suppress background refreshes forever.
    await title.fill("");
    await title.blur();
    await expect(registry).toHaveAttribute("data-dirty", "0");

    // With nothing dirty, a chrome refresh behaves exactly as it always did.
    finishDocument();
    await expect(page.getByText(`${DOC}: imported 3 records.`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(registry).toHaveAttribute("data-refreshes", "1");
    await expect(registry).toHaveAttribute("data-owed", "0");
  });
});
