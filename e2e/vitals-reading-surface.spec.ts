import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import {
  followLink,
  hydratedClick,
  openMeasurementGroup,
  settledClick,
  settledFill,
} from "./helpers";
import { loginAs } from "./nav";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  E2E_LOGIN_VITALS_DAY,
  E2E_MEMBER_PASSWORD,
  VITALS_DAY_PROFILE,
} from "./fixture-logins";

// One renderer per cadence (#1932). A vital sign is stored with `category = 'vitals'`
// and was rendered through the LAB detail page anyway — a permanently-empty "Lab
// reference" column, a duplicate optimal range, and a whole-history spline drawn
// across years where nothing was measured. The discriminator existed in the data and
// nothing in the presentation consumed it.
//
// This spec pins the routing from the browser's side: a continuous vital opens on the
// metric detail surface (windowed chart, rolling summary, readings table), the lab
// renderer never draws one, and the panel cross-reference still crosses — while an
// EPISODIC reading that also carries `category = 'vitals'` (a functional-fitness
// marker, an audiogram threshold) keeps the reference-range page, because the rule is
// cadence and not category.
//
// Fixture (#868 hygiene): the dedicated E2E_LOGIN_VITALS_DAY profile, whose
// vitals (SpO2, blood pressure, respiratory rate, body temperature) live nowhere else,
// so --repeat-each and a neighbour's writes can't move them. The #1932 routing
// tests are navigation-only; the #2154 intraday spec below writes ONLY manual BP
// rows it owns outright and clears them again (the seeded rows are never touched).

async function vitalsDayPage(browser: Parameters<typeof loginAs>[0]) {
  return loginAs(browser, {
    username: E2E_LOGIN_VITALS_DAY,
    password: E2E_MEMBER_PASSWORD,
  });
}

test.describe("a vital renders on its own cadence's surface (#1932)", () => {
  test("the biomarkers list opens a vital on the metric detail surface", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    await page.goto("/results/biomarkers");

    // The reading is listed in the catalog exactly as before — what changed is
    // where its name goes.
    const row = page.getByRole("link", { name: "Oxygen Saturation" });
    await followLink(page, row, /\/trends\/metric\/spo2/);

    await expect(page.getByTestId("metric-detail-page")).toBeVisible();
    // The two things the lab page could not give a daily reading: a windowed chart
    // and the trailing 7/30/90-day summary (#1909).
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    await expect(page.getByTestId("metric-period-stats")).toBeVisible();
    // …and the readings themselves, one tap from the chart they shape.
    await expect(page.getByTestId("metric-readings-table")).toBeVisible();
  });

  test("a stale biomarker URL for a vital lands on that surface, and the lab renderer never draws one", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    // What a bookmark or a shared link from before #1932 looks like.
    await page.goto("/biomarkers/view?name=Oxygen%20Saturation");
    await page.waitForURL(/\/trends\/metric\/spo2/);

    await expect(page.getByTestId("metric-detail-page")).toBeVisible();
    // The tripwire: none of the lab page's furniture may appear for a vital. A
    // vital has no lab-issued reference range and no reporting lab, so these
    // columns could never populate — that is why they are gone rather than empty.
    await expect(
      page.getByRole("columnheader", { name: "Lab reference" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: "Reported as" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Back to biomarkers" })
    ).toHaveCount(0);
  });

  test("the panel cross-reference stays, and each sibling opens on its own surface", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    await page.goto("/trends/metric/spo2");

    const panel = page.getByTestId("panel-siblings");
    await expect(panel).toContainText("Vital signs");
    // The card is the one thing the lab page did right here — the reading arrived
    // with a blood pressure, and saying so is genuinely useful. The chip resolves
    // through the same helper, so it lands on the sibling's OWN surface.
    await followLink(
      page,
      panel.getByRole("link", { name: "Blood Pressure Systolic" }),
      /\/trends\/metric\/systolic/
    );
    await expect(page.getByTestId("metric-detail-page")).toBeVisible();
  });

  test("an episodic reading keeps the reference-range page, category='vitals' or not", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    // Grip strength is `category = 'vitals'` too, and belongs on the lab renderer:
    // it is an annual physical test read by an age/sex percentile, not a stream. If
    // the rule ever collapses back into a category check, this redirects and fails.
    await page.goto("/biomarkers/view?name=Grip%20Strength");

    await expect(page).toHaveURL(/\/biomarkers\/view/);
    await expect(
      page.getByRole("link", { name: "Back to biomarkers" })
    ).toBeVisible();
  });
});

