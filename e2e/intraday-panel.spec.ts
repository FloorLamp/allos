import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_INTRADAY,
  E2E_MEMBER_PASSWORD,
  INTRADAY_ACTIVITY,
  INTRADAY_TICK_DOC,
} from "./fixture-logins";

// The Timeline day view's intraday panel (issue #1068) — the day rotated 90°: the
// SAME events the day's feed lists, projected onto a 00:00–24:00 clock axis.
//
// Spec-owned fixtures (#868): everything below lives on the dedicated
// E2E_LOGIN_INTRADAY profile seeded by e2e/seed-events.ts, so no shared-seed row is
// counted and no other spec's HR/zone numbers move. Reads only.
test.describe("Timeline intraday panel (#1068)", () => {
  test("renders the day's layers and a tick jumps to its feed entry", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Timeline route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // The fixture's intraday day IS the profile's today, so the panel also
      // carries the now-marker. Resolve the date from the page rather than
      // recomputing the run's frozen clock here.
      await member.goto("/timeline");
      const day = member.locator("[id^='timeline-day-']").first(); // first-ok: spec-owned profile, newest day is the fixture's today
      const date = (await day.getAttribute("id"))!.replace("timeline-day-", "");

      await member.goto(`/timeline?from=${date}&to=${date}`);

      const panel = member.getByTestId("intraday-panel");
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute("data-intraday-date", date);

      // Layer 1 — the HR band, downsampled at the model layer.
      await expect(panel.getByTestId("intraday-hr")).toBeVisible();
      // Layer 2 — the overnight session, clipped at midnight (it started 23:20
      // the previous day) with its deep-stage sub-band.
      await expect(panel.getByTestId("intraday-sleep-block")).toHaveCount(1);
      await expect(panel.getByTestId("intraday-sleep-stage")).toHaveCount(1);
      // Layer 3 — the windowed ride.
      const workout = panel.getByTestId("intraday-workout");
      await expect(workout).toHaveCount(1);
      await expect(workout).toHaveAttribute("data-title", INTRADAY_ACTIVITY);
      // Layer 5 — today only.
      await expect(panel.getByTestId("intraday-now")).toBeAttached();

      // Layer 4 — the tick rail. The two clock-timed document uploads are ticks;
      // the workout is drawn as a block, never double-drawn as a tick.
      const ticks = panel.getByTestId("intraday-tick");
      await expect(ticks).toHaveCount(2);

      // Chart as map, list as detail: the tick's fragment target IS the feed entry
      // rendered below, so tapping it scrolls the list to that entry.
      const morningTick = ticks.first(); // first-ok: ticks are time-ordered and spec-owned; 07:15 is the earliest
      const href = await morningTick.getAttribute("href");
      expect(href).toMatch(/^#timeline-entry-document-\d+$/);

      const target = member.locator(href!);
      await expect(target).toContainText(INTRADAY_TICK_DOC);
      await morningTick.click();
      await expect(member).toHaveURL(new RegExp(`${href!.slice(1)}$`));
      await expect(target).toBeInViewport();
    } finally {
      await member.context().close();
    }
  });

  test("is absent on a day with no intraday data", async ({ browser }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_INTRADAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Three days back the fixture profile has ONLY a weigh-in — a real feed
      // event with no clock time, no HR, no sleep, no windowed workout. The day
      // renders; the panel is data-gated away (no empty frame).
      await member.goto("/timeline");
      const dayIds = await member
        .locator("[id^='timeline-day-']")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.id.replace("timeline-day-", ""))
        );
      const quiet = dayIds.at(-1)!;

      await member.goto(`/timeline?from=${quiet}&to=${quiet}`);
      await expect(
        member.getByRole("heading", { name: "Body metrics logged" })
      ).toBeVisible();
      await expect(member.getByTestId("intraday-panel")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
