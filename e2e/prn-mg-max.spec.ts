import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { hydratedClick } from "./helpers";

// Amount-aware PRN max-dose accounting (issue #1854). The family-wide counters
// (#1027) made "a dose" span a 4× strength range — 200 mg OTC ibuprofen and 800 mg
// Rx ibuprofen are the same ingredient — so the confirmed daily max gained a
// milligram form (`max_daily_amount_mg`, migration 140) beside the count form.
// These specs assert the two rendered halves:
//   • the `prn-max:` care finding fires on SUMMED SNAPSHOTTED MILLIGRAMS when the
//     mg/day max is confirmed and the amounts are known — 3 × 800 mg = 2400 mg
//     against a 1200 mg/day ceiling that "3 of 6 doses" would have read as calm —
//     and its copy states the mg basis, never a dose count;
//   • the med form's "Maximum mg per day" field round-trips through save/edit.
//
// Each test owns its fixture rows (unique names on profile 1, idempotent cleanup
// in beforeEach + finally) and asserts only on those; dates derive from
// frozenNow(), never wall-clock. Synthetic data, no PHI.

const OTC_NAME = "E2e Mg Ibuprofen";
const RX_NAME = "E2e Mg Ibuprofen 800 mg"; // same cleaned-name family as OTC_NAME

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

// The frozen run instant as the app-side calendar day (the same UTC slice the
// other intake specs stamp their fixture logs with).
function frozenDay(): string {
  return frozenNow().toISOString().slice(0, 10);
}

function utcSql(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function deleteFixtureRows(db: Database.Database): void {
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN
       (SELECT id FROM intake_items WHERE profile_id = 1 AND name IN (?, ?))`
  ).run(OTC_NAME, RX_NAME);
  db.prepare(
    `DELETE FROM intake_item_doses WHERE item_id IN
       (SELECT id FROM intake_items WHERE profile_id = 1 AND name IN (?, ?))`
  ).run(OTC_NAME, RX_NAME);
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = 1 AND name IN (?, ?)`
  ).run(OTC_NAME, RX_NAME);
}

// The issue's mixed-strength pair on profile 1: the OTC member carries the
// confirmed ceilings (6h interval, a loose count max of 6, and the 1200 mg/day
// amount max), the 800 mg Rx member is unconfigured — its administrations still
// count into the family math (#1027). Returns the OTC item id (the finding's
// anchor: it holds the binding mg max).
function seedMixedStrengthPair(db: Database.Database): number {
  const otcId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            min_interval_hours, max_daily_count, max_daily_amount_mg)
         VALUES (1, ?, 1, 'medication', 'daily', 'may', 6, 6, 1200)`
      )
      .run(OTC_NAME).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '200 mg', 'anytime', 'any', 0)`
  ).run(otcId);
  const rxId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (1, ?, 1, 'medication', 'daily', 'may')`
      )
      .run(RX_NAME).lastInsertRowid
  );
  const rxDoseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '800 mg', 'anytime', 'any', 0)`
      )
      .run(rxId).lastInsertRowid
  );
  // Three 800 mg administrations today, amounts snapshotted (the confirm-dose
  // invariant): 2400 mg — twice the mg ceiling, yet only "3 of 6" by count.
  for (const backMs of [10_800_000, 7_200_000, 3_600_000]) {
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at, status, amount)
       VALUES (?, ?, ?, ?, 'taken', '800 mg')`
    ).run(
      rxDoseId,
      rxId,
      frozenDay(),
      utcSql(new Date(frozenNow().getTime() - backMs))
    );
  }
  return otcId;
}

test.beforeEach(() => {
  const db = openDb();
  try {
    deleteFixtureRows(db); // idempotent — a failed earlier run leaves no residue
  } finally {
    db.close();
  }
});

test("the over-max finding fires on summed milligrams and states the mg basis", async ({
  page,
}) => {
  const db = openDb();
  let otcId: number;
  try {
    otcId = seedMixedStrengthPair(db);
  } finally {
    db.close();
  }

  try {
    await page.goto("/upcoming");
    const finding = page.getByTestId(`upcoming-item-prn-max:${otcId}`);
    await expect(finding).toBeVisible();
    await expect(finding).toContainText(`${OTC_NAME} — over your daily max`);
    // Milligram copy — summed exposure vs the mg/day ceiling, both members
    // named, and NEVER a dose-count framing (the basis is stated, #1854).
    await expect(finding).toContainText("2400 mg logged today");
    await expect(finding).toContainText(
      "most conservative confirmed max of 1200 mg per day"
    );
    await expect(finding).toContainText(RX_NAME);
    await expect(finding).not.toContainText("doses logged");

    // The intake surface phrases the SAME verdict on the SAME basis (one
    // computation): the OTC card's redose line reads milligrams, at max.
    await page.goto("/medications");
    const redoseLine = page
      .getByTestId("quick-log-prn-item")
      .filter({ hasText: OTC_NAME })
      .getByTestId("prn-redose-line");
    await expect(redoseLine).toContainText("Max reached");
    await expect(redoseLine).toContainText("2400 of 1200 mg today");
    await expect(redoseLine).toContainText("across 2 items");
  } finally {
    const cleanup = openDb();
    try {
      deleteFixtureRows(cleanup);
    } finally {
      cleanup.close();
    }
  }
});

test("the mg/day max round-trips through the medication edit form", async ({
  page,
}) => {
  const db = openDb();
  let otcId: number;
  try {
    otcId = seedMixedStrengthPair(db);
  } finally {
    db.close();
  }

  try {
    await page.goto(`/medications/${otcId}?action=edit`);
    const form = page
      .locator("form")
      .filter({ has: page.getByTestId("redose-max-mg") });
    const mgInput = form.getByTestId("redose-max-mg");
    // The stored ceiling is loaded beside the count max…
    await expect(mgInput).toHaveValue("1200");
    await expect(form.getByTestId("redose-max")).toHaveValue("6");
    // …and an edit persists. The card fires other POSTs while the form is open
    // (RxNorm resolution), so "the save settled" is asserted by ITS OWN UI
    // signal — a successful action closes the edit form (onDone) — rather than
    // by the first same-origin POST response.
    await mgInput.fill("2400");
    await hydratedClick(page, form.getByRole("button", { name: "Save" }));
    await expect(mgInput).toBeHidden({ timeout: 20_000 });

    await page.goto(`/medications/${otcId}?action=edit`);
    await expect(page.getByTestId("redose-max-mg")).toHaveValue("2400");

    const check = openDb();
    try {
      const row = check
        .prepare(
          "SELECT max_daily_amount_mg AS mg FROM intake_items WHERE id = ?"
        )
        .get(otcId) as { mg: number | null };
      expect(row.mg).toBe(2400);
    } finally {
      check.close();
    }
  } finally {
    const cleanup = openDb();
    try {
      deleteFixtureRows(cleanup);
    } finally {
      cleanup.close();
    }
  }
});
