import { test, expect, type Page } from "@playwright/test";
import { openCommandPalette } from "./nav";

// Pick an activity in the editor's exercise combobox. The option button's text
// varies with the input state: a partial filter lists options as the name plus a
// muscle badge ("Barbell Bench Press" + "Chest"), while an EXACT typed match
// collapses the dropdown to a single 'Use "Barbell Bench Press"' button (curly
// quotes around the name). Neither shape carries the bare name as an exact text
// node or accessible name, so match by SUBSTRING — hasText covers both shapes,
// and badge-less cardio options too. (Ground truth from the aria snapshot of the
// live component; see PR #547 review thread.)
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first()
    .click();
}

// Issue #29: data-entry ergonomics — the three affordances end-to-end against the
// seeded DB.
//
//  1. Command-palette inline quick-log: `weight 84.3` parses (pure
//     parseQuickLog), previews, and Enter commits it through paletteQuickLog →
//     insertBodyMetric (the same write the Body form uses).
//  2. Repeat-last: a card's "Log again" opens a CREATE form pre-filled from the
//     stored activity; the seeded, complete session auto-saves as a NEW row.
//  3. Bulk table delete + undo: selecting rows in Data → Manage deletes them
//     through captureDelete (per row) and one "Undo" restores the whole batch.

test("command palette 'weight 84.3' logs a body metric (#29)", async ({
  page,
}) => {
  await page.goto("/");

  // Open the palette via the retrying helper — a raw Ctrl-K fired inside the
  // hydration window is swallowed (issue #500/#501; e2e/nav.ts).
  const input = await openCommandPalette(page);

  // Typing the quick-log syntax surfaces a preview row; the seed login is kg.
  await input.fill("weight 84.3");
  const preview = page.getByTestId("palette-quicklog");
  await expect(preview).toContainText("84.3 kg");

  // Enter commits it — the success toast is the end-to-end write confirmation.
  await input.press("Enter");
  await expect(page.getByText("Logged weight 84.3 kg.")).toBeVisible();

  // …and it lands in the Body tab's History table (kg, so the value shows
  // as-is). Assert against the weight cell's stable testid — rows are date-desc,
  // so today's just-logged entry is the first one — rather than free text, which
  // also matches the (visually hidden) chart axis/point labels.
  await page.goto("/trends?tab=body");
  await expect(page.getByTestId("body-weight-cell").first()).toContainText(
    "84.3"
  );
});

test("'Log again' pre-fills a create form that saves a new activity (#29)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The e2e seed plants a manual "Journal merge keeper" activity; repeat it.
  const titleCards = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Journal merge keeper" });
  await expect(titleCards.first()).toBeVisible();
  const before = await titleCards.count();

  // Open the first matching card's overflow (⋯) menu → "Log again".
  await titleCards
    .first()
    .getByRole("button", { name: "Activity actions" })
    .click();
  await page.getByTestId("log-again").click();

  // The editor opens pre-filled — its heading carries the source title.
  await expect(
    page.getByRole("heading", { name: "Journal merge keeper" })
  ).toBeVisible();

  // The prefilled, complete session auto-saves as a NEW row (dated today), so a
  // second card with the same title appears on the feed.
  await expect(titleCards).toHaveCount(before + 1);

  // Clean up the row this test just created: the editor is still open on it, so
  // delete it from there. The e2e DB is shared across specs (the harness seeds
  // once), and a lingering today-dated activity would (a) collide with the
  // journal-merge fixture's "Journal merge keeper" title and (b) add a new "Today"
  // day-group that shifts the journal's visible-day window, throwing off the
  // absolute card counts in journal-merge / undo-delete. Restoring the seed state
  // here keeps those specs order-independent.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(titleCards).toHaveCount(before);
});

test("'Repeat last' button is not clipped by the editor pane's scroll container (#103)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The button lives in the desktop editor aside's header row, which sits inside
  // a `sticky … overflow-y-auto` scroll container. Issue #103: the header's fixed
  // height was shorter than the bordered ghost button, so `items-center` pushed
  // the button's top above the row and the scroll container clipped it.
  const button = page.getByTestId("repeat-last");
  await expect(button).toBeVisible();

  // Regression: the button's top edge must not sit above its scrolling ancestor's
  // top edge (that overflow is exactly what got clipped).
  const container = button.locator(
    'xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]'
  );
  const btnBox = await button.boundingBox();
  const containerBox = await container.boundingBox();
  expect(btnBox).not.toBeNull();
  expect(containerBox).not.toBeNull();
  expect(btnBox!.y).toBeGreaterThanOrEqual(containerBox!.y - 0.5);

  // And it stays fully within the viewport and remains clickable.
  expect(btnBox!.y).toBeGreaterThanOrEqual(0);
  await expect(button).toBeEnabled();
});

