import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { expectNoClippedContent, followLink, settledClick } from "./helpers";
import { openCommandPalette } from "./nav";
import { frozenNow } from "./worker-env";
import { formatDateWithYear } from "@/lib/format-date";

async function openPracticeCreate(page: Page) {
  await page.getByTestId("practice-create-trigger").click();
  const form = page.getByTestId("practice-create-form");
  await expect(form).toBeVisible();
  return form;
}

async function choosePracticeAction(
  page: Page,
  card: Locator,
  actionTestId: string
) {
  await card
    .getByTestId("wellness-practice-actions")
    .getByRole("button")
    .click();
  await page.getByTestId(actionTestId).click();
}

async function chooseSessionAction(
  page: Page,
  row: Locator,
  actionTestId: string
) {
  await row.getByRole("button", { name: "Session actions" }).click();
  await page.getByTestId(actionTestId).click();
}

test("a relevant Wellness profile can reach its practice home from nav (#1620)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Profile 1's seed has both a practice target and session history. Enter through
  // the actual sidebar rather than page.goto("/wellness"), so dropping the
  // relevance-gated registration cannot leave the empty/create surface stranded.
  await page.goto("/");
  const wellness = page
    .locator("aside nav")
    .getByRole("link", { name: "Wellness", exact: true });
  await expect(wellness).toBeVisible();
  await followLink(page, wellness, /\/wellness$/);
  await expect(
    page.getByRole("main").getByRole("heading", { name: "Wellness" })
  ).toBeVisible();
  const wellnessPage = page.getByTestId("wellness-page");
  const bounds = await wellnessPage.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(768);

  // Creation stays out of the reading flow until requested. Its modal combobox
  // must still paint above the page and modal surfaces.
  const create = await openPracticeCreate(page);
  await create.getByLabel("Practice").focus();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const listboxBounds = await listbox.boundingBox();
  expect(listboxBounds).not.toBeNull();
  const listboxIsTopmost = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest('[role="listbox"]')
        ?.getAttribute("role") === "listbox",
    {
      x: listboxBounds!.x + listboxBounds!.width / 2,
      y: listboxBounds!.y + listboxBounds!.height - 4,
    }
  );
  expect(listboxIsTopmost).toBe(true);
  // Escape dismisses the nested picker first, preserving the parent modal and
  // its typed state. A second Escape closes the modal itself.
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(create).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);

  // Long histories start compact, can expand in place, and retain an accessible
  // row action in the phone layout without a horizontal table swipe.
  const seededCard = page
    .getByTestId("wellness-practice-card")
    .filter({ hasText: "Red light therapy" });
  const practiceCards = page.getByTestId("wellness-practice-card");
  await expect(page.getByTestId("practice-heatmap")).toHaveCount(
    await practiceCards.count()
  );
  await expect(
    seededCard
      .getByTestId("practice-heatmap")
      .locator('[data-count]:not([data-count="0"])')
  ).not.toHaveCount(0);
  const history = seededCard.getByTestId("practice-session-history");
  await expect(history.locator("tbody tr")).toHaveCount(5);
  const toggle = history.getByTestId("practice-session-toggle");
  await expect(toggle).toHaveText(/View all \d+ sessions/);
  await toggle.click();
  expect(await history.locator("tbody tr").count()).toBeGreaterThan(5);
  await history.getByRole("button", { name: "Show fewer sessions" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const rowAction = history
    .locator("tbody tr")
    .first() // first-ok: asserts the responsive shape of any visible session row, not its fixture identity
    .getByRole("button", { name: "Session actions" });
  const emptyNotes = history
    .locator("tbody tr")
    .first() // first-ok: asserts the responsive shape of any visible session row, not its fixture identity
    .locator("td:not([data-card])", { hasText: "—" });
  await expect(emptyNotes).toBeHidden();
  await expect(rowAction).toBeVisible();
  const actionBounds = await rowAction.boundingBox();
  expect(actionBounds).not.toBeNull();
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(390);
});

