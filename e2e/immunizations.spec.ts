import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// /immunizations + /immunizations/[vaccine] (issue #391, gap 2). The list, the
// per-vaccine detail dose history, and profile-scoping had no direct coverage —
// import-records-browser only asserts a link INTO the route, and
// immunization-titer-link covers only the titer deep-link. scripts/seed.ts gives
// profile 1 an adult record set (mmr / tdap booster 2018-09-01 / a ~13-month-old
// influenza) plus two immunity titers.
test.describe("Immunizations (#391)", () => {
  test("the list renders the schedule + recorded doses, and a vaccine detail shows dose history", async ({
    page,
  }) => {
    // Local `next dev` compiles the immunizations routes on first hit.
    test.slow();

    await page.goto("/records/history/immunizations");
    await expect(page.getByTestId("records-immunizations")).toBeVisible();

    // The sortable Vaccines table renders rows, each drilling into a detail page.
    await expect(page.getByRole("heading", { name: "Vaccines" })).toBeVisible();
    await expect(
      page.locator('a[href^="/immunizations/"]').first() // first-ok: follows any immunization detail link — order-agnostic navigation
    ).toBeVisible();

    // #552: an adult (profile 1, born 1986) sees age-inappropriate childhood-only
    // series (rotavirus, childhood PCV/Hib) resolved to not_recommended and
    // dropped from the Vaccines table — NOT surfaced as "No record on file" gaps.
    // The table is the only place a vaccine links to /immunizations/<code> (the
    // schedule grid below lists every vaccine by abbrev, no link), so the absent
    // rv/hib links prove the rows left the table while MMR (has an adult catch-up)
    // stays.
    await expect(page.locator('a[href="/immunizations/mmr"]')).toBeVisible();
    await expect(page.locator('a[href="/immunizations/rv"]')).toHaveCount(0);
    await expect(page.locator('a[href="/immunizations/hib"]')).toHaveCount(0);

    // The CDC schedule grid + the seeded immunity titer both render.
    await expect(
      page.getByRole("heading", { name: "CDC recommended schedule" })
    ).toBeVisible();
    await expect(
      page.getByText("Hepatitis B Surface Antibody").first() // first-ok: asserts the seeded HepB titer row renders — order-agnostic presence
    ).toBeVisible();

    // The per-vaccine detail: the seeded Tdap booster (2018-09-01) shows as one
    // dose with its date in the dose-history section.
    await page.goto("/immunizations/tdap");
    await expect(
      page.getByRole("heading", { name: "Recommended schedule" })
    ).toBeVisible();
    const history = page.locator(".card").filter({ hasText: "Dose history" });
    await expect(history).toContainText("2018-09-01");
  });

  test("the recorded-dose list is profile-scoped — a different profile sees its own, not profile 1's", async ({
    browser,
  }) => {
    test.slow();

    // An isolated member session whose sole (active) profile is Riley (child),
    // who has no recorded immunizations. Reading /immunizations must show Riley's
    // OWN empty dose list, never profile 1's records.
    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/records/history/immunizations");
      await expect(member.getByTestId("records-immunizations")).toBeVisible();

      // Riley has zero recorded doses …
      await expect(member.getByText(/All recorded doses \(0\)/)).toBeVisible();
      // … and profile 1's seeded booster date never leaks across the boundary.
      await expect(member.getByText("2018-09-01")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