test("edit mode surfaces the exercise's previous sessions (#188)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The seed plants recurring "Push day" strength sessions across several weeks,
  // each repeating the same lifts (Barbell Bench Press, …). Opening the NEWEST
  // one for edit — by clicking its title — must show the "Recent" reference
  // panel of prior sessions (issue #188: edit mode used to omit it entirely).
  const main = page.getByRole("main");
  const pushCard = main
    .locator('[id^="activity-"]')
    .filter({ hasText: "Push day" })
    .first();
  await expect(pushCard).toBeVisible();

  // Click the card's title to open the editor in EDIT mode (openEdit).
  await pushCard.getByRole("button", { name: "Push day" }).click();

  // The editor opens on the stored session — its header carries the title.
  await expect(page.getByRole("heading", { name: "Push day" })).toBeVisible();

  // A strength part renders its Recent panel of prior sessions. Deliberately
  // NOT scoped to <main>: the editor mounts either in the journal's dock
  // (inside <main>) or in the body-level overlay portal — the dock registers
  // in a post-hydration effect, so a click landing before that legitimately
  // falls back to the overlay (a timing the spec must not depend on). The
  // testid cannot double-render — there is exactly one editor instance — so
  // the #206 main-scoping rule doesn't apply here.
  const panel = page.getByTestId("recent-sessions").first();
  await expect(panel).toBeVisible();
  // …and it lists at least one prior session row (self-excluded: the session
  // being edited never appears in its own Recent list).
  await expect(panel.getByRole("listitem").first()).toBeVisible();

  // Read-only assertion: no field was touched, so nothing auto-saves and the
  // shared seed DB is left untouched — no cleanup needed. Close the editor.
  await page.keyboard.press("Escape");
});

test("logging a manual cardio activity auto-fills an editable estimated-calorie value (#151)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh create form. The "New activity" button lives in the Journal
  // header inside <main>; the editor it opens mounts either in the docked pane
  // (inside <main>) or the body-level overlay portal, so the form's own fields are
  // addressed by their unique testids/roles rather than main-scoped (there is
  // exactly one editor instance — same reasoning as the #206 recent-sessions spec).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // PICK a known cardio activity from the combobox — typing the name alone doesn't
  // resolve the part TYPE, so the cardio fields (and the shared estimate field) only
  // appear after an explicit selection commits the type.
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("button", { name: "Running", exact: true })
    .click();

  // A duration makes the estimate compute (MET dataset × the seeded profile's
  // bodyweight × duration). It also makes the activity savable, so it auto-saves —
  // the draft is deleted at the end to leave the shared seed DB untouched.
  await page.getByTestId("cardio-duration").fill("30");

  // The estimated-calorie field appears, marked "(estimated)", auto-filled with a
  // positive number.
  const field = page.getByTestId("est-calories-field");
  await expect(field).toBeVisible();
  await expect(field).toContainText("estimated");
  const input = page.getByTestId("est-calories-input");
  await expect(input).toHaveValue(/^[1-9]\d*$/);

  // It's editable — the user can override the auto value.
  await input.fill("123");
  await expect(input).toHaveValue("123");

  // Clean up: delete the just-created activity from the still-open editor. The
  // Delete button only appears once the auto-save has created the row, so waiting on
  // it also confirms the activity persisted. Restores the seed for later specs.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
});

test("a fresh strength part auto-seeds set 1 from the coached suggestion (#335)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Open a fresh create form (fields addressed by testid/role — see the
  // est-calories spec's note on why the editor isn't main-scoped).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // Pick a lift the seed trains repeatedly (Barbell Bench Press, weeks of
  // 60 kg → +1 kg/wk history) so a coached next-set suggestion exists.
  await pickActivity(page, "Barbell Bench Press");

  // The coached "Next set" card renders for a fresh part with history.
  await expect(page.getByText("Next set")).toBeVisible();

  // Set 1's weight shows the suggested load as a ghost PLACEHOLDER (a number,
  // not the bare "kg" unit) — the auto-seed, no "Use" tap needed (#335).
  const weight = page.getByTestId("set1-weight");
  await expect(weight).toHaveAttribute("placeholder", /^\d/);

  // Focusing the field fills it (weight + reps) from the suggestion, completing
  // the set so it auto-saves — the Delete button appearing confirms the persist.
  await weight.focus();
  await expect(weight).toHaveValue(/^\d/);
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // Clean up the auto-saved draft so the shared seed DB is left untouched.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
});

test("a cardio part derives avg speed AND pace from distance + duration (#336)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // Running requires a distance field; pick it so both Distance and Duration show.
  await pickActivity(page, "Running");

  // 5 km in 25 min → 12 km/h, pace 5:00 /km (seeded login is metric).
  await page.getByTestId("cardio-duration").fill("25");
  await page.getByTestId("cardio-distance").fill("5");

  // Both the average speed AND the newly-added pace line render from the same
  // inputs (#336) — pace is what runners actually think in.
  await expect(page.getByText(/Avg speed:/)).toContainText("12");
  await expect(page.getByText(/Pace:/)).toContainText("5:00");

  // Clean up the auto-saved draft (a duration makes it savable).
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
});

