import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import Database from "better-sqlite3";
import { followLink, hydratedClick, settledClick } from "./helpers";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { pinnedTimezone } from "./pinned-timezone";
import { frozenNow, workerDbPath } from "./worker-env";
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
  const doseEditor1 = await openFact(page, "dose", addDialog);
  await doseEditor1.getByLabel("Amount").first().fill("500 mg"); // first-ok: the first dose's Amount field in the scoped add modal
  await doseEditor1.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first dose's Time-of-day field in the scoped add modal
  await addDialog
    .getByRole("button", { name: "Add dose", exact: true })
    .click();
  await doseEditor1.getByLabel("Amount").nth(1).fill("500 mg");
  await doseEditor1.getByLabel("Time of day").nth(1).selectOption("Evening");
  await closeEditor(page, addDialog);
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
  await morningRow.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editForm = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(editForm.getByTestId("supplement-edit-panel")).toHaveCSS(
    "padding-left",
    "4px"
  );
  // Remove the confirmed Morning dose (the first dose row), then repurpose the
  // remaining one as the new single 1000 mg dose.
  const doseEditor2 = await openFact(page, "dose", editForm);
  await doseEditor2
    .getByRole("button", { name: "Remove dose" })
    .first() // first-ok: removes the first (Morning) dose row — see comment above
    .click();
  await doseEditor2.getByLabel("Amount").first().fill("1000 mg"); // first-ok: the remaining dose's Amount field in this spec's edit form
  await doseEditor2.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the remaining dose's Time-of-day field in this spec's edit form
  await closeEditor(page, editForm);
  await editForm.getByRole("button", { name: "Save", exact: true }).click();

  // The schedule shrank to the one new dose, showing the new amount.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("1000 mg"); // first-ok: the single remaining dose row (count asserted above) — order-agnostic

  // ── History survived at the original amount ─────────────────────────────────
  // The record still lists the confirmed dose — retired, not cascaded — at the
  // amount SNAPSHOTTED at confirm time (500 mg), not the post-edit 1000 mg.
  //
  // ASSERTED ON THE DOSE ROW, WHICH IS A BETTER SURFACE THAN THE ONE IT REPLACES.
  // This read the timeline's "Supplement doses confirmed" CARD and opened its
  // `<details>` disclosure, where the per-dose amounts lived in `detailItems`. The
  // record's rows are one line and carry no disclosure yet (#662/#2920, phase 2d), so
  // that surface is gone — but `?kind=dose` is the record's OWN row for this dose,
  // composed by the dose kind's own reader, and the snapshot is exactly what it
  // prints. One row, named by this spec's own item, so nothing else can satisfy it.
  await page.goto("/history?kind=dose");
  const doseRow = page
    .getByTestId("history-row")
    .filter({ hasText: name })
    .first(); // first-ok: this spec plants a uniquely-named item; one row carries it
  await expect(doseRow).toBeVisible();
  await expect(doseRow).toContainText("500 mg");
  await expect(doseRow).not.toContainText("1000 mg");
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
  const doseEditor3 = await openFact(page, "dose", addDialog);
  await doseEditor3.getByLabel("Amount").first().fill("250 mg"); // first-ok: the first (only) dose's Amount field in the scoped add modal
  await doseEditor3.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first (only) dose's Time-of-day field in the scoped add modal
  await closeEditor(page, addDialog);
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
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Dose history" }).click();
  const panel = row.getByTestId("supplement-dose-history-panel");
  await expect(
    panel.getByRole("button", { name: "Log past dose" })
  ).toBeVisible();

  const entry = panel.getByTestId("dose-history-row");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("250 mg");
  // #2876: Mark taken asserts an administration at the tap while recorded_at keeps
  // the separate immutable storage instant. The history therefore shows the stated
  // administration clock, not the record-chain fallback label.
  // The clock is the row's TRAILING fact since #3671, so it no longer reprints the
  // hidden column header beside itself — the pattern used to read `Time7:02`.
  await expect(entry).toContainText(/\d{1,2}:\d{2}/);
  await expect(entry).not.toContainText("recorded");

  // ── The same ⋯ row actions the medication history offers ───────────────────
  await entry.getByRole("button", { name: "Dose actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Edit" }).click();

  // ── The amendment round-trips: the snapshotted amount is corrected in place ─
  const form = panel.getByTestId("historical-dose-form");
  await expect(form).toContainText("won’t change the schedule either");
  // The editor seeds from occurred_at only. This proves the stated administration
  // is editable without treating recorded_at as an administration time.
  await expect(form.getByTestId("historical-dose-time")).toHaveValue(
    /\d{2}:\d{2}/
  );
  await form.getByLabel("Amount").fill("375 mg");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toHaveCount(0);
  await expect(panel.getByTestId("dose-history-row")).toContainText("375 mg");
  // An amount-only amendment preserves the existing stated administration.
  await expect(panel.getByTestId("dose-history-row")).not.toContainText(
    "recorded"
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
test("the supplements tab reaches the cross-item record and logs a past dose from it", async ({
  page,
}, testInfo) => {
  const name = `Ledger Guard ${testInfo.repeatEachIndex}-${testInfo.retry}`;
  await page.goto("/nutrition?tab=supplements");

  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(name);
  const doseEditor5 = await openFact(page, "dose", addDialog);
  await doseEditor5.getByLabel("Amount").first().fill("125 mg"); // first-ok: the first (only) dose's Amount field in the scoped add modal
  await doseEditor5.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first (only) dose's Time-of-day field in the scoped add modal
  await closeEditor(page, addDialog);
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

  // ── ONE click from the supplements tab to the whole record ────────────────
  // The door used to open a route of its own; #3958 folded the four ledgers into
  // `/history`, and the door now carries the kind AND the surface's own pre-filter
  // as params on one page.
  await followLink(
    page,
    page.getByTestId("dose-ledger-link"),
    /\/history\?kind=dose&class=supplement/
  );
  const ownRow = page.getByTestId("history-row").filter({ hasText: name });
  await expect(ownRow).toHaveCount(1);
  await expect(ownRow).toContainText("125 mg");

  // ── "Log past dose" without opening any item's menu ────────────────────────
  // The record's Add door IS this kind's backfill when the page is filtered to it.
  await hydratedClick(page, page.getByTestId("dose-ledger-add"));
  const picker = page.getByTestId("dose-ledger-item-picker");
  const itemValue = await picker
    .locator("option")
    .filter({ hasText: name })
    .getAttribute("value");
  await picker.selectOption(itemValue ?? "");
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
  await expect(
    page.getByTestId("history-row").filter({ hasText: name })
  ).toHaveCount(2);
  await expect(
    page
      .getByTestId("history-row")
      .filter({ hasText: name })
      .filter({ hasText: "175 mg" })
  ).toContainText(/(?:6:45am|06:45)/);

  // ── The record says exactly what the item's own panel says ────────────────
  await page.goto("/nutrition?tab=supplements");
  await row.getByRole("button", { name: "Supplement actions" }).click();
  await page.getByRole("menuitem", { name: "Dose history" }).click();
  const panel = row.getByTestId("supplement-dose-history-panel");
  await expect(panel.getByTestId("dose-history-row")).toHaveCount(2);
  await expect(
    panel.getByTestId("dose-history-row").filter({ hasText: "175 mg" })
  ).toHaveCount(1);
});

// Issue #2445's ledger-pager test LEFT WITH THE PAGER (#3958). The cross-item ledger
// and its numbered pages are gone: the record is navigated, not paged, so the bound it
// asserted is now `?show` plus the month folds, and e2e/history.spec.ts asserts it
// there against the surface that actually has one.

// Issue #3674 — "Log past dose" stops opening a blank form for a write the app has
// already worked out. The adherence strip the card renders holds, dated, exactly the
// days this item had a due dose and nothing logged; the control presents those days
// as one-tap rows that post the SAME backfill action the form posts, with the form
// itself behind "Another date…".
test("the backfill offers the missed days the strip already computed (#3674)", async ({
  page,
}, testInfo) => {
  const name = `Missed Days ${testInfo.repeatEachIndex}-${testInfo.retry}`;

  await page.goto("/nutrition?tab=supplements");
  await page.getByTestId("supplement-add-toggle").click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  await addDialog.getByLabel("Name").fill(name);
  const doseEditor = await openFact(page, "dose", addDialog);
  await doseEditor.getByLabel("Amount").first().fill("250 mg"); // first-ok: the first (only) dose's Amount field in the scoped add modal
  await doseEditor.getByLabel("Time of day").first().selectOption("Morning"); // first-ok: the first (only) dose's Time-of-day field in the scoped add modal
  await closeEditor(page, addDialog);
  await addDialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(addDialog).toHaveCount(0);

  // AN ITEM CREATED NOW HAS NO MISSED DAYS AT ALL — the #1442 lifetime clamp scores a
  // day only against doses that already existed on it, which is the whole reason a
  // cold start reads "no history" instead of 0%. So the fixture is the LIFETIME:
  // backdate it four days and log nothing, and the strip reads those four days as
  // lapses. Four rather than fourteen keeps this item's footprint small on a shared
  // profile, and keeps the offer list short enough to count.
  const MISSED_DAYS = 4;
  const anchor = frozenNow().toISOString().slice(0, 10);
  const { zone } = pinnedTimezone(frozenNow().toISOString());
  const born = zonedWallTimeToUtc(
    zone,
    shiftDateStr(anchor, -MISSED_DAYS),
    "07:00"
  )!;
  const bornSql = born.toISOString().slice(0, 19).replace("T", " ");
  const handle = new Database(workerDbPath());
  try {
    handle.pragma("busy_timeout = 5000");
    const item = handle
      .prepare("SELECT id FROM intake_items WHERE name = ?")
      .get(name) as { id: number };
    handle
      .prepare("UPDATE intake_items SET created_at = ? WHERE id = ?")
      .run(bornSql, item.id);
    handle
      .prepare("UPDATE intake_item_doses SET created_at = ? WHERE item_id = ?")
      .run(bornSql, item.id);
  } finally {
    handle.close();
  }

  await page.goto("/nutrition?tab=supplements");
  const row = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Morning" }) })
    .locator("div.card")
    .filter({ hasText: name });
  await hydratedClick(
    page,
    row.getByRole("button", { name: "Supplement actions" })
  );
  await page.getByRole("menuitem", { name: "Dose history" }).click();
  const panel = row.getByTestId("supplement-dose-history-panel");
  const control = panel.getByRole("button", { name: "Log past dose" });

  // ── The offer, not a form ──────────────────────────────────────────────────
  await hydratedClick(page, control);
  const offers = panel.getByTestId("dose-backfill-offer");
  // Today is still in progress, so it is not among them: four elapsed lapses.
  await expect(offers).toHaveCount(MISSED_DAYS);
  await expect(panel.getByTestId("historical-dose-form")).toHaveCount(0);
  // Newest first, and each row names EXACTLY what the tap will write. This dose's
  // slot is the bucket word "Morning", which is not a clock and so cannot be
  // written: the row therefore names the day and the amount and says nothing about
  // a time, rather than printing "morning" over a write that records the default.
  const newest = offers.first(); // first-ok: the offer list of a supplement this spec created and backdated itself; newest-first by construction, so this is yesterday
  await expect(newest).toContainText("250 mg");
  await expect(newest).not.toContainText("Morning");
  // ONE identity: the control does not become "Cancel" because it is open.
  await expect(control).toHaveText("Log past dose");
  await expect(control).toHaveAttribute("aria-expanded", "true");

  // ── The tap IS the write, through the form's own action ────────────────────
  await settledClick(page, newest);
  await expect(page.getByText(`Logged past dose of ${name}.`)).toBeVisible();
  const history = panel.getByTestId("dose-history-row");
  await expect(history).toHaveCount(1);
  await expect(history).toContainText("250 mg");

  // ...and the day it wrote is gone from the next offer, because the strip that
  // produced the list now says the dose was taken. Nothing was re-derived to make
  // that true — one computation, read twice.
  await hydratedClick(page, control);
  await expect(offers).toHaveCount(MISSED_DAYS - 1);

  // ── "Another date…" holds the unchanged form ───────────────────────────────
  await panel.getByTestId("dose-backfill-other").click();
  await expect(panel.getByTestId("historical-dose-form")).toBeVisible();
  await expect(control).toHaveText("Log past dose");

  // ── ...and when the slot IS a clock, the row names it and writes it ────────
  // The other arm of the same rule. Written straight to the dose row because the
  // schedule editor offers the bucket words; what is under test is the OFFER's
  // reading of stored slot text, not how the text got there.
  const flip = new Database(workerDbPath());
  try {
    flip.pragma("busy_timeout = 5000");
    flip
      .prepare(
        `UPDATE intake_item_doses SET time_of_day = '08:00'
          WHERE item_id = (SELECT id FROM intake_items WHERE name = ?)`
      )
      .run(name);
  } finally {
    flip.close();
  }
  await page.goto("/nutrition?tab=supplements");
  // The row LEFT the Morning section — a clock slot groups under its own window — so
  // it is re-found by the name this spec owns rather than by where it used to sit.
  const clockRow = page.locator("div.card").filter({ hasText: name });
  await expect(clockRow).toHaveCount(1);
  await hydratedClick(
    page,
    clockRow.getByRole("button", { name: "Supplement actions" })
  );
  await page.getByRole("menuitem", { name: "Dose history" }).click();
  const clockPanel = clockRow.getByTestId("supplement-dose-history-panel");
  await hydratedClick(
    page,
    clockPanel.getByRole("button", { name: "Log past dose" })
  );
  const clockOffer = clockPanel.getByTestId("dose-backfill-offer").first(); // first-ok: same spec-owned offer list, newest first
  await expect(clockOffer).toContainText(/(?:8:00am|08:00)/);
  await settledClick(page, clockOffer);
  await expect(page.getByText(`Logged past dose of ${name}.`)).toBeVisible();
  // The row the label promised: the dose's own slot clock, not the panel's default.
  await expect(
    clockPanel
      .getByTestId("dose-history-row")
      .filter({ hasText: /(?:8:00am|08:00)/ })
  ).toHaveCount(1);
});