test("the command palette preserves the first-practice creation path (#1620)", async ({
  page,
}) => {
  await page.goto("/");
  const input = await openCommandPalette(page);
  await input.fill("Wellness practices");
  const action = page.getByTestId("palette-action-wellness-practices");
  await expect(action).toBeVisible();
  await action.click();
  await expect(page).toHaveURL(/\/wellness\?new=1$/);
  await expect(
    page.getByTestId("practice-create-form").getByLabel("Practice")
  ).toBeFocused();
});

test("practice edits reject invalid cadence and logs-only name collisions (#1618/#1619)", async ({
  page,
}) => {
  // The double-create sequence carries a declared 45s post-create ceiling (below),
  // which exceeds the default 30s TEST budget — without slow(), the test times out
  // at 30s before the ceiling can do its job (exactly what shard 4 kept showing:
  // "Test timeout of 30000ms exceeded" at 30.1s). 2026-08-02, #1556 census.
  test.slow();
  const suffix = frozenNow().getTime();
  const trackedName = `E2E Cadence ${suffix}`;
  const historyName = `E2E History ${suffix}`;

  await page.goto("/wellness");
  const main = page.getByRole("main");
  const create = await openPracticeCreate(page);

  await create.getByLabel("Practice").fill(trackedName);
  await create.getByLabel("Minimum days").fill("3");
  await create.getByLabel("Maximum days (optional)").fill("5");
  await settledClick(
    page,
    create.getByRole("button", { name: "Save", exact: true })
  );

  // Re-enter after the first Server Component refresh so the controlled practice
  // combobox belongs to the current editor instance.
  await page.goto("/wellness");
  const refreshedMain = page.getByRole("main");
  const secondCreate = await openPracticeCreate(page);
  await secondCreate.getByLabel("Practice").fill(historyName);
  await secondCreate.getByLabel("Minimum days").fill("2");
  await secondCreate.getByLabel("Maximum days (optional)").fill("");
  await settledClick(
    page,
    secondCreate.getByRole("button", { name: "Save", exact: true })
  );

  const trackedCard = refreshedMain
    .getByTestId("wellness-practice-card")
    .filter({ hasText: trackedName });
  const historyCard = refreshedMain
    .getByTestId("wellness-practice-card")
    .filter({ hasText: historyName });
  // Post-create re-render ceiling (recurring-failure census, docs/internals/
  // e2e-hygiene.md): the second Save's Server Action re-renders the whole practice
  // list, and settledClick's own pre-visibility assert runs at the 5 s default
  // (it does NOT honor opts.timeout), so the first card lookup after the save can
  // outrun it on a loaded shard. Both cards paint in the same repaint, so one
  // named ceiling covers the sequence. Not a sleep — this still fails if the
  // created card never appears. 2026-08-01: raised 20s → 45s after three shard-4
  // overruns in one day on unrelated diffs (#1556 census) — that shard's boxes
  // run neighboring specs at 28-35s, so a double create round-trip needs the
  // wider honest ceiling.
  await expect(trackedCard.getByTestId("practice-log-button")).toBeVisible({
    timeout: 45_000,
  });
  await settledClick(page, trackedCard.getByTestId("practice-log-button"));
  await settledClick(page, historyCard.getByTestId("practice-log-button"));
  await settledClick(page, historyCard.getByTestId("practice-log-button"));

  await choosePracticeAction(page, historyCard, "wellness-practice-untrack");
  await settledClick(
    page,
    page
      .getByTestId("confirm-dialog")
      .getByRole("button", { name: "Stop tracking" })
  );
  await expect(historyCard).toContainText("Session history only");

  await choosePracticeAction(page, trackedCard, "wellness-practice-edit");
  const edit = trackedCard.getByTestId("practice-edit-form");
  await edit.getByLabel("Minimum days").fill("5");
  await edit.getByLabel("Maximum days (optional)").fill("3");
  await settledClick(page, edit.getByRole("button", { name: "Save changes" }));
  await expect(edit.getByTestId("practice-save-error")).toHaveText(
    "The weekly maximum must be greater than the minimum."
  );
  await expect(trackedCard).toContainText("1 day this week · Target 3–5×/week");

  await edit.getByLabel("Practice").fill(historyName);
  await edit.getByLabel("Minimum days").fill("3");
  await edit.getByLabel("Maximum days (optional)").fill("5");
  await settledClick(page, edit.getByRole("button", { name: "Save changes" }));
  await expect(edit.getByTestId("practice-save-error")).toHaveText(
    "A practice with that name already exists."
  );
  await expect(
    trackedCard.getByTestId("wellness-practice-usage")
  ).toContainText("1 session");
  await expect(
    historyCard.getByTestId("wellness-practice-usage")
  ).toContainText("2 sessions");
  await expect(trackedCard).toContainText(trackedName);
  await expect(historyCard).toContainText(historyName);

  await edit.getByRole("button", { name: "Cancel" }).click();
  for (const card of [trackedCard, historyCard]) {
    await choosePracticeAction(page, card, "wellness-practice-delete");
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Delete practice" })
    );
    await expect(card).toHaveCount(0);
  }
});

