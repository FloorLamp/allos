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

/** Home's Setup band rows — one per admitted data-quality finding (#5435 §3.4). */
const SETUP_GAP = '[data-candidate-id^="home.setup:data-quality:"]';

// Issues #1146 + #1219 — every Home signal carries its affordance, and every
// data-quality CTA deep-links the exact form that fixes the gap (the #1083
// deep-link-the-concrete-action principle in the #1045 lane):
//
// WHERE THE FINDINGS LIVE NOW (#5435 §3.4). They were `data-quality.finding:` rows in
// the ranker's tail, reached by opening Show everything. Home v3 seats them in its
// Setup band as `home.setup:data-quality:<key>`, built from the same
// `buildDataQualityFindings` bus with the same dismissal identity, and each row's
// trailing slot carries the finding's OWN verb — "Fix it" — pointing at the same href
// the finding declares. So the deep-link claims below are unchanged; only the row they
// are read from moved, and they no longer need a fold opened first.
//   • data-quality CTAs land on the anchored smoking/risk forms, the prefilled
//     biomarker add form, and the sole unconfirmed med's edit form / the filtered
//     med list (#1146);
//   • a target-less goal fact links to the goals surface.
// Fixtures: the dedicated DQ_ADULT_PROFILE / DQ_GAPPY_PROFILE
// members (e2e/seed-events.ts) — no shared-profile writes in this spec.

// Clear a fixture profile's data-quality dismissals so the atoms are populated
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
        page
          .locator(SETUP_GAP)
          .filter({ hasText: label })
          .getByRole("link", { name: "Fix it" });

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
      const cta = page
        .locator(SETUP_GAP)
        .filter({ hasText: "Confirm 1 RxNorm match" })
        .getByRole("link", { name: "Fix it" });
      await expect(cta).toHaveAttribute(
        "href",
        /\/medications\/\d+\?action=edit$/
      );
      await followLink(page, cta, /\/medications\/\d+\?action=edit$/);
      // The edit form is open, with the RxNorm confirm affordance on it — a fact chip
      // since #5301, prompting the match it does not have yet.
      await expect(page.getByRole("combobox", { name: "Name" })).toBeVisible();
      const rxnorm = page.getByTestId("intake-fact-rxnorm");
      await expect(rxnorm).toBeVisible();
      await expect(rxnorm).toHaveAttribute("data-fact-state", "missing");
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

// THE TARGET-LESS GOAL FACT WAS A STANDING ROW (#1219, #5435 §4).
//
// A test here proved that a Standing goal fact with no target of its own still carries
// a door, and that the door is the goals surface — `/training?tab=plan#goals` — rather
// than a browse page. It read `[data-standing-family="outcome-goals"]`, a
// `goal.progress:` candidate in the `standing` lane.
//
// `goal.progress:` is a progress candidate matched by lib/dashboard-standing.ts, and
// no route mounts the Standing cluster after Home v3. Home does seat goals, but as
// attention facts whose row is a title and a detail with NO door (§3.2) — a different
// row making a different promise, so pointing this at it would assert something the
// page does not claim.
//
// WHAT RETIRED: the rendered proof that a target-less goal fact has a door at all.
// What did not: the destination itself, pinned in lib/__tests__/training-tabs.test.ts
// (`retiredTrainingTabTarget("goals")`), in lib/__db_tests__/target-rightsize.test.ts
// (the rightsize finding's `actionHref`) and in lib/__db_tests__/search-hrefs.test.ts.
// The candidate and its lane belong to PR 3 with the rest of the ranker.
