import { test, expect } from "./fixtures";
import {
  followLink,
  hydratedClick,
  settledClick,
  settledSelect,
} from "./helpers";
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
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(name);
  await addDialog.getByLabel("Amount").first().fill("500 mg"); // first-ok: the first dose's Amount field in the scoped add modal
  await addDialog.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first dose's Time-of-day field in the scoped add modal
  await addDialog
    .getByRole("button", { name: "Add dose", exact: true })
    .click();
  await addDialog.getByLabel("Amount").nth(1).fill("500 mg");
  await addDialog.getByLabel("Time of day").nth(1).selectOption("Evening");
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

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
  await morningRow.getByRole("button", { name: "IntakeItem actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editForm = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(editForm.getByTestId("supplement-edit-panel")).toHaveCSS(
    "padding-left",
    "4px"
  );
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
  // The timeline's "IntakeItem doses confirmed" event for today still lists the
  // confirmed dose — retired, not cascaded — and its expanded detail shows the
  // amount SNAPSHOTTED at confirm time (500 mg), not the post-edit 1000 mg.
  await page.goto("/timeline");
  const confirmedEvent = page
    .locator("details")
    .filter({ hasText: "IntakeItem doses confirmed" })
    .filter({ hasText: name })
    .first(); // first-ok: filtered to the confirmed-doses event for THIS spec's supplement — one match
  await confirmedEvent.locator("summary").click();
  await expect(confirmedEvent.getByText(name).first()).toBeVisible(); // first-ok: the supplement name inside the scoped confirmed-doses event — order-agnostic
  await expect(confirmedEvent.getByText("500 mg").first()).toBeVisible(); // first-ok: the dose amount inside the scoped confirmed-doses event — order-agnostic
});

