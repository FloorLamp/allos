import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { settledFill } from "./helpers";
import { workerDbPath } from "./worker-env";

// Local form drafts (issue #1699), driven end-to-end — because "survives a reload"
// is a claim only a browser can settle. Three things are proved here:
//
//   1. a half-entered WORKOUT (the motivating case: nothing savable yet, so the
//      server auto-save has nothing to hold) survives a reload and comes back
//      through an explicit Resume — never silently applied;
//   2. a long record form (the supplement add form, with its state-only dose rows)
//      round-trips the same way, submits, and leaves NO draft behind — a stale draft
//      resurrecting a submitted record would be #1699 inverted;
//   3. a LIVE session's draft is dropped the moment the server copy is current —
//      the draft runs in live mode (it is the net when the server backing fails,
//      see e2e/stale-build-save.spec.ts) but never OUTLIVES a successful save,
//      which is what keeps #451's competing-source-of-truth concern answered.
//
// Fixture discipline (#868): every row this spec creates is deleted by value in a
// finally, keyed on names nothing else uses.

const DB_PATH = workerDbPath();
const WORKOUT_TITLE = "Draft net session";
const LIVE_TITLE = "Draft net live";
const SUPPLEMENT_NAME = "Draftnet Zinc";

// The debounced draft write (600ms) has no UI of its own, so the honest wait is on
// the store itself. Named ceiling per the e2e-hygiene census.
const DRAFT_SETTLE_MS = 20_000;

type DraftRow = { key: string; extra: Record<string, unknown> | null };

/** Every draft row currently in the browser's allos-offline database. */
async function draftRows(page: Page): Promise<DraftRow[]> {
  return page.evaluate(
    () =>
      new Promise<DraftRow[]>((resolve) => {
        const req = indexedDB.open("allos-offline");
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("drafts")) {
            db.close();
            resolve([]);
            return;
          }
          const all = db
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .getAll();
          all.onerror = () => {
            db.close();
            resolve([]);
          };
          all.onsuccess = () => {
            const rows = (all.result ?? []).map(
              (r: { key: string; extra: Record<string, unknown> | null }) => ({
                key: String(r.key),
                extra: r.extra ?? null,
              })
            );
            db.close();
            resolve(rows);
          };
        };
      })
  );
}

function activityDrafts(rows: DraftRow[]): DraftRow[] {
  return rows.filter((r) => r.key.includes(":activity:"));
}

function deleteActivitiesTitled(...titles: string[]) {
  const h = new Database(DB_PATH);
  try {
    for (const title of titles) {
      // Child rows (exercise components, routes, videos) cascade off the activity —
      // the same one-statement cleanup the other activity-owning specs use.
      h.prepare("DELETE FROM activities WHERE title = ?").run(title);
    }
  } finally {
    h.close();
  }
}

function deleteSupplement(name: string) {
  const h = new Database(DB_PATH);
  try {
    const rows = h
      .prepare("SELECT id FROM intake_items WHERE name = ?")
      .all(name) as { id: number }[];
    for (const { id } of rows) {
      h.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(id);
      h.prepare("DELETE FROM intake_items WHERE id = ?").run(id);
    }
  } finally {
    h.close();
  }
}

async function openNewActivity(page: Page) {
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
  await expect(page.getByTestId("activity-form")).toBeVisible();
}

test("a half-entered workout survives a reload and comes back on request (#1699)", async ({
  page,
}) => {
  test.slow();
  try {
    await page.goto("/training");
    await openNewActivity(page);

    // A workout with a name but no exercise yet is NOT savable, so the server
    // auto-save (#1189) holds nothing — this is exactly the window #1699 is about,
    // and before this change a reload here lost the lot.
    await settledFill(page, page.getByLabel("Activity name"), WORKOUT_TITLE);

    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the debounced draft autosave to reach IndexedDB",
      })
      .toBe(1);

    // The interruption: a reload is every cause at once (a deploy takeover, a
    // crash, a back-swipe, an iOS tab eviction).
    await page.reload();
    await openNewActivity(page);

    // NOT silently applied — the form comes up empty and the draft announces itself.
    await expect(page.getByLabel("Activity name")).toHaveValue("");
    const banner = page.getByTestId("draft-restore-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("kept on this device");

    // The user's tap is what restores it.
    await banner.getByTestId("draft-restore-resume").click();
    await expect(page.getByLabel("Activity name")).toHaveValue(WORKOUT_TITLE);
    await expect(banner).toHaveCount(0);

    // Finish the workout for real. Picking a known activity + a duration makes it
    // savable, so the auto-save creates the row — and the Delete button appearing
    // is the proof that it persisted.
    await page.getByPlaceholder(/What did you do/).fill("Running");
    await page
      .getByRole("listbox")
      .getByRole("button", { name: "Running", exact: true })
      .click();
    await settledFill(page, page.getByTestId("cardio-duration"), "30");
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible({ timeout: DRAFT_SETTLE_MS });

    // Saved ⇒ no draft may survive. A stale one would offer to re-enter a workout
    // that is already in the journal.
    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the draft to be cleared once the server copy is current",
      })
      .toBe(0);

    await page.keyboard.press("Escape");
    await page.reload();
    await openNewActivity(page);
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
  } finally {
    deleteActivitiesTitled(WORKOUT_TITLE);
  }
});

