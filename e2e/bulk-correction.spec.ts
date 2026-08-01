import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink, settledClick, settledSelect } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_BULKFIX,
  BULKFIX_PROFILE,
} from "./fixture-logins";
import { workerDbPath, frozenNow } from "./worker-env";

// Bulk corrections (#1603): Data → Review's "Fix a run of data" panel walks the
// whole plan → preview → apply → undo chassis in the browser against the real
// lb-as-kg story — a Withings run whose weights landed as pounds-labeled-kg.
// Preview must say the #133 edit-lock consequence plainly, apply must correct
// only the selected run (the manual row in the same range is untouched) and lock
// every corrected imported row, and undo must restore before-values while
// leaving a row that was edited AFTER the correction alone.
//
// Fixture hygiene (#868): the dedicated Bulk Fix profile is seeded with NO rows;
// this spec owns every body_metrics row (and bulk-correction undo token) on it
// and re-seeds them at test start, so --repeat-each starts identically. Dates are
// a CONSECUTIVE run of days ending five days before the frozen clock —
// week-mode-agnostic by construction.

const SRC = "withings";
// The bad run, oldest first: plausible pounds figures stored as "kg".
const RUN_LB = [176.4, 178.2, 175.0, 177.6, 174.8, 176.0];
const LB_PER_KG = 2.2046226218;
const MANUAL_KG = 80.5;

function dayStr(daysAgo: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
// Six consecutive days, ending five days before frozen "today".
const RUN_DATES = RUN_LB.map((_, i) => dayStr(10 - i));

interface SeededRun {
  profileId: number;
  runIds: number[];
  manualId: number;
}

// Reset THIS profile's rows and insert the fixture run + one manual row inside
// the same date range (which the source-scoped correction must never touch).
function seedRun(): SeededRun {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profileId = (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(BULKFIX_PROFILE) as {
        id: number;
      }
    ).id;
    db.prepare("DELETE FROM body_metrics WHERE profile_id = ?").run(profileId);
    db.prepare(
      "DELETE FROM deleted_rows WHERE profile_id = ? AND kind = 'bulk-correction'"
    ).run(profileId);
    const ins = db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
       VALUES (?, ?, ?, ?)`
    );
    const runIds = RUN_LB.map((v, i) =>
      Number(ins.run(profileId, RUN_DATES[i], v, SRC).lastInsertRowid)
    );
    const manualId = Number(
      ins.run(profileId, dayStr(7), MANUAL_KG, null).lastInsertRowid
    );
    return { profileId, runIds, manualId };
  } finally {
    db.close();
  }
}

function readWeights(
  ids: number[]
): { id: number; weight_kg: number; edited: number }[] {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return ids.map(
      (id) =>
        db
          .prepare(
            "SELECT id, weight_kg, edited FROM body_metrics WHERE id = ?"
          )
          .get(id) as { id: number; weight_kg: number; edited: number }
    );
  } finally {
    db.close();
  }
}

function editRow(id: number, weightKg: number): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "UPDATE body_metrics SET weight_kg = ?, edited = 1 WHERE id = ?"
    ).run(weightKg, id);
  } finally {
    db.close();
  }
}

test("preview → apply → undo corrects an lb-as-kg run, locks it, and skips later edits (#1603)", async ({
  browser,
}) => {
  const { runIds, manualId } = seedRun();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_BULKFIX,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/data?section=review");
    const card = page.getByTestId("bulk-correction-card");
    await expect(card).toBeVisible();

    // Pick the Withings run; the range prefills to the run's full span (the
    // DateField renders it in the pref-aware display format, so assert
    // non-empty), which also proves the change landed in React state rather
    // than being a pre-hydration no-op.
    await settledSelect(page, page.getByTestId("bulk-correction-source"), SRC);
    await expect(page.getByTestId("bulk-correction-from")).not.toHaveValue("");
    await expect(page.getByTestId("bulk-correction-to")).not.toHaveValue("");

    // The units case: the lb→kg preset (a wired multiply, not freeform math).
    await settledSelect(
      page,
      page.getByTestId("bulk-correction-op"),
      "unit-preset"
    );

    await settledClick(page, page.getByTestId("bulk-correction-preview"));
    await expect(page.getByTestId("bulk-correction-summary")).toContainText(
      "6 rows"
    );
    // The #133 consequence, said plainly before anything is written.
    await expect(page.getByTestId("bulk-correction-lock-note")).toContainText(
      "6 rows came from Withings"
    );
    await expect(page.getByTestId("bulk-correction-lock-note")).toContainText(
      "stop receiving sync updates"
    );

    await settledClick(page, page.getByTestId("bulk-correction-apply"));
    await expect(page.getByTestId("bulk-correction-applied")).toContainText(
      "Corrected 6 rows."
    );

    // Server truth: every run row converted lb→kg and edit-locked; the manual
    // row in the same date range untouched (different source), never locked.
    const afterApply = readWeights(runIds);
    for (let i = 0; i < runIds.length; i++) {
      expect(afterApply[i].weight_kg).toBeCloseTo(RUN_LB[i] / LB_PER_KG, 4);
      expect(afterApply[i].edited).toBe(1);
    }
    const [manualRow] = readWeights([manualId]);
    expect(manualRow.weight_kg).toBe(MANUAL_KG);
    expect(manualRow.edited).toBe(0);

    // One row is hand-edited AFTER the correction; undo must leave it alone.
    editRow(runIds[2], 81.2);
    await settledClick(page, page.getByTestId("bulk-correction-undo"));
    await expect(page.getByTestId("bulk-correction-notice")).toContainText(
      "Restored 5 rows"
    );
    await expect(page.getByTestId("bulk-correction-notice")).toContainText(
      "1 row changed since this correction and was left alone"
    );

    const afterUndo = readWeights(runIds);
    for (let i = 0; i < runIds.length; i++) {
      if (i === 2) continue;
      expect(afterUndo[i].weight_kg).toBeCloseTo(RUN_LB[i], 6);
      expect(afterUndo[i].edited).toBe(0); // the lock THIS correction set is cleared
    }
    // The later edit stands, lock and all — never clobbered by undo.
    expect(afterUndo[2].weight_kg).toBe(81.2);
    expect(afterUndo[2].edited).toBe(1);
  } finally {
    await page.context().close();
  }
});

test("the Body weight chart's 'Fix a range' link lands on the panel with weight pre-selected (#1603)", async ({
  browser,
}) => {
  seedRun();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_BULKFIX,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/trends");
    await followLink(
      page,
      page.getByTestId("body-weight-fix-range"),
      /\/data\?section=review&fix=weight/
    );
    await expect(page.getByTestId("bulk-correction-card")).toBeVisible();
    await expect(page.getByTestId("bulk-correction-field")).toHaveValue(
      "weight"
    );
  } finally {
    await page.context().close();
  }
});
