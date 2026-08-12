import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";
import { plateauSignalKey } from "@/lib/training-observations";

// The dedicated plateaued lift seeded for this spec (e2e/seed/findings.ts).
const DISMISS_PRESS = "E2E Dismiss Press";

// Issue #449 — the four #45 observational domains (training balance/plateau,
// body-metric hygiene, goal pacing, adherence patterns) render only on their own
// tabs. The dashboard "Coaching observations" rollup gives them REACH WITHOUT NOISE:
// the SAME findings (one computation, collectCoachingFindings) surface as a calm,
// hideable dashboard widget, and a dismiss there silences the finding on its origin
// tab too (shared findings bus). The seed + e2e fixtures ship a plateaued Skullcrusher,
// a 92 kg weight glitch, and off-pace weight goals, so the rollup has content on the
// seeded DB.

// Clears any coaching-observation dismissals so the rollup is guaranteed populated
// before each assertion, regardless of retries or prior runs against the shared
// seeded DB (the resetPreventiveFixture pattern from #206: a dismissal persists in
// upcoming_dismissals). BLAST RADIUS: only the four rule-findings namespaces (training
// plateaus, body hygiene, goal pacing, adherence) — the same signal keys the tab specs
// (rule-findings.spec.ts, adherence-patterns.spec.ts) also reset, so it never touches
// preventive/dose/biomarker suppressions other specs depend on. Short-lived
// connection, busy timeout so it never contends with the running server (WAL).
function resetCoachingObservationDismissals(): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `DELETE FROM upcoming_dismissals
       WHERE signal_key LIKE 'training-obs:%'
          OR signal_key LIKE 'body-hygiene:%'
          OR signal_key LIKE 'goal-pace:%'
          OR signal_key LIKE 'adherence:%'`
    ).run();
  } finally {
    db.close();
  }
}

test("the dashboard surfaces tab-only coaching observations (#449)", async ({
  page,
}) => {
  resetCoachingObservationDismissals();
  await page.goto("/");

  const rollup = page.getByRole("main").getByTestId("coaching-observations");
  await expect(rollup).toBeVisible();
  // The plateaued Skullcrusher lives on Training → Overview; here it's reachable
  // from the dashboard without opening that tab.
  await expect(rollup).toContainText("Skullcrusher");
});

test("dismissing a coaching observation from the dashboard removes it (#449)", async ({
  page,
}) => {
  resetCoachingObservationDismissals();
  await page.goto("/");

  const rollup = page.getByRole("main").getByTestId("coaching-observations");
  await expect(rollup).toBeVisible();

  // Target the DEDICATED "E2E Dismiss Press" plateau (seed-events.ts), NOT the
  // Skullcrusher one rule-findings.spec.ts asserts — "dismiss once, silence
  // everywhere" writes to the shared store, so dismissing Skullcrusher here would
  // also hide it on Training → Overview and fail that later spec. Other domains'
  // rows legitimately remain after this dismiss.
  const row = rollup
    .getByTestId("coaching-observations-item")
    .filter({ hasText: "E2E Dismiss Press" });
  await expect(row).toBeVisible();

  // Settled (#868): a bare click here can land in the pre-hydration window and be
  // swallowed, which shows up as "the row never left" under a loaded suite run.
  await settledClick(page, row.getByTestId("coaching-observations-dismiss"));

  // Dismiss writes to the shared suppression store, so THIS finding is gone from
  // the rollup after the re-render.
  await expect(
    rollup
      .getByTestId("coaching-observations-item")
      .filter({ hasText: "E2E Dismiss Press" })
  ).toHaveCount(0);
});

// Issue #2386 — repeat dismissal is read as an ANSWER. A topic the user has declined
// across separate raisings stops leading on the dashboard (the routine surface), and a
// sustained pattern retires it from that surface while leaving it fully rendered on its
// own tab, which is where the user goes looking. The rows below stand in for past
// raisings of the SAME plateau at other working weights — plateaus at other load
// buckets, each raised at the time and each declined.
//
// Uses the dedicated "E2E Dismiss Press" lift, the one this spec owns precisely because
// it mutates the shared suppression store; the Skullcrusher plateau rule-findings.spec
// asserts is untouched. Every row this test writes is one it created and removes.
// e1RM level buckets far from the live plateau's own anchor (30 kg × 10 ≈ 40 kg e1RM,
// bucket 8), so every row here is unambiguously a PAST raising and never the current
// key — otherwise the test would be measuring plain suppression, not fatigue.
const PAST_LOAD_BUCKETS = ["2", "3", "18", "19"] as const;

function declinePastRaisings(n: number): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const ins = db.prepare(
      `INSERT OR REPLACE INTO upcoming_dismissals
         (profile_id, signal_key, snooze_until, dismissed_at)
       VALUES (1, ?, NULL, datetime('now'))`
    );
    for (const bucket of PAST_LOAD_BUCKETS.slice(0, n))
      ins.run(plateauSignalKey(DISMISS_PRESS, bucket));
  } finally {
    db.close();
  }
}

test("repeat dismissal de-prioritises, then retires, a coaching topic (#2386)", async ({
  page,
}) => {
  resetCoachingObservationDismissals();

  const rollup = page.getByRole("main").getByTestId("coaching-observations");
  const lead = rollup.getByTestId("coaching-observations-item");

  // Never declined: it is raised routinely, in the lead slice.
  await page.goto("/");
  await expect(rollup).toBeVisible();
  await expect(lead.filter({ hasText: DISMISS_PRESS })).toHaveCount(1);

  // Two separate raisings declined → it stops LEADING: still rendered, behind every
  // topic the user has not answered.
  declinePastRaisings(2);
  await page.goto("/");
  await expect(rollup).toContainText(DISMISS_PRESS);
  await expect(lead.filter({ hasText: DISMISS_PRESS })).toHaveCount(0);
  await expect(
    rollup
      .getByTestId("coaching-observations-more-item")
      .filter({ hasText: DISMISS_PRESS })
  ).toHaveCount(1);

  // Four → retired from the routine surface altogether.
  declinePastRaisings(4);
  await page.goto("/");
  await expect(rollup).toBeVisible();
  await expect(rollup).not.toContainText(DISMISS_PRESS);

  // …and still reachable where the user goes looking. Nothing was silenced: the
  // finding renders in full on Training → Overview, its own tab.
  await page.goto("/training?tab=overview");
  await expect(
    page.getByRole("main").getByTestId("training-findings")
  ).toContainText(DISMISS_PRESS);

  resetCoachingObservationDismissals();
});
