import { test, expect, type Page } from "@playwright/test";

// #1427: a dose confirm tapped with no signal is queued and replayed through the
// SAME write core every other confirm path uses (markDoseTaken), which answers with
// a typed outcome. Two ends of that contract are driven here in the real app:
//
//   1. the happy path — offline tap → queued (not lost, not failed) → reconnect →
//      the dose is DURABLY taken server-side, and
//   2. a genuine refusal — the dose gets deliberately SKIPPED from another session
//      while the confirm sits in the queue, so the replay lands on a resolved day
//      and must surface the refusal in the queue's dead-letter panel instead of
//      reporting a sync (the two-way principle: never unconditionally confirm).
//
// Both assert the DURABLE state after a reload, never a transient toast alone
// (#1443): a toast proves a message was rendered, a reloaded page proves the write.
//
// Desktop project on purpose: the queue is viewport-independent (its badge/panel are
// fixed-position overlays present at every width), so this belongs with the existing
// offline-queue spec rather than the phone-shell `mobile` project (#1420).
//
// Each test OWNS its fixture — a uniquely-named supplement it creates and deletes
// (#868) — so it never touches the seeded intake rows other specs count on.

const AUTH_STATE = "e2e/.auth/state.json";

// Create a supplement with a single daily Morning dose and return its row locator.
async function createMorningSupplement(page: Page, name: string) {
  await page.goto("/nutrition?tab=supplements");
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add supplement" });
  await addCard.getByLabel("Name").fill(name);
  await addCard.getByLabel("Amount").first().fill("10 mg"); // first-ok: the add-supplement form's own first dose-row field (deterministic within one form render, not a seeded list)
  await addCard.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the add-supplement form's own first dose-row field (deterministic within one form render, not a seeded list)
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  const row = morningRow(page, name);
  await expect(row).toHaveCount(1);
  return row;
}

function morningRow(page: Page, name: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: name });
}

async function deleteSupplement(page: Page, name: string) {
  const row = morningRow(page, name);
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.locator("div.card").filter({ hasText: name })).toHaveCount(
    0
  );
}

test("a dose confirmed offline queues, then replays as a real taken dose (#1427)", async ({
  page,
  context,
}) => {
  const name = `Offline Dose Iron ${Date.now()}`;
  const row = await createMorningSupplement(page, name);

  // The dead-reception moment: the pills are in your hand, the network isn't there.
  await context.setOffline(true);
  await row.getByRole("button", { name: "Mark taken" }).click();

  // Queued, not failed — and the badge says so.
  await expect(
    page.getByText("Dose saved offline — will sync when you reconnect.")
  ).toBeVisible();
  const badge = page.getByTestId("offline-queue-badge");
  await expect(badge).toHaveText(/1 queued offline/);

  // Reconnect → the "online" event flushes the queue into the replay route.
  await context.setOffline(false);
  await expect(page.getByText(/Synced 1 offline entr/)).toBeVisible();
  await expect(badge).toHaveCount(0);

  // DURABLE: a fresh server render shows the dose taken — this is the assertion the
  // optimistic client state can't fake.
  await page.goto("/nutrition?tab=supplements");
  const reloaded = morningRow(page, name);
  await expect(
    reloaded.getByRole("button", { name: "Mark not taken" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    reloaded.getByRole("button", { name: "Skip this dose" })
  ).toHaveAttribute("aria-pressed", "false");

  // Nothing resurrects or double-logs on a further reload (the on-load flush runs
  // again against an empty queue).
  await page.reload();
  await expect(
    morningRow(page, name).getByRole("button", { name: "Mark not taken" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);

  await deleteSupplement(page, name);
});

test("a queued confirm that lands on an already-skipped dose is surfaced, not silently synced (#1427)", async ({
  page,
  context,
  browser,
}) => {
  const name = `Offline Dose Zinc ${Date.now()}`;
  const row = await createMorningSupplement(page, name);
  const origin = new URL(page.url()).origin;

  // Tap ✅ with no signal — the confirm goes into the queue.
  await context.setOffline(true);
  await row.getByRole("button", { name: "Mark taken" }).click();
  await expect(page.getByTestId("offline-queue-badge")).toHaveText(
    /1 queued offline/
  );

  // Meanwhile, from a SECOND (still-online) session, the same dose is deliberately
  // SKIPPED — offline is per browser context, so this is a genuine server-side state
  // change racing the queued write, not a mocked response.
  const other = await browser.newContext({ storageState: AUTH_STATE });
  const otherPage = await other.newPage();
  await otherPage.goto(`${origin}/nutrition?tab=supplements`);
  const otherRow = morningRow(otherPage, name);
  await otherRow.getByRole("button", { name: "Skip this dose" }).click();
  await expect(
    otherRow.getByRole("button", { name: "Undo skip" })
  ).toHaveAttribute("aria-pressed", "true");
  await other.close();

  // Reconnect: markDoseTaken answers "already-skipped" — the set-to-taken intent
  // deliberately doesn't overwrite the other resolution — so the entry is parked for
  // review with the real reason, NOT counted as synced.
  await context.setOffline(false);
  const review = page.getByTestId("offline-rejected-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText("Dose logged");
  await expect(review).toContainText(/already recorded as skipped/i);
  // It left the live queue (it can never apply), but its payload is preserved above.
  await expect(page.getByTestId("offline-queue-badge")).toHaveCount(0);

  // DURABLE: the deliberate skip stands; the replayed confirm did not overwrite it.
  await page.goto("/nutrition?tab=supplements");
  const reloaded = morningRow(page, name);
  await expect(
    reloaded.getByRole("button", { name: "Undo skip" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    reloaded.getByRole("button", { name: "Mark taken" })
  ).toHaveAttribute("aria-pressed", "false");

  await deleteSupplement(page, name);
});