test("wellness practices own identity, detailed history, corrections, and Training containment (#1583/#1585/#1590/#1591)", async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  const unique = `E2E Wellness ${frozenNow().getTime()}`;
  const renamed = `${unique} renamed`;
  const today = frozenNow().toISOString().slice(0, 10);

  await page.goto("/wellness");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Wellness" })).toBeVisible();

  const create = await openPracticeCreate(page);
  await create.getByLabel("Practice").fill(`  ${unique}  `);
  await create.getByLabel("Minimum days").fill("3");
  await create.getByLabel("Maximum days (optional)").fill("5");
  await settledClick(
    page,
    create.getByRole("button", { name: "Save", exact: true })
  );

  const card = main
    .getByTestId("wellness-practice-card")
    .filter({ hasText: unique });
  await expect(card).toBeVisible();
  await expect(card).toContainText("No days this week · Target 3–5×/week");
  const heatmap = card.getByTestId("practice-heatmap");
  await expect(heatmap).toBeVisible();
  await expect(heatmap.locator('[data-count="0"]')).not.toHaveCount(0);

  // The expandable path writes the already-supported time/duration/notes fields.
  await card.getByRole("button", { name: "Log with details" }).click();
  const detailed = page.getByTestId("practice-log-details");
  await detailed.getByLabel("Date").fill(today);
  await detailed.getByLabel("Time").fill("07:30");
  await detailed.getByLabel("Duration (minutes)").fill("20");
  await detailed.getByLabel("Notes").fill("First session");
  await settledClick(
    page,
    detailed.getByTestId("practice-log-detailed-submit")
  );

  await expect(card.getByTestId("wellness-practice-usage")).toContainText(
    "1 session"
  );
  await expect(heatmap.locator('[data-count="1"]')).toHaveCount(1);
  const row = card.getByTestId("practice-session-history").locator("tbody tr");
  await expect(row).toContainText("20 min");
  await expect(row).toContainText("First session");

  // Corrections remain available through the shared history component.
  await chooseSessionAction(page, row, "practice-session-edit");
  await row.getByLabel("Duration (minutes)").fill("25");
  await row.getByLabel("Notes").fill("Corrected session");
  await settledClick(page, row.getByTestId("practice-session-save"));
  await expect(row).toContainText("25 min");
  await expect(row).toContainText("Corrected session");

  // Renaming the stable target re-keys its session history rather than orphaning it.
  await choosePracticeAction(page, card, "wellness-practice-edit");
  const edit = card.getByTestId("practice-edit-form");
  await edit.getByLabel("Practice").fill(renamed);
  await settledClick(page, edit.getByRole("button", { name: "Save changes" }));
  const renamedCard = main
    .getByTestId("wellness-practice-card")
    .filter({ hasText: renamed });
  await expect(renamedCard).toBeVisible();
  await expect(
    renamedCard.getByTestId("practice-session-history")
  ).toContainText("Corrected session");

  // The Training routine editor cannot represent practice targets, so the target is
  // deliberately absent there while remaining fully usable on Wellness.
  await page.goto("/training?tab=goals");
  const routine = page
    .getByRole("main")
    .getByRole("heading", { name: "Weekly routine" })
    .locator("..");
  await expect(routine).not.toContainText(renamed);

  // The combined dashboard card treats practices as their own domain and routes
  // management back here, rather than to the Training editor that excludes them.
  await page.goto("/");
  const habits = page.getByRole("main").getByTestId("goals-habits");
  await expect(
    habits.getByRole("link", { name: "Log practice session →" })
  ).toHaveAttribute("href", "/wellness");

  // Return and delete the event as an adherence correction; the target survives.
  await page.goto("/wellness");
  const finalCard = page
    .getByRole("main")
    .getByTestId("wellness-practice-card")
    .filter({ hasText: renamed });
  const finalRow = finalCard
    .getByTestId("practice-session-history")
    .locator("tbody tr");
  await chooseSessionAction(page, finalRow, "practice-session-delete");
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await settledClick(
    page,
    dialog.getByRole("button", { name: "Delete session" })
  );
  await expect(finalCard.getByTestId("practice-session-empty")).toBeVisible();
  await expect(finalCard.getByText("No sessions logged yet.")).toHaveCount(1);
  await expect(finalCard.getByText("No sessions yet")).toHaveCount(0);

  // Re-add one session, then exercise the explicitly destructive family delete:
  // target + history disappear under one Undo token, and Undo restores both.
  await settledClick(page, finalCard.getByTestId("practice-log-button"));
  await expect(finalCard.getByTestId("practice-session-history")).toContainText(
    formatDateWithYear(today)
  );
  await choosePracticeAction(page, finalCard, "wellness-practice-delete");
  const deletePracticeDialog = page.getByTestId("confirm-dialog");
  await expect(deletePracticeDialog).toContainText("1 logged session");
  await expect(deletePracticeDialog).toContainText(
    "You can undo this deletion."
  );
  await settledClick(
    page,
    deletePracticeDialog.getByRole("button", { name: "Delete practice" })
  );
  await expect(finalCard).toHaveCount(0);
  await settledClick(page, page.getByRole("button", { name: "Undo" }));
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(finalCard).toBeVisible();
  await expect(finalCard).toContainText("3–5×/week");
  await expect(finalCard.getByTestId("practice-session-history")).toContainText(
    formatDateWithYear(today)
  );

  // Stop tracking is the non-destructive retirement: the target/reminders go,
  // while the card and session history remain as a logs-only practice.
  await choosePracticeAction(page, finalCard, "wellness-practice-untrack");
  const untrackDialog = page.getByTestId("confirm-dialog");
  await expect(untrackDialog).toBeVisible();
  await expect(untrackDialog).toContainText(
    "Logged sessions will stay in your history"
  );
  await settledClick(
    page,
    untrackDialog.getByRole("button", { name: "Stop tracking" })
  );
  await expect(finalCard).toBeVisible();
  await expect(finalCard).toContainText("Session history only");

  // A logs-only practice can also be removed for good. Leave it deleted so this
  // run cleans up the unique practice it created.
  await choosePracticeAction(page, finalCard, "wellness-practice-delete");
  const cleanupDialog = page.getByTestId("confirm-dialog");
  await expect(cleanupDialog).toContainText("1 logged session");
  await settledClick(
    page,
    cleanupDialog.getByRole("button", { name: "Delete practice" })
  );
  await expect(finalCard).toHaveCount(0);
  await expectNoClippedContent(page);
});
