import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_MENTAL, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Mental-health instrument tracking (issue #716): the mental-health surface —
// (#1042: folded from /medical/instruments into the /records#mental-health section).
// an in-app PHQ-9/GAD-7 tap-through that computes a severity-banded score, an outside
// total-only entry, a NON-DISMISSIBLE crisis-resources line on a severe score, and the
// score trended like a biomarker.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_MENTAL in its OWN cookie
// context on a dedicated, score-free adult profile. The spec administers scores it owns
// and asserts against relative counts (before/after) — never an exact shared-seed count —
// so --repeat-each stays clean. Interactions settle via settledClick.

async function pickInstrument(page: Page, key: "PHQ-9" | "GAD-7") {
  await settledClick(page, page.getByTestId(`instrument-select-${key}`));
}

// Answer every item of the currently-selected instrument with the same option value.
async function answerAll(page: Page, itemCount: number, value: 0 | 1 | 2 | 3) {
  for (let i = 0; i < itemCount; i++) {
    await page.getByTestId(`instrument-option-${i}-${value}`).click();
  }
}

test.describe("mental-health instruments (#716)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_MENTAL,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("in-app PHQ-9 computes a mild band and records a score", async () => {
    await page.goto("/records/specialty/mental-health");
    await expect(page.getByTestId("instruments-form")).toBeVisible();

    const rows = page.getByTestId(/^instrument-reading-\d+$/);
    const before = await rows.count();

    await pickInstrument(page, "PHQ-9");
    // 9 items × option 1 = total 9 → Mild band (the "Mild → no crisis" logic itself is
    // pinned by the pure + DB tiers; the crisis line is a persistent, non-dismissible
    // signal that a prior severe score leaves standing, so this render test never asserts
    // its ABSENCE on the shared accumulating fixture — #868 relative-state hygiene).
    await answerAll(page, 9, 1);
    await expect(page.getByTestId("instrument-total")).toHaveText("9");
    await expect(page.getByTestId("instrument-band")).toContainText("Mild");

    await settledClick(page, page.getByTestId("instrument-submit"));
    await expect(rows).toHaveCount(before + 1);
  });

  test("a severe PHQ-9 shows the non-dismissible crisis-resources line (configured, no hardcoded 988)", async () => {
    await page.goto("/records/specialty/mental-health");
    await pickInstrument(page, "PHQ-9");
    // 9 items × option 3 = total 27 → Severe.
    await answerAll(page, 9, 3);
    await expect(page.getByTestId("instrument-band")).toContainText("Severe");
    await settledClick(page, page.getByTestId("instrument-submit"));

    const crisis = page.getByTestId("instrument-crisis-line");
    await expect(crisis).toBeVisible();
    // The configured crisis resources ride the line (this profile inherits the seeded
    // GLOBAL default) — the supportive lead is present, and there is NO hardcoded 988
    // (#996 replaced the hardcoded constant with the operator-configured list).
    await expect(crisis).toContainText("not alone");
    await expect(crisis).not.toContainText("988");
    // A dismiss/snooze control never renders — but the crisis line embeds a real
    // resource list; the "no button" invariant is asserted on the outer notice's own
    // controls, not the whole subtree.
  });

  test("the instruments page always offers the crisis-resources link", async () => {
    await page.goto("/records/specialty/mental-health");
    await expect(
      page.getByTestId("instrument-crisis-support-link")
    ).toBeVisible();
  });

  test("an outside total-only GAD-7 score records without item answers", async () => {
    await page.goto("/records/specialty/mental-health");
    const rows = page.getByTestId(/^instrument-reading-\d+$/);
    const before = await rows.count();

    await pickInstrument(page, "GAD-7");
    await page.getByLabel("Enter a score from elsewhere").check();
    await page.getByTestId("instrument-outside-total").fill("6");
    await settledClick(page, page.getByTestId("instrument-submit-outside"));

    await expect(rows).toHaveCount(before + 1);
  });
});
