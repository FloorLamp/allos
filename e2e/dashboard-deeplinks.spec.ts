import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_DQ_ADULT,
  E2E_LOGIN_DQ_GAPPY,
  DQ_ADULT_PROFILE,
  DQ_GAPPY_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { dashboardCandidateWithText } from "./dashboard-candidate";

// Issues #1146 + #1219 — every dashboard signal carries its affordance, and every
// data-quality CTA deep-links the exact form that fixes the gap (the #1083
// deep-link-the-concrete-action principle in the #1045 lane):
//   • data-quality CTAs land on the anchored smoking/risk forms, the prefilled
//     biomarker add form, and the sole unconfirmed med's edit form / the filtered
//     med list (#1146);
//   • capped list widgets reveal their overflow via "Show N more" (#1219), while
//     Coaching observations renders its complete threshold-clearing set (#3090);
//   • coaching's secondary rec renders as a link, a target-less goal fact links to
//     the goals surface, and the active-protocols widget caps + overflows (#1219).
// Fixtures: the dedicated DQ_ADULT_PROFILE / DQ_GAPPY_PROFILE
// members (e2e/seed-events.ts) — no shared-profile writes in this spec.

// Clear a fixture profile's data-quality dismissals so the widgets are populated
// regardless of retries or the neighbor data-quality spec's dismiss test (the
// resetDataQualityDismissals pattern from #1045). BLAST RADIUS: only the
// `data-quality:` namespace on the named fixture profile.
function resetDataQualityDismissals(profileName: string): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(profileName) as { id: number } | undefined;
    if (row) {
      db.prepare(
        `DELETE FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key LIKE 'data-quality:%'`
      ).run(row.id);
    }
  } finally {
    db.close();
  }
}

test.describe("data-quality CTAs deep-link the exact form (#1146)", () => {
  test("smoking / risk / PhenoAge CTAs land on the concrete forms, not browse pages", async ({
    browser,
  }) => {
    resetDataQualityDismissals(DQ_ADULT_PROFILE);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DQ_ADULT,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const ctaFor = (label: string) =>
        dashboardCandidateWithText(page, "data-quality.finding:", label)
          .getByTestId("data-quality-item")
          .getByRole("link", { name: "Fix it →" });

      // Each CTA names the exact target (asserted before navigating).
      await expect(ctaFor("Record smoking status")).toHaveAttribute(
        "href",
        "/records/care/overview#smoking-history"
      );
      await expect(ctaFor("Review risk factors")).toHaveAttribute(
        "href",
        "/records/care/overview#risk-factors"
      );
      // Partial panel (Albumin present) → first missing analyte is Creatinine.
      await expect(ctaFor("Complete the PhenoAge panel")).toHaveAttribute(
        "href",
        "/results/clinical-results?new=1&name=Creatinine"
      );

      // Follow the smoking CTA: it lands ON the smoking-history form. The hash
      // is optional in the URL match — the router can commit the pathname a beat
      // before the fragment — but the link's href above pins the full target.
      await followLink(
        page,
        ctaFor("Record smoking status"),
        /\/records\/care\/overview(#smoking-history)?$/
      );
      await expect(page.getByTestId("smoking-history")).toBeVisible();
      await expect(page.getByTestId("risk-factors")).toBeVisible();

      // Follow the PhenoAge CTA: the biomarker add form opens prefilled.
      await page.goto("/");
      await followLink(
        page,
        ctaFor("Complete the PhenoAge panel"),
        /\/results\/clinical-results\?new=1&name=Creatinine$/
      );
      await expect(
        page
          .getByRole("dialog", { name: "Add result" })
          .getByLabel("Name", { exact: true })
      ).toHaveValue("Creatinine");
    } finally {
      await page.context().close();
    }
  });

  test("the sole unconfirmed med's CTA opens ITS edit form (the #851 confirm surface)", async ({
    browser,
  }) => {
    resetDataQualityDismissals(DQ_GAPPY_PROFILE);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DQ_GAPPY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const cta = dashboardCandidateWithText(
        page,
        "data-quality.finding:",
        "Confirm 1 RxNorm match"
      )
        .getByTestId("data-quality-item")
        .getByRole("link", { name: "Fix it →" });
      await expect(cta).toHaveAttribute(
        "href",
        /\/medications\/\d+\?action=edit$/
      );
      await followLink(page, cta, /\/medications\/\d+\?action=edit$/);
      // The edit form is open, with the RxNorm confirm affordance on it.
      await expect(page.getByRole("combobox", { name: "Name" })).toBeVisible();
      await expect(page.getByTestId("rxcui-affordance")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("?filter=needs-rxcui narrows the medication list to the unconfirmed slice", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DQ_GAPPY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/medications?filter=needs-rxcui");
      const main = page.getByRole("main");
      await expect(main.getByTestId("medications-filter-notice")).toBeVisible();
      await expect(
        main.getByTestId("medication-list").getByText("DQ Mystery Pill")
      ).toBeVisible();
      // The notice's escape hatch back to the full list.
      await followLink(
        page,
        main
          .getByTestId("medications-filter-notice")
          .getByRole("link", { name: "Show all" }),
        /\/medications$/
      );
    } finally {
      await page.context().close();
    }
  });
});

// Riley (child) is granted to the e2e_child member; the growth FIELDS render only
// for a minor profile, so the focus deep link is asserted on that login. Since
// #1486 they are life-stage-gated rows of the ONE combined measurements form, which
// the deep link expands (desktop) with the height field focused.
test("the measurements form honors ?focus=height (#1146 pediatric-height CTA)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_CHILD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/trends?focus=height");
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Height", { exact: true })).toBeFocused();
  } finally {
    await page.context().close();
  }
});

test("a target-less Standing goal fact links to the goals surface (#1219)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_ADULT,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const goalFact = page
      .getByRole("main")
      .locator('[data-standing-family="outcome-goals"]')
      .locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="goal.progress:"][data-fact-key^="outcome-goal.progress:"]'
      )
      .filter({ hasText: "Feel better all around" });
    await expect(goalFact).toHaveAttribute("data-lane", "standing");
    const goalLink = goalFact.getByRole("link");
    await expect(goalLink).toHaveAttribute("href", "/training?tab=goals");
    // The retired name redirects to its canonical Plan URL (#2892): the href
    // keeps its historic value, the landing carries the goals anchor.
    await followLink(page, goalLink, /\/training\?tab=plan#goals$/);
  } finally {
    await page.context().close();
  }
});
