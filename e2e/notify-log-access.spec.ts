import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_CHILD,
  E2E_MEMBER_PASSWORD,
  NOTIFY_LOG_BUSY_PROFILE,
  NOTIFY_LOG_QUIET_PROFILE,
} from "./fixture-logins";

// Settings → Logs & audit → Notify tick (issue #2209). The persisted operator record
// of what the notification tick DECIDED — the declines included, which previously
// lived only in a container stdout the deploy timer deleted tens of times a day.
//
// The row is a RUN, not a line, and the assertion this spec exists for is the one the
// issue says not to compromise on: a QUIET run — a profile the tick evaluated and had
// nothing to say about — must render as a ROW, not as absence. Absence would
// reproduce the exact ambiguity the log exists to kill.
//
// Fixture: e2e/seed/notifications.ts seedNotifyTickLog() writes data/logs/notify.jsonl
// directly, with two dedicated profiles so this spec owns every row it counts.
test.describe("Notify tick log (#2209)", () => {
  test("an admin sees the run rows, including a QUIET one", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/settings/notify-log");
    await expect(
      page.getByRole("heading", { name: "Logs & audit" })
    ).toBeVisible();
    // The fourth sub-page entry is present alongside its three siblings.
    await expect(
      page
        .getByTestId("settings-subpage-nav")
        .getByRole("link", { name: "Notify tick" })
    ).toBeVisible();
    await expect(page.getByTestId("notify-log")).toBeVisible();

    // The BUSY profile's newest run carries its declines…
    const busyRun = page
      .getByTestId("notify-log-run")
      .filter({ hasText: NOTIFY_LOG_BUSY_PROFILE })
      .first(); // first-ok: newest run first, and this spec owns this profile's rows
    await expect(busyRun).toBeVisible();
    await expect(busyRun.getByTestId("notify-log-decline-count")).toContainText(
      "declined"
    );

    // …and the QUIET profile renders a ROW that says so in words, rather than
    // vanishing. This is the assertion the whole page exists for.
    const quietRun = page
      .getByTestId("notify-log-run")
      .filter({ hasText: NOTIFY_LOG_QUIET_PROFILE });
    await expect(quietRun).toHaveCount(1);
    await expect(quietRun.getByTestId("notify-log-quiet")).toHaveText(
      "nothing to do"
    );
    // The empty state must NOT be what a quiet run produces.
    await expect(page.getByTestId("notify-log-empty")).toHaveCount(0);
  });

  test("a run expands to the decisions behind it", async ({ page }) => {
    test.slow();

    await page.goto("/settings/notify-log");
    const busyRun = page
      .getByTestId("notify-log-run")
      .filter({ hasText: NOTIFY_LOG_BUSY_PROFILE })
      .first(); // first-ok: newest run first, and this spec owns this profile's rows

    // Collapsed by default — the run row is the unit, its lines are the detail.
    await expect(busyRun.getByTestId("notify-log-line")).toHaveCount(0);
    await busyRun.getByRole("group").getByText("4", { exact: true }).click();

    // Both declines are named, with the reason attached.
    await expect(
      busyRun.getByText("refill nudge skipped: no channel")
    ).toBeVisible();
    await expect(
      busyRun.getByText("no configured channels; nothing sent")
    ).toBeVisible();
  });

  test("the declines-only filter narrows the view", async ({ page }) => {
    test.slow();

    await page.goto("/settings/notify-log");
    const before = await page.getByTestId("notify-log-run").count();

    await page.getByTestId("notify-log-declines-only").check();
    await page.getByRole("button", { name: "Filter" }).click();
    await page.waitForURL((u) => u.searchParams.get("declines") === "1");

    // The quiet run declined nothing, so it drops out — which is exactly what the
    // filter should do to it, and the complement of the first test's assertion.
    await expect(
      page
        .getByTestId("notify-log-run")
        .filter({ hasText: NOTIFY_LOG_QUIET_PROFILE })
    ).toHaveCount(0);
    const after = await page.getByTestId("notify-log-run").count();
    expect(after).toBeLessThan(before);
  });

  test("pagination holds the active filters across pages", async ({ page }) => {
    test.slow();

    await page.goto("/settings/notify-log?declines=1");
    // The fixture seeds enough declining runs to need a second page.
    await expect(page.getByRole("link", { name: "Next" })).toBeVisible();
    await page.getByRole("link", { name: "Next" }).click();

    // The filter survives the crossing — in the URL and in the control's own state.
    await page.waitForURL(
      (u) =>
        u.searchParams.get("page") === "2" &&
        u.searchParams.get("declines") === "1"
    );
    await expect(page.getByTestId("notify-log-declines-only")).toBeChecked();
    await expect(page.getByTestId("notify-log-run").first()).toBeVisible(); // first-ok: any row proves the page rendered under the filter
  });

  test("a member hitting the URL is redirected out", async ({ browser }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/notify-log");
      // requireAdmin bounces a member to the app root before the page renders.
      await member.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });
      await expect(member.getByTestId("notify-log")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
