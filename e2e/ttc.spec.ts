import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { hydratedClick, settledClick, settledFill } from "./helpers";
import {
  E2E_LOGIN_TTC,
  E2E_LOGIN_CYCLE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Reproductive health: the next-period forecast (#1679) and the trying-to-conceive
// surfaces (#1680), on /medical/cycles.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_TTC in its OWN cookie context on
// a dedicated adult female profile seeded with SIX regular ~28-day cycles (enough history
// for a narrow window), a DECLARED TTC start, and a flat follicular BBT baseline. Every
// mutation the spec makes is round-tripped back through the app (a re-tap corrects the
// same row), so --repeat-each stays clean. Interactions settle via settledClick.

test.describe("cycle forecast + trying to conceive (#1679/#1680)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_TTC,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("a regular history projects a window with its confidence and evidence", async () => {
    test.slow();
    await page.goto("/medical/cycles");
    const card = page.getByTestId("cycle-forecast");
    await expect(card).toBeVisible();

    // A WINDOW, never a bare date.
    await expect(card.getByTestId("cycle-forecast-window")).toHaveText(
      /\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/
    );
    // The confidence tier, and the evidence the projection stands on.
    await expect(card.getByTestId("cycle-forecast-confidence")).toContainText(
      "Narrow window"
    );
    await expect(card.getByTestId("cycle-forecast-evidence")).toContainText(
      "completed cycles"
    );
    // The ovulation estimate is present and marked as calendar-derived, not observed.
    await expect(card.getByTestId("cycle-forecast-ovulation")).toContainText(
      "estimate from history"
    );
  });

  test("the fertile window names its evidence and always says it is not contraception", async () => {
    await page.goto("/medical/cycles");
    const ttc = page.getByTestId("ttc-section");
    await expect(ttc).toBeVisible();
    await expect(ttc.getByTestId("ttc-window-evidence")).toContainText(
      "Calendar estimate"
    );
    await expect(ttc.getByTestId("ttc-not-contraception")).toContainText(
      "not a contraceptive method"
    );
    // The counter states elapsed time only — no streak, no encouragement.
    await expect(ttc.getByTestId("ttc-duration")).toContainText("cycles since");
  });

  test("a positive LH test outranks the calendar estimate, and a correction restores it", async () => {
    await page.goto("/medical/cycles");
    const ttc = page.getByTestId("ttc-section");

    await settledClick(page, page.getByTestId("ttc-lh-positive"));
    await expect(ttc.getByTestId("ttc-window-evidence")).toContainText(
      "Positive LH test"
    );

    // Correcting today's test back to negative updates the SAME row and the window falls
    // back to the weaker evidence — the spec's own idempotent inverse.
    await settledClick(page, page.getByTestId("ttc-lh-negative"));
    await expect(ttc.getByTestId("ttc-window-evidence")).toContainText(
      "Calendar estimate"
    );
  });

  test("the log bar records a mucus observation and a waking temperature", async () => {
    await page.goto("/medical/cycles");

    // Cervical mucus: a categorical tap, reflected back as the pressed option.
    await settledClick(page, page.getByTestId("ttc-mucus-egg_white"));
    await expect(page.getByTestId("ttc-mucus-egg_white")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    // Restore a non-fertile observation so the window evidence stays calendar-based.
    await settledClick(page, page.getByTestId("ttc-mucus-dry"));
    await expect(page.getByTestId("ttc-mucus-dry")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Waking temperature: one reading, well inside the follicular baseline, so it can
    // never manufacture a sustained rise.
    await settledFill(page, page.getByTestId("ttc-bbt-input"), "97.4");
    await settledClick(page, page.getByTestId("ttc-bbt-save"));
    await page.goto("/medical/cycles");
    await expect(page.getByTestId("ttc-bbt-input")).toHaveValue("97.4");

    // A flat baseline confirms nothing — and the copy says so rather than guessing.
    await expect(page.getByTestId("ttc-confirmation")).toContainText(
      "No sustained temperature rise"
    );
  });
});

test.describe("forecast and TTC are absent without the evidence to carry them", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  // The cycle-log fixture carries three periods (two completed cycles) — one short of the
  // forecast threshold. It must say so rather than invent a date.
  test("a thin history gets the 'log a couple more cycles' note, not a fake date", async () => {
    await page.goto("/medical/cycles");
    const card = page.getByTestId("cycle-forecast");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Log a couple more cycles");
    await expect(card.getByTestId("cycle-forecast-window")).toHaveCount(0);
  });

  test("TTC stays off until it is declared — an observation is not a declaration", async () => {
    await page.goto("/medical/cycles");
    const ttc = page.getByTestId("ttc-section");
    await expect(ttc).toBeVisible();
    // Since #2583 the not-active state is ONE LINE, not a standing card: the topic and
    // its state are named (so someone looking for it still finds it) and nothing else
    // is spent. The declare control is behind the fold — present, but not on screen and
    // not in the tab order.
    await expect(ttc).toHaveAttribute("data-open", "false");
    await expect(ttc.getByTestId("ttc-off-toggle")).toContainText(
      "Trying to conceive · off — tap to turn on tracking"
    );
    await expect(ttc.getByTestId("ttc-declare")).not.toBeVisible();
    // The declared-only doctrine itself is unchanged: no content, at all, until asked.
    await expect(ttc.getByTestId("ttc-log-bar")).toHaveCount(0);
    await expect(ttc.getByTestId("ttc-window")).toHaveCount(0);
  });

  test("the off line expands to the declare control, and declaring renders the full section (#2583)", async () => {
    // The fold may only ever cost a tap. Everything behind it is exactly today's
    // not-active content, and the declaration still does the whole job.
    await page.goto("/medical/cycles");
    const ttc = page.getByTestId("ttc-section");

    // Opening is a pure client toggle — no Server Action — so hydratedClick, which
    // closes the pre-hydration window without a retry loop a toggle must not have.
    await hydratedClick(page, ttc.getByTestId("ttc-off-toggle"));
    await expect(ttc).toHaveAttribute("data-open", "true");
    await expect(ttc).toContainText("Turn this on to record ovulation");
    const declare = ttc.getByTestId("ttc-declare");
    await expect(declare).toBeVisible();
    await expect(declare.getByTestId("ttc-start-input")).toBeVisible();

    try {
      // Declaring is the ONE write that turns the surfaces on. The date field already
      // holds today, so the tap alone is the declaration.
      await settledClick(page, declare.getByTestId("ttc-start-save"));
      // The full section now renders — no fold, and the declared content with it.
      await expect(ttc.getByTestId("ttc-window")).toBeVisible({
        timeout: 20_000,
      });
      await expect(ttc.getByTestId("ttc-log-bar")).toBeVisible();
      await expect(ttc.getByTestId("ttc-off-toggle")).toHaveCount(0);
      await expect(ttc.getByTestId("ttc-not-contraception")).toContainText(
        "not a contraceptive method"
      );
    } finally {
      // Restore the shared profile's undeclared state — this describe block's other
      // test and cycle.spec.ts both read it. Stopping removes only the declaration.
      await settledClick(page, ttc.getByTestId("ttc-stop"));
    }
    await expect(ttc).toHaveAttribute("data-open", "false", {
      timeout: 20_000,
    });
    await expect(ttc.getByTestId("ttc-log-bar")).toHaveCount(0);
  });
});
