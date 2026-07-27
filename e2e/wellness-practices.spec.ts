import { test, expect } from "./fixtures";
import { expectNoClippedContent, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";

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

  const create = main.getByTestId("practice-create-form");
  await create.getByLabel("Practice").fill(`  ${unique}  `);
  await create.getByLabel("Weekly minimum").fill("3");
  await create.getByLabel("Optional maximum").fill("5");
  await settledClick(
    page,
    create.getByRole("button", { name: "Add practice" })
  );

  const card = main
    .getByTestId("wellness-practice-card")
    .filter({ hasText: unique });
  await expect(card).toBeVisible();
  await expect(card).toContainText("0 / 3–5×/week");

  // The expandable path writes the already-supported time/duration/notes fields.
  await card.getByText("Add time, duration, or notes").click();
  const detailed = card.getByTestId("practice-log-details");
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
  const row = card.getByTestId("practice-session-history").locator("tbody tr");
  await expect(row).toContainText("20 min");
  await expect(row).toContainText("First session");

  // Corrections remain available through the shared history component.
  await row.getByTestId("practice-session-edit").click();
  await row.getByLabel("Duration (minutes)").fill("25");
  await row.getByLabel("Notes").fill("Corrected session");
  await settledClick(page, row.getByTestId("practice-session-save"));
  await expect(row).toContainText("25 min");
  await expect(row).toContainText("Corrected session");

  // Renaming the stable target re-keys its session history rather than orphaning it.
  await card.getByTestId("wellness-practice-edit").click();
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
  await finalRow.getByTestId("practice-session-delete").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await settledClick(
    page,
    dialog.getByRole("button", { name: "Delete session" })
  );
  await expect(finalCard.getByTestId("practice-session-empty")).toBeVisible();
  await expect(finalCard.getByTestId("wellness-practice-usage")).toContainText(
    "no sessions yet"
  );
  await expectNoClippedContent(page);
});
