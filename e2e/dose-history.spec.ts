import { test, expect } from "@playwright/test";

// A dosage/schedule edit must never destroy or rewrite adherence history.
// Before the `retired` flag, removing a dose row on edit hard-deleted it and
// ON DELETE CASCADE silently wiped every taken-log that referenced it; and with
// no amount snapshot on the log, an amount edit retroactively rewrote what
// history displayed. This drives the whole chain in the real app: create a
// split-dose supplement, confirm one dose, restructure the schedule so the
// confirmed dose is removed, then prove the schedule shrank while the timeline
// still shows today's confirmation at the ORIGINAL amount.

const NAME = "History Guard D3";

test("dosage restructure keeps the taken history at its original amount", async ({
  page,
}, testInfo) => {
  // The changed-spec scrutiny lane repeats this test against one seeded database.
  // Give each attempt its own item so an earlier run cannot inflate row counts.
  const name = `${NAME} ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");

  // ── Create a split-dose supplement: 500 mg Morning + 500 mg Evening ────────
  const addCard = page
    .locator("div.card")
    .filter({ hasText: "Add supplement" });
  await addCard.getByLabel("Name").fill(name);
  await addCard.getByLabel("Amount").first().fill("500 mg"); // first-ok: the first dose's Amount field in the add form this spec fills
  await addCard.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first dose's Time-of-day field in the add form this spec fills
  await addCard.getByRole("button", { name: "Add dose", exact: true }).click();
  await addCard.getByLabel("Amount").nth(1).fill("500 mg");
  await addCard.getByLabel("Time of day").nth(1).selectOption("Evening");
  await addCard.getByRole("button", { name: "Add", exact: true }).click();

  // One row per dose renders (both due today for a daily supplement).
  const rows = page.locator("div.card").filter({ hasText: name });
  await expect(rows).toHaveCount(2);

  // ── Confirm the Morning dose ────────────────────────────────────────────────
  const morningRow = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: name });
  await morningRow.getByRole("button", { name: "Mark taken" }).click();
  await expect(
    morningRow.getByRole("button", { name: "Mark not taken" })
  ).toBeVisible();

  // ── Restructure: replace both doses with a single 1000 mg dose ─────────────
  await morningRow.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  // The add form is also on the page, so scope to the edit form — the only
  // form with a "Save" (not "Add") submit.
  const editForm = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Save", exact: true }) });
  // Remove the confirmed Morning dose (the first dose row), then repurpose the
  // remaining one as the new single 1000 mg dose.
  await editForm.getByRole("button", { name: "Remove dose" }).first().click(); // first-ok: removes the first (Morning) dose row — see comment above
  await editForm.getByLabel("Amount").first().fill("1000 mg"); // first-ok: the remaining dose's Amount field in this spec's edit form
  await editForm.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the remaining dose's Time-of-day field in this spec's edit form
  await editForm.getByRole("button", { name: "Save", exact: true }).click();

  // The schedule shrank to the one new dose, showing the new amount.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("1000 mg"); // first-ok: the single remaining dose row (count asserted above) — order-agnostic

  // ── History survived at the original amount ─────────────────────────────────
  // The timeline's "Supplement doses confirmed" event for today still lists the
  // confirmed dose — retired, not cascaded — and its expanded detail shows the
  // amount SNAPSHOTTED at confirm time (500 mg), not the post-edit 1000 mg.
  await page.goto("/timeline");
  const confirmedEvent = page
    .locator("details")
    .filter({ hasText: "Supplement doses confirmed" })
    .filter({ hasText: name })
    .first(); // first-ok: filtered to the confirmed-doses event for THIS spec's supplement — one match
  await confirmedEvent.locator("summary").click();
  await expect(confirmedEvent.getByText(name).first()).toBeVisible(); // first-ok: the supplement name inside the scoped confirmed-doses event — order-agnostic
  await expect(confirmedEvent.getByText("500 mg").first()).toBeVisible(); // first-ok: the dose amount inside the scoped confirmed-doses event — order-agnostic
});