// #1933: historical dose correction is shared adherence machinery, so the supplements
// tab offers the SAME ⋯ actions the medication detail page does — backfill, amend,
// delete-with-undo — over the same ungated cores. Before this, a supplement's dose
// history had no affordances at all, and the write core answered "that dose doesn't
// exist" to a dose that plainly did. This drives the real UI: confirm a dose, open the
// row's Dose history panel, and amend the recorded entry end to end.
test("a supplement's dose history offers the medication row actions, and an edit round-trips", async ({
  page,
}, testInfo) => {
  const name = `Backfill Guard ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");

  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(name);
  await addDialog.getByLabel("Amount").first().fill("250 mg"); // first-ok: the first (only) dose's Amount field in the scoped add modal
  await addDialog.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first (only) dose's Time-of-day field in the scoped add modal
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  const row = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: name });
  await row.getByRole("button", { name: "Mark taken" }).click();
  await expect(
    row.getByRole("button", { name: "Mark not taken" })
  ).toBeVisible();

  // ── The row's ⋯ menu now reaches dose history ──────────────────────────────
  await row.getByRole("button", { name: "IntakeItem actions" }).click();
  await page.getByRole("menuitem", { name: "Dose history" }).click();
  const panel = row.getByTestId("supplement-dose-history-panel");
  await expect(
    panel.getByRole("button", { name: "Log past dose" })
  ).toBeVisible();

  const entry = panel.getByTestId("dose-history-row");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("250 mg");
  // #2228 decision 4: this row's only clock is the record chain (the confirm's tap
  // stamp — nothing has stated an intake time), so the panel marks it "recorded"
  // rather than presenting a filing timestamp as an administration time.
  await expect(entry).toContainText(/recorded \d{1,2}:\d{2}/);

  // ── The same ⋯ row actions the medication history offers ───────────────────
  await entry.getByRole("button", { name: "Dose actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  // ── The amendment round-trips: the snapshotted amount is corrected in place ─
  const form = panel.getByTestId("historical-dose-form");
  await expect(form).toContainText("won’t change the schedule either");
  // #2228 write half: the editor's time seeds ONLY from the row's stated
  // occurred_at — this row has none, so the field opens EMPTY instead of
  // laundering the confirm's filing timestamp into an administration time.
  await expect(form.getByTestId("historical-dose-time")).toHaveValue("");
  await form.getByLabel("Amount").fill("375 mg");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(panel.getByTestId("dose-history-row")).toContainText("375 mg");
  // The amount-only amendment stated no intake time (occurred_at stays NULL), so
  // the row STILL carries the "recorded" marker — amending the amount of a dose
  // whose intake time was never stated changes the amount and nothing else.
  await expect(panel.getByTestId("dose-history-row")).toContainText(
    /recorded \d{1,2}:\d{2}/
  );

  // ── Stating a time makes the row a real administration clock ───────────────
  // The frozen e2e clock always reads 13:mm local (e2e/pinned-timezone.ts), so a
  // morning wall time today is deterministically in the past.
  await panel
    .getByTestId("dose-history-row")
    .getByRole("button", { name: "Dose actions" })
    .click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const timedForm = panel.getByTestId("historical-dose-form");
  await timedForm.getByTestId("historical-dose-time").fill("07:42");
  await timedForm.getByRole("button", { name: "Save changes" }).click();
  await expect(timedForm).toHaveCount(0);
  // The stated time renders as a BARE clock — the "recorded" marker is gone.
  await expect(panel.getByTestId("dose-history-row")).toContainText(
    /(?:7:42am|07:42)/
  );
  await expect(panel.getByTestId("dose-history-row")).not.toContainText(
    "recorded"
  );
  // …and reopening the editor now seeds from the stated instant.
  await panel
    .getByTestId("dose-history-row")
    .getByRole("button", { name: "Dose actions" })
    .click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(
    panel
      .getByTestId("historical-dose-form")
      .getByTestId("historical-dose-time")
  ).toHaveValue("07:42");
  await panel
    .getByTestId("historical-dose-form")
    .getByRole("button", { name: "Cancel" })
    .click();

  // The SCHEDULE is untouched by the correction — the row still reads 250 mg.
  await expect(row).toContainText("250 mg");
});

// #2417: dose history is no longer a per-item disclosure two menus deep. Both intake
// surfaces carry a one-click door onto the CROSS-ITEM ledger — every confirmed dose,
// filterable by item, kind and date window, with the same row actions and a top-level
// "Log past dose". This drives that door for real: confirm a dose on the supplements
// tab, walk to the ledger, narrow it to the item, and backfill from the table itself.
test("the supplements tab reaches a cross-item dose ledger and logs a past dose from it", async ({
  page,
}, testInfo) => {
  const name = `Ledger Guard ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");

  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(name);
  await addDialog.getByLabel("Amount").first().fill("125 mg"); // first-ok: the first (only) dose's Amount field in the scoped add modal
  await addDialog.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first (only) dose's Time-of-day field in the scoped add modal
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  const row = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: name });
  await row.getByRole("button", { name: "Mark taken" }).click();
  await expect(
    row.getByRole("button", { name: "Mark not taken" })
  ).toBeVisible();

  // ── ONE click from the supplements tab to the whole ledger ─────────────────
  await followLink(
    page,
    page.getByTestId("dose-ledger-link"),
    /\/nutrition\/dose-history/
  );
  const ledger = page.getByTestId("dose-ledger");
  const ownRow = ledger
    .getByTestId("dose-ledger-row")
    .filter({ hasText: name });
  await expect(ownRow).toHaveCount(1);
  await expect(ownRow).toContainText("125 mg");

  // ── Narrowing to the item leaves that item's rows and nothing else ─────────
  const itemFilter = page.getByTestId("dose-ledger-item-filter");
  const itemValue = await itemFilter
    .locator("option")
    .filter({ hasText: name })
    .getAttribute("value");
  await settledSelect(page, itemFilter, itemValue ?? "", {
    destination: /item=/,
  });
  await expect(ledger.getByTestId("dose-ledger-row")).toHaveCount(1);
  await expect(ledger.getByTestId("dose-ledger-row")).toContainText(name);

  // ── "Log past dose" without opening any item's menu ────────────────────────
  await hydratedClick(page, page.getByTestId("dose-ledger-add"));
  // The picker opens on the item the ledger is FILTERED to — a reader who narrowed
  // the table and then tapped "Log past dose" means that item.
  await expect(page.getByTestId("dose-ledger-item-picker")).toHaveValue(
    itemValue ?? ""
  );
  const form = page.getByTestId("historical-dose-form");
  const maxDate = await form
    .locator('input[type="hidden"][name="date"]')
    .inputValue();
  const backfill = new Date(`${maxDate}T00:00:00Z`);
  backfill.setUTCDate(backfill.getUTCDate() - 3);
  const backfillDay = backfill.toISOString().slice(0, 10);
  await form.getByTestId("historical-dose-date").fill(backfillDay);
  await form.getByTestId("historical-dose-time").fill("06:45");
  await form.getByLabel("Amount").fill("175 mg");
  await settledClick(page, form.getByRole("button", { name: "Save dose" }));
  await expect(page.getByText(`Logged past dose of ${name}.`)).toBeVisible();
  await expect(ledger.getByTestId("dose-ledger-row")).toHaveCount(2);
  await expect(
    ledger.getByTestId("dose-ledger-row").filter({ hasText: "175 mg" })
  ).toContainText(/(?:6:45am|06:45)/);

  // ── The item-filtered ledger says exactly what the item's own panel says ───
  await page.goto("/nutrition?tab=supplements");
  await row.getByRole("button", { name: "IntakeItem actions" }).click();
  await page.getByRole("menuitem", { name: "Dose history" }).click();
  const panel = row.getByTestId("supplement-dose-history-panel");
  await expect(panel.getByTestId("dose-history-row")).toHaveCount(2);
  await expect(
    panel.getByTestId("dose-history-row").filter({ hasText: "175 mg" })
  ).toHaveCount(1);
});