test("Discard throws the draft away for good (#1699)", async ({ page }) => {
  try {
    await page.goto("/training");
    await openNewActivity(page);
    await settledFill(page, page.getByLabel("Activity name"), WORKOUT_TITLE);
    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the debounced draft autosave to reach IndexedDB",
      })
      .toBe(1);

    await page.reload();
    await openNewActivity(page);
    await page.getByTestId("draft-restore-discard").click();
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
    await expect(page.getByLabel("Activity name")).toHaveValue("");

    // Gone from the store too, so reopening never re-offers it.
    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the discarded draft to leave IndexedDB",
      })
      .toBe(0);
    await page.reload();
    await openNewActivity(page);
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
  } finally {
    deleteActivitiesTitled(WORKOUT_TITLE);
  }
});

test("a long record form restores its state-only rows, then clears on submit (#1699)", async ({
  page,
}) => {
  test.slow();
  try {
    await page.goto("/nutrition?tab=supplements");
    await page.getByTestId("supplement-add-toggle").click();
    const addCard = page.getByRole("dialog", { name: "Add supplement" });
    await addCard.getByLabel("Name").fill(SUPPLEMENT_NAME);
    // The dose rows never exist as named inputs — they are React state serialized
    // into FormData at submit — so this is the `extra` half of the draft.
    await addCard.getByLabel("Amount").first().fill("25 mg"); // first-ok: this form's own first dose row, one render, not a seeded list
    await addCard.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: same row

    await expect
      .poll(
        async () =>
          (await draftRows(page)).filter((r) => r.key.includes(":supplement:"))
            .length,
        {
          timeout: DRAFT_SETTLE_MS,
          message: "the supplement draft to reach IndexedDB",
        }
      )
      .toBe(1);

    await page.reload();
    await page.getByTestId("supplement-add-toggle").click();
    const reopened = page.getByRole("dialog", { name: "Add supplement" });
    await expect(reopened.getByLabel("Name")).toHaveValue("");
    await reopened.getByTestId("draft-restore-resume").click();

    await expect(reopened.getByLabel("Name")).toHaveValue(SUPPLEMENT_NAME);
    await expect(reopened.getByLabel("Amount").first()).toHaveValue("25 mg"); // first-ok: this form's own first dose row
    const timeOfDay = reopened.getByLabel("Time of day").first(); // first-ok: this form's own first dose row, one render, not a seeded list
    await expect(timeOfDay).toHaveValue("Morning");

    await reopened.getByRole("button", { name: "Add", exact: true }).click();
    await expect(reopened).toHaveCount(0);
    await expect(page.getByText(SUPPLEMENT_NAME).first()).toBeVisible(); // first-ok: the row this spec just created

    // Submitted ⇒ the draft is gone, and reopening the add form offers nothing.
    await expect
      .poll(
        async () =>
          (await draftRows(page)).filter((r) => r.key.includes(":supplement:"))
            .length,
        {
          timeout: DRAFT_SETTLE_MS,
          message: "the draft to be cleared by the successful submit",
        }
      )
      .toBe(0);
    await page.getByTestId("supplement-add-toggle").click();
    await expect(
      page
        .getByRole("dialog", { name: "Add supplement" })
        .getByTestId("draft-restore-banner")
    ).toHaveCount(0);
  } finally {
    deleteSupplement(SUPPLEMENT_NAME);
  }
});

test("a live session's draft never outlives a successful save (#1699/#451)", async ({
  page,
}) => {
  test.slow();
  try {
    await page.goto("/training");
    await page.getByRole("main").getByTestId("start-workout").click();
    await expect(page.getByTestId("live-workout-panel")).toBeVisible();

    await settledFill(page, page.getByLabel("Activity name"), LIVE_TITLE);
    await page.getByPlaceholder(/What did you do/).fill("Barbell Bench Press");
    await page
      .getByRole("listbox")
      .getByRole("button")
      .filter({ hasText: "Barbell Bench Press" })
      .first() // first-ok: transient combobox list this spec just opened by typing
      .click();
    const weight = page.getByTestId("set1-weight");
    await page
      .getByTestId("next-set-card")
      .getByRole("button", { name: "Use" })
      .click();
    await expect(weight).toHaveValue(/^\d/);

    // The server row appearing is the positive signal that the live session is
    // durable. The draft runs in live mode too (it is the only copy when the
    // server backing fails — e2e/stale-build-save.spec.ts drives that), but the
    // clear-on-success effect drops it the moment the server copy is current, so
    // the store settles EMPTY while saves are landing.
    await expect(
      page.getByRole("button", { name: "Delete", exact: true })
    ).toBeVisible({ timeout: DRAFT_SETTLE_MS });
    await expect
      .poll(async () => activityDrafts(await draftRows(page)).length, {
        timeout: DRAFT_SETTLE_MS,
        message: "the live draft to be dropped once the server copy is current",
      })
      .toBe(0);

    // …and a plain create form opened afterwards has nothing to offer, which is the
    // observable form of "the live session left no draft behind".
    await page.keyboard.press("Escape");
    await page.reload();
    await openNewActivity(page);
    await expect(page.getByTestId("draft-restore-banner")).toHaveCount(0);
  } finally {
    deleteActivitiesTitled(LIVE_TITLE);
  }
});
