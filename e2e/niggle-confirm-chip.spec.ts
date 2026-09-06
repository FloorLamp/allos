import { test, expect } from "./fixtures";
import {
  comboboxRows,
  followLink,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";

// #2948 parts 1 + 2 — the whole point of the feature, end to end: a person types the
// note they were already typing ("right knee weird"), and instead of that signal
// disappearing into free text where nothing can read it, the saved session offers a
// ONE-TAP confirm. The tap is the write (#798 confirm-never-silent): before it, nothing
// is stored; after it, the chip is gone because the niggle it offered now exists.
//
// The prod evidence this replays: `injuries` is empty while the owner's own
// `activities.notes` read exactly this line. Nothing about the note is interpreted by a
// model — the detector is the curated lexicon in lib/curated/niggle-lexicon.ts.
//
// Fixture ownership (docs/internals/e2e-hygiene.md): the probe session carries a unique
// per-run suffix and is deleted at the end, so a --repeat-each rerun or a sibling spec
// can never collide on it.

const PROBE_PREFIX = "Niggle probe";

test("a workout note naming a sore knee offers a one-tap niggle confirm (#2948)", async ({
  page,
}) => {
  test.slow(); // local next dev compiles /training on first hit

  const stamp = `${Date.now()}`; // eslint-disable-line no-restricted-properties -- clock-ok: unique-name suffix for this run's probe activity, never a stored timestamp
  const title = `${PROBE_PREFIX} session ${stamp}`;

  await page.goto("/training?tab=log");
  await hydratedClick(page, page.getByTestId("training-log-add-activity"));
  await expect(page.getByTestId("activity-form")).toBeVisible();

  await settledFill(
    page,
    page.getByRole("textbox", { name: "Activity name" }),
    title
  );
  // A plain (equipment-variant-free) barbell lift, so a complete set is savable with no
  // per-set equipment pick.
  await settledFill(
    page,
    page.getByPlaceholder(/What did you do/),
    "Back Squat"
  );
  // eslint-disable-next-line no-restricted-properties -- first-ok: transient combobox list this spec just opened by typing the name
  await comboboxRows(page).filter({ hasText: "Back Squat" }).first().click();

  await settledFill(page, page.getByTestId("set1-weight"), "100");
  await settledFill(
    page,
    page.getByTestId("set1-reps-stepper").locator("input"),
    "5"
  );
  // The complete set auto-saves; Delete appearing is the stable "row exists" signal.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // The note itself — the line this whole feature is about.
  // A pure client disclosure — it reveals the Notes field, it does not post.
  await hydratedClick(page, page.getByTestId("more-details-summary"));
  // The note's debounced autosave is what carries it to the server. Arm the wait for
  // that Server-Action POST BEFORE typing, so the navigation below cannot race an
  // unsaved note — which would surface as "notes card not found" and read like the chip
  // is broken rather than like the save had not landed.
  const noteSaved = page.waitForResponse(
    (resp) =>
      resp.request().method() === "POST" &&
      new URL(resp.url()).origin === new URL(page.url()).origin,
    { timeout: 30_000 }
  );
  await settledFill(
    page,
    page.getByRole("textbox", { name: "Notes" }),
    "right knee weird"
  );
  await noteSaved;

  // Open the saved session's own page, where the record — and the offer — live.
  await page.goto("/training?tab=log");
  // eslint-disable-next-line no-restricted-properties -- first-ok: the probe session is uniquely titled for this run
  const row = page
    .getByTestId("history-row")
    .filter({ hasText: title })
    .first();
  await followLink(
    page,
    row.getByRole("link", { name: title, exact: true }),
    /\/training\/activity\/\d+$/
  );

  const notesCard = page.getByTestId("activity-notes-card");
  await expect(notesCard).toContainText("right knee weird");

  // The offer, sitting under the note it came from. It ASKS — nothing is recorded yet,
  // and the copy says so.
  const chip = page.getByTestId("niggle-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(
    "Sounds like a right knee niggle — track it?"
  );
  // The structured facts behind the sentence: the injury-model region and side, not a
  // parallel body-part vocabulary.
  await expect(chip).toHaveAttribute("data-region", "Legs");
  await expect(chip).toHaveAttribute("data-laterality", "right");

  // The tap IS the write.
  await settledClick(page, page.getByTestId("niggle-chip-confirm"));

  // Confirmed: the chip stops offering, because the niggle it offered now exists and is
  // live. A reload proves it is server state, not a local hide.
  await expect(page.getByTestId("niggle-chip")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("activity-notes-card")).toContainText(
    "right knee weird"
  );
  await expect(page.getByTestId("niggle-chip")).toHaveCount(0);

  // Cleanup: remove the probe session.
  await hydratedClick(page, page.getByTestId("activity-page-edit"));
  await expect(page.getByTestId("activity-form")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Delete", exact: true })
  );
  await page.goto("/training?tab=log");
  await expect(
    page.getByTestId("history-row").filter({ hasText: title })
  ).toHaveCount(0);
});