test.describe("the intraday chart reads the reading's own occurred_at (#2154)", () => {
  // The vitals-day profile's TODAY (the pinned zone keeps the local date equal to
  // the frozen instant's UTC date — see e2e/pinned-timezone.ts).
  const TODAY = frozenNow().toISOString().slice(0, 10);
  // A LATE-MORNING manual reading beside the fixture's imported 07:10 one. The
  // run's frozen local clock is pinned at 13:mm, so the latest honestly statable
  // time today sits just before 13:00 — the acceptance gate refuses a future
  // statement, which is exactly the contract.
  const MANUAL_HHMM = "12:45";
  const MANUAL_SYS = "135";

  function vdProfileId(handle: InstanceType<typeof Database>): number {
    const row = handle
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(VITALS_DAY_PROFILE) as { id: number } | undefined;
    expect(row, `no profile named ${VITALS_DAY_PROFILE}`).toBeDefined();
    return row!.id;
  }

  // This spec owns the profile's MANUAL BP rows outright (the seed writes only
  // 'health-connect' ones), so clearing them restores the shared baseline exactly
  // — the Today-strip assertions in trends-vitals.mobile.spec.ts depend on it.
  function clearManualBp(): void {
    const handle = new Database(workerDbPath());
    try {
      handle
        .prepare(
          `DELETE FROM medical_records
            WHERE profile_id = ? AND source = 'manual'
              AND canonical_name LIKE 'Blood Pressure %'`
        )
        .run(vdProfileId(handle));
    } finally {
      handle.close();
    }
  }

  // Hover the slot a minute-of-day falls in, on the chart's own plot area (the
  // CartesianGrid box), so recharts snaps its tooltip to that category. The
  // intraday x-axis is the fixed 288-slot 5-minute grid (lib/vitals-day.ts).
  async function expectReadingAt(
    card: import("@playwright/test").Locator,
    minute: number,
    value: string,
    hhmm: string
  ): Promise<void> {
    const grid = card.locator(".recharts-cartesian-grid");
    const tooltip = card.locator(".recharts-tooltip-wrapper");
    await expect(async () => {
      const box = await grid.boundingBox();
      if (!box) throw new Error("no intraday plot area");
      const slots = 288;
      const slot = Math.floor(minute / 5);
      const x = box.x + ((slot + 0.5) / slots) * box.width;
      const y = box.y + box.height / 2;
      await card.page().mouse.move(x, y);
      await expect(tooltip).toContainText(hhmm, { timeout: 2_000 });
      await expect(tooltip).toContainText(value, { timeout: 2_000 });
    }).toPass({ timeout: 10_000 }); // topass-ok: recharts opens the tooltip only after a hover mousemove — re-hover per attempt, no single awaitable render event (the kids-growth precedent)
  }

  test("a manual late-morning BP plots at its hour beside the imported morning one", async ({
    browser,
  }) => {
    test.slow();
    clearManualBp();
    const page = await vitalsDayPage(browser);
    try {
      // Log the manual BP through the real form, stating the time via the ONE
      // shared WhenControl — the write path that lands occurred_at.
      await page.goto("/trends");
      await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
      const form = page.getByTestId("measurements-quick-add");
      await expect(form).toBeVisible();
      await openMeasurementGroup(page, form, "vitals");
      await settledFill(page, form.locator("#m-systolic"), MANUAL_SYS);
      await settledFill(page, form.locator("#m-diastolic"), "88");
      await settledFill(page, form.getByTestId("m-time"), MANUAL_HHMM);
      await settledClick(
        page,
        form.getByRole("button", { name: "Save measurements" })
      );
      await expect(page.getByText("Measurements saved")).toBeVisible();

      // Server truth first: the statement round-tripped onto the observation
      // rows in the canonical shape, on the row's own day.
      {
        const handle = new Database(workerDbPath());
        try {
          const rows = handle
            .prepare(
              `SELECT occurred_at FROM medical_records
                WHERE profile_id = ? AND date = ? AND source = 'manual'
                  AND canonical_name LIKE 'Blood Pressure %'`
            )
            .all(vdProfileId(handle), TODAY) as {
            occurred_at: string | null;
          }[];
          expect(rows).toHaveLength(2);
          for (const row of rows) {
            expect(row.occurred_at).toMatch(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
            );
          }
        } finally {
          handle.close();
        }
      }

      // The 1D window: the systolic intraday chart positions BOTH readings on
      // the clock axis — the manual one at ITS stated hour (from occurred_at),
      // the imported one at the hour its sync stated (the fixture's 07:10 row,
      // a pre-#2154 device row the legacy external_id fallback still serves).
      await page.goto(`/trends?from=${TODAY}&to=${TODAY}`);
      const card = page.getByTestId("vitals-intraday-bp");
      await expect(card).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await expectReadingAt(card, 12 * 60 + 45, MANUAL_SYS, MANUAL_HHMM);
      await expectReadingAt(card, 7 * 60 + 10, "118", "07:10");
    } finally {
      await page.context().close();
      clearManualBp();
    }
  });
});
