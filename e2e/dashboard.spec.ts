import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DAILY,
  E2E_LOGIN_DASHBOARD_ALL,
  E2E_LOGIN_SICK_SELF,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { openDashboardAll, settledClick } from "./helpers";

function resetDashboardAllOffer(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT p.id
           FROM profiles p
           JOIN login_profiles lp ON lp.profile_id = p.id
           JOIN logins l ON l.id = lp.login_id
          WHERE l.username = ?`
      )
      .get(E2E_LOGIN_DASHBOARD_ALL) as { id: number };
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'stream-onboard:%'"
    ).run(profile.id);
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'wear_reminder_enabled'"
    ).run(profile.id);
  } finally {
    db.close();
  }
}

function setSecondDashboardNap(enabled: boolean): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const seededNap = db
      .prepare(
        `SELECT profile_id, date, started_at
           FROM metric_samples
          WHERE profile_id = (SELECT MIN(id) FROM profiles)
            AND metric = 'sleep_min'
            AND value = 45
          ORDER BY date DESC
          LIMIT 1`
      )
      .get() as { profile_id: number; date: string; started_at: string };
    const start = new Date(
      new Date(seededNap.started_at).getTime() - 2 * 60 * 60_000
    );
    const end = new Date(start.getTime() + 30 * 60_000);
    db.prepare(
      `DELETE FROM metric_samples
        WHERE profile_id = ?
          AND source = 'manual'
          AND origin IS NULL
          AND metric = 'sleep_min'
          AND started_at = ?`
    ).run(seededNap.profile_id, start.toISOString());
    if (!enabled) return;
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (?, 'manual', NULL, 'sleep_min', ?, ?, ?, 30)`
    ).run(
      seededNap.profile_id,
      seededNap.date,
      start.toISOString(),
      end.toISOString()
    );
  } finally {
    db.close();
  }
}

test("the dashboard renders one fixed instrument cluster and no editor", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");

  await expect(main.getByTestId("now-strip")).toBeVisible();
  await expect(main.getByTestId("dashboard-standing")).toBeVisible();
  const standing = main.getByTestId("dashboard-standing");
  expect(
    await standing
      .locator("[data-standing-section]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-standing-section"))
      )
  ).toEqual(["today", "body", "longer-view"]);
  await expect(
    standing.locator('[data-standing-section="today"]')
  ).toBeVisible();
  await expect(
    standing.locator('[data-standing-section="body"]')
  ).toBeVisible();
  await expect(
    standing.locator('[data-standing-section="longer-view"]')
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "Edit dashboard" })
  ).toHaveCount(0);
  await expect(main.getByText("Customize", { exact: true })).toHaveCount(0);
});

test("attention facts use write-capable atoms outside read-only Ahead", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="attention.fact:"]'
  );
  const count = await facts.count();

  expect(count).toBeGreaterThan(1);
  for (let index = 0; index < count; index += 1) {
    const fact = facts.nth(index);
    const lane = await fact.getAttribute("data-lane");
    await expect(fact.getByTestId("dashboard-attention-atom")).toHaveCount(
      lane === "ahead" ? 0 : 1
    );
  }
});

test("clinical results render as dense individual facts", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const family = main.locator('[data-standing-family="clinical-results"]');
  const rows = family.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="labs.latest:"]'
  );

  expect(await rows.count()).toBeGreaterThan(1);
  await expect(
    family.getByText("Recent clinical results", { exact: true })
  ).toBeVisible();
});

test("ordinary other-profile attention stays off the acting dashboard", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="household.attention:"]'
  );
  await expect(facts).toHaveCount(0);
});