test("the command palette offers 'Repeat last activity' when history exists (#337)", async ({
  page,
}) => {
  await page.goto("/"); // the seed has plenty of logged activities

  // Retrying open — see the #29 spec above (hydration-window swallow).
  const input = await openCommandPalette(page);

  // Typing "repeat" surfaces the new palette command (gated on a last activity
  // existing — the seed guarantees one).
  await input.fill("repeat");
  await expect(page.getByText("Repeat last activity")).toBeVisible();

  // Read-only: close without executing so no draft is created.
  await page.keyboard.press("Escape");
});

test("weight steppers bump a set's load by the lift-appropriate increment (#337)", async ({
  page,
}) => {
  await page.goto("/training");

  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  // Barbell Bench Press is an upper-body lift → a 2.5 (kg) step for the seeded
  // metric login.
  await pickActivity(page, "Barbell Bench Press");

  // The + stepper bumps the (empty) weight by one increment → 2.5. Only weight is
  // set, so the set stays half-filled and nothing auto-saves — no cleanup needed.
  await page.getByLabel("Increase weight").first().click();
  await expect(page.getByTestId("set1-weight")).toHaveValue("2.5");

  await page.keyboard.press("Escape");
});

test("a set row has a warmup toggle that flips its pressed state (#338)", async ({
  page,
}) => {
  await page.goto("/training");

  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();

  await pickActivity(page, "Barbell Bench Press");

  // Each set carries a light "W" warmup toggle (default off). Toggling flips its
  // aria-pressed state — the flag excludes the set from volume/target/records.
  const warmup = page.getByTestId("set1-warmup");
  await expect(warmup).toHaveAttribute("aria-pressed", "false");
  await warmup.click();
  await expect(warmup).toHaveAttribute("aria-pressed", "true");

  // Only the flag was toggled on an empty set, so nothing auto-saves — no cleanup.
  await page.keyboard.press("Escape");
});

test("a failed activity save surfaces an error, never a false 'Saved ✓' (#332)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // Force every saveActivity call to fail at the network layer. saveActivity runs
  // as a Server Action — a POST to the page carrying a `next-action` header; the
  // service worker passes non-GET straight through (public/sw.js), so this is an
  // ordinary browser request page.route intercepts. We ABORT it (rather than
  // fulfill a 500 — a non-flight body makes Next fall back to a full-page reload,
  // which would unmount the form before the indicator paints); an aborted fetch
  // rejects, so `await saveActivity()` throws into persist()'s failure handling.
  // Aborting *every* such POST (not just the first) guarantees no later autosave
  // can flip the form back to "Saved ✓". The #332 regression was that a save which
  // didn't persist still advanced the form to "Saved ✓"; the fix must instead show
  // the honest "Couldn’t save" indicator (the exact { ok: false } not-owned/invalid
  // branches are pinned directly at the action tier — the single-profile e2e DB
  // can't naturally produce a stale foreign id).
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.headers()["next-action"]) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  // Open a fresh create form and fill it enough to be savable (same flow as the
  // est-calories spec — see its note on why fields are addressed by testid/role).
  await page
    .getByRole("main")
    .getByRole("button", { name: "New activity" })
    .click();
  await page.getByPlaceholder(/What did you do/).fill("Running");
  await page
    .getByRole("listbox")
    .getByRole("button", { name: "Running", exact: true })
    .click();
  // A duration makes the activity savable, so the debounced auto-save fires — and
  // hits the aborted request.
  await page.getByTestId("cardio-duration").fill("30");

  // The failure must surface as the error indicator (SaveStatus, aria-label
  // "Couldn’t save"), and the success check must never appear.
  await expect(page.getByLabel("Couldn’t save")).toBeVisible();
  await expect(page.getByLabel("Saved")).toHaveCount(0);

  // Nothing persisted (the save was forced to fail), so there is no draft row to
  // clean up — the shared seed DB is left untouched.
});

test("bulk-delete rows in Data → Manage, then Undo restores them (#29)", async ({
  page,
}) => {
  await page.goto("/data?section=manage");

  // The Body metrics dataset (undoable kind = body-metric) is seeded with rows.
  const card = page.locator(".card", {
    has: page.getByRole("heading", { name: "Body metrics" }),
  });
  await expect(card).toBeVisible();
  // Remember the "(N)" count in the heading to prove a full restore later.
  const countText = async () =>
    (await card.locator("h2 span").first().textContent())?.trim();
  const original = await countText();
  expect(original).toBeTruthy();

  // Enter edit mode → select every row shown → delete the selection.
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Select all rows shown").check();
  await card.getByRole("button", { name: "Delete selected" }).click();
  // Confirm the inline "Delete N rows?" prompt.
  await card.getByRole("button", { name: "Delete", exact: true }).click();

  // One batch toast with an Undo action; click it.
  await expect(
    page.getByText(/Deleted \d+ rows? from Body metrics\./)
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();

  // The whole batch comes back (restored under new ids) — a "Restored N" toast,
  // and after a fresh render the dataset count matches where it started.
  await expect(page.getByText(/Restored \d+ rows?\./)).toBeVisible();
  await page.goto("/data?section=manage");
  await expect(card.locator("h2 span").first()).toHaveText(original!);
});
