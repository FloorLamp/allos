import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick, settledFill } from "./helpers";
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
    await expect(ttc.getByTestId("ttc-declare")).toBeVisible();
    await expect(ttc.getByTestId("ttc-log-bar")).toHaveCount(0);
    await expect(ttc.getByTestId("ttc-window")).toHaveCount(0);
  });
});