test("Ahead expands by keyboard without opening Show everything", async ({
  page,
}) => {
  await page.goto("/");
  const ahead = page.getByTestId("dashboard-ahead");
  await expect(ahead).toBeVisible();
  const horizon = ahead.locator('[data-ahead-bucket="horizon"]');
  const expander = horizon.getByRole("button", {
    name: /^\+\d+ more in This week and later$/,
  });
  const controlled = await expander.getAttribute("aria-controls");
  expect(controlled).toBeTruthy();
  await expect(expander).toHaveAccessibleName(
    /^\+\d+ more in This week and later$/
  );
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`#${controlled}`)).toBeHidden();
  await expander.focus();
  await expander.press("Enter");
  await expect(expander).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`#${controlled}`)).toBeVisible();
  await expander.press("Space");
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`#${controlled}`)).toBeHidden();
  await expect(page.getByTestId("dashboard-all")).not.toHaveAttribute(
    "open",
    ""
  );
});

test("Show everything remembers its open state on this device", async ({
  browser,
}) => {
  resetDashboardAllOffer();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DASHBOARD_ALL,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const details = page.getByTestId("dashboard-all");
    await expect(details).not.toHaveAttribute("open", "");
    await openDashboardAll(page);
    await page.addInitScript(() => {
      const state = window as typeof window & {
        __dashboardAllOpenAtFirstFrame?: boolean;
      };
      const sampleFirstFrame = () => {
        const disclosure = document.querySelector<HTMLDetailsElement>(
          '[data-testid="dashboard-all"]'
        );
        if (disclosure) {
          state.__dashboardAllOpenAtFirstFrame = disclosure.open;
          return;
        }
        requestAnimationFrame(sampleFirstFrame);
      };
      requestAnimationFrame(sampleFirstFrame);
    });
    await page.reload();
    await expect(details).toHaveAttribute("open", "");
    await expect(page.getByTestId("dashboard-all-contents")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __dashboardAllOpenAtFirstFrame?: boolean;
              }
            ).__dashboardAllOpenAtFirstFrame
        )
      )
      .toBe(true);

    await settledClick(page, page.getByTestId("stream-offer-decline-onboard"));
    await expect(page.getByTestId("stream-lifecycle-offers")).toHaveCount(0);
  } finally {
    resetDashboardAllOffer();
    await page.context().close();
  }
});

test("manual and external readings are both eligible for Standing", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const manual = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="weight.latest:"]'
    );
    const external = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="activity.steps:"]'
    );

    await expect(manual).toHaveAttribute("data-engagement", "manual");
    await expect(manual).toHaveAttribute("data-lane", "standing");
    await expect(external).toHaveAttribute("data-engagement", "external");
    await expect(external).toHaveAttribute("data-lane", "standing");
  } finally {
    await page.context().close();
  }
});

test("mobile and desktop expose the same four-zone fact order", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page.getByRole("main").getByTestId("dashboard-candidate");
  const desktop = await facts.evaluateAll((nodes) =>
    nodes.map(
      (node) =>
        `${node.getAttribute("data-lane")}:${node.getAttribute("data-fact-key")}`
    )
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await facts.evaluateAll((nodes) =>
    nodes.map(
      (node) =>
        `${node.getAttribute("data-lane")}:${node.getAttribute("data-fact-key")}`
    )
  );
  expect(mobile).toEqual(desktop);
});

test("one nap produces one Standing total and keeps the individual outside Standing", async ({
  page,
}) => {
  await page.goto("/");
  const total = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap-total:"]'
  );
  const naps = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"]'
  );
  await expect(total).toHaveAttribute("data-lane", "standing");
  await expect(total).toContainText("1 nap");
  const napCount = await naps.count();
  expect(napCount).toBeLessThanOrEqual(1);
  for (let index = 0; index < napCount; index += 1) {
    await expect(naps.nth(index)).not.toHaveAttribute("data-lane", "standing");
  }
});

test("multiple naps produce one Standing total and keep individuals outside Standing", async ({
  page,
}) => {
  setSecondDashboardNap(true);
  try {
    await page.goto("/");
    const total = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap-total:"]'
    );
    const naps = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"]'
    );
    await expect(total).toHaveAttribute("data-lane", "standing");
    await expect(total).toContainText("1h 15m");
    await expect(total).toContainText("2 naps");
    const napCount = await naps.count();
    expect(napCount).toBeGreaterThanOrEqual(1);
    expect(napCount).toBeLessThanOrEqual(2);
    await expect(
      page.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"][data-candidate-id$=":660"]'
      )
    ).not.toHaveAttribute("data-lane", "standing");
    for (let index = 0; index < napCount; index += 1) {
      await expect(naps.nth(index)).not.toHaveAttribute(
        "data-lane",
        "standing"
      );
    }
  } finally {
    setSecondDashboardNap(false);
  }
});

// The owner ruling of #3186, on the many-marker profile that provoked it: the
// dashboard renders the clinical family's capped membership and nothing else, and
// the readings it no longer names are still whole one tap away. Both halves matter
// — a test that only watched the dashboard shrink would pass if the data had been
// deleted instead of moved.
test("the clinical family renders its cap and /results keeps the census", async ({
  page,
}) => {
  await page.goto("/");
  const labs = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="labs.latest:"]'
  );
  const lanes = await labs.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-lane"))
  );
  expect(lanes).toEqual(Array.from({ length: 6 }, () => "standing"));

  await page.goto("/results/clinical-results");
  // Each collapsed panel-group header states how many analytes the group holds,
  // whether or not its rows are expanded — so this is the whole census, not a page
  // of it.
  const groups = page
    .getByTestId("results-clinical-results")
    .getByTestId("clinical-result-panel-toggle");
  const census = (
    await groups.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? "")
    )
  ).reduce(
    (total, label) => total + Number(/(\d+) analytes?\b/.exec(label)?.[1] ?? 0),
    0
  );
  expect(census).toBeGreaterThan(lanes.length);
});

test("every applicable fact appears in exactly one atomic lane", async ({
  page,
}) => {
  await page.goto("/");
  const candidates = page
    .getByRole("main")
    .locator("[data-candidate-id][data-fact-key]");
  const identities = await candidates.evaluateAll((nodes) =>
    nodes.map((node) => ({
      candidateId: node.getAttribute("data-candidate-id"),
      factKey: node.getAttribute("data-fact-key"),
    }))
  );
  const candidateIds = identities.map(({ candidateId }) => candidateId);
  const factKeys = identities.map(({ factKey }) => factKey);
  expect(candidateIds.every(Boolean)).toBe(true);
  expect(new Set(candidateIds).size).toBe(candidateIds.length);
  expect(factKeys.every(Boolean)).toBe(true);
  expect(new Set(factKeys).size).toBe(factKeys.length);
});

test("illness identities stay exact-once when the cockpit folds", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SICK_SELF, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  try {
    await page.goto("/");
    const main = page.getByRole("main");
    const cockpit = main
      .getByTestId("illness-hero")
      .locator('[data-active="true"]');
    await expect(cockpit).toHaveCount(1);

    const illnessIdentities = async () =>
      main
        .locator('[data-candidate-id^="illness."][data-fact-key^="illness."]')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            candidateId: node.getAttribute("data-candidate-id")!,
            factKey: node.getAttribute("data-fact-key")!,
          }))
        );
    const expectExactOnce = (
      identities: Awaited<ReturnType<typeof illnessIdentities>>
    ) => {
      expect(
        identities.some(({ candidateId }) =>
          candidateId.startsWith("illness.state:")
        )
      ).toBe(true);
      expect(
        identities.some(({ candidateId }) =>
          candidateId.startsWith("illness.temperature:")
        )
      ).toBe(true);
      expect(
        new Set(identities.map(({ candidateId }) => candidateId)).size
      ).toBe(identities.length);
      expect(new Set(identities.map(({ factKey }) => factKey)).size).toBe(
        identities.length
      );
    };

    const expanded = await illnessIdentities();
    expectExactOnce(expanded);
    await settledClick(
      page,
      cockpit.locator('[data-testid^="illness-cockpit-toggle-"]')
    );
    await expect(cockpit).toHaveAttribute("data-expanded", "false");
    const collapsed = await illnessIdentities();
    expectExactOnce(collapsed);
    expect(collapsed).toEqual(expanded);
  } finally {
    await page.context().close();
  }
});
