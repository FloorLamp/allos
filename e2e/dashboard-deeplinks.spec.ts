import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import {
  E2E_LOGIN_CHILD,
  E2E_LOGIN_DQ_ADULT,
  E2E_LOGIN_DQ_GAPPY,
  DQ_ADULT_PROFILE,
  DQ_GAPPY_PROFILE,
  E2E_LOGIN_REST,
  REST_CARD_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Issues #1146 + #1219 — every dashboard signal carries its affordance, and every
// data-quality CTA deep-links the exact form that fixes the gap (the #1083
// deep-link-the-concrete-action principle in the #1045 lane):
//   • data-quality CTAs land on the anchored smoking/risk forms, the prefilled
//     biomarker add form, and the sole unconfirmed med's edit form / the filtered
//     med list (#1146);
//   • the capped rollup widgets reveal their overflow via "Show N more" (#1219);
//   • coaching's secondary rec renders as a link, a target-less goal row links to
//     the goals surface, and the active-protocols widget caps + overflows (#1219).
// Fixtures: the dedicated DQ_ADULT_PROFILE / DQ_GAPPY_PROFILE / REST_CARD_PROFILE
// members (e2e/seed-events.ts) — no shared-profile writes in this spec.

// Clear a fixture profile's data-quality dismissals so the widgets are populated
// regardless of retries or the neighbor data-quality spec's dismiss test (the
// resetDataQualityDismissals pattern from #1045). BLAST RADIUS: only the
// `data-quality:` namespace on the named fixture profile.
function resetDataQualityDismissals(profileName: string): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
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

// Clear the rest-card profile's coaching snoozes so the card leads with the rest
// rec and its secondary is present (the coaching-rest-card.spec reset, scoped the
// same way). BLAST RADIUS: only `coaching:%` dismissals on that fixture profile.
function resetCoachingSnoozes(profileName: string): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(profileName) as { id: number } | undefined;
    if (row) {
      db.prepare(
        "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'coaching:%'"
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
      const widget = page.getByRole("main").getByTestId("data-quality");
      await expect(widget).toBeVisible();

      const ctaFor = (label: string) =>
        widget
          .getByTestId("data-quality-item")
          .filter({ hasText: label })
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
        "/results/biomarkers?new=1&name=Creatinine"
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
        /\/results\/biomarkers\?new=1&name=Creatinine$/
      );
      await expect(
        page.locator("#add-result").getByLabel("Name", { exact: true })
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
      const widget = page.getByRole("main").getByTestId("data-quality");
      const cta = widget
        .getByTestId("data-quality-item")
        .filter({ hasText: "Confirm 1 RxNorm match" })
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

// Riley (child) is granted to the e2e_child member; the growth quick-add renders
// only for a minor profile, so the focus deep link is asserted on that login.
test("the growth quick-add honors ?focus=height (#1146 pediatric-height CTA)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_CHILD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/trends?tab=body&focus=height");
    const form = page.getByTestId("growth-quick-add");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Height", { exact: true })).toBeFocused();
  } finally {
    await page.context().close();
  }
});

test.describe("capped dashboard widgets surface their overflow (#1219)", () => {
  test("the Data quality widget reveals gaps beyond the cap via 'Show N more'", async ({
    browser,
  }) => {
    resetDataQualityDismissals(DQ_GAPPY_PROFILE);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DQ_GAPPY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const widget = page.getByRole("main").getByTestId("data-quality");
      await expect(widget).toBeVisible();
      // Gappy fixture fires 4 gaps (birthdate/med-rxcui/sex/failed-doc); cap 3.
      await expect(widget.getByTestId("data-quality-item")).toHaveCount(3);
      const more = widget.getByTestId("data-quality-more");
      await expect(more).toBeVisible();
      await more.getByText("Show 1 more").click();
      const hiddenRow = widget
        .getByTestId("data-quality-more-item")
        .filter({ hasText: "Reprocess 1 failed document" });
      await expect(hiddenRow).toBeVisible();
      // The revealed row carries the same affordances: a CTA link + a dismiss.
      await expect(
        hiddenRow.getByRole("link", { name: "Fix it →" })
      ).toHaveAttribute("href", "/data?section=review");
      await expect(
        hiddenRow.getByTestId("data-quality-more-dismiss")
      ).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("the Coaching observations rollup reveals findings beyond its cap of 2", async ({
    browser,
  }) => {
    resetDataQualityDismissals(DQ_GAPPY_PROFILE);
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DQ_GAPPY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const rollup = page
        .getByRole("main")
        .getByTestId("coaching-observations");
      await expect(rollup).toBeVisible();
      await expect(
        rollup.getByTestId("coaching-observations-item")
      ).toHaveCount(2);
      const more = rollup.getByTestId("coaching-observations-more");
      await more.getByText("Show 2 more").click();
      await expect(
        rollup
          .getByTestId("coaching-observations-more-item")
          .filter({ hasText: "Set a biological sex" })
      ).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("the Active protocols widget caps at 3 with a '+N more' overflow link", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DQ_ADULT,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/");
      const widget = page.getByRole("main").getByTestId("active-protocols");
      await expect(widget).toBeVisible();
      // The fixture seeds FOUR ongoing protocols; the cap shows the 3 newest.
      await expect(widget.locator("ul > li")).toHaveCount(3);
      const moreLink = widget.getByTestId("active-protocols-more");
      await expect(moreLink).toContainText("+1 more protocol");
      await expect(moreLink).toHaveAttribute("href", "/longevity#protocols");
      // Hash optional in the URL match (fragment can commit a beat late).
      await followLink(page, moreLink, /\/longevity(#protocols)?$/);
    } finally {
      await page.context().close();
    }
  });
});

test("coaching's secondary recommendation renders as a link to its action (#1219)", async ({
  browser,
}) => {
  resetCoachingSnoozes(REST_CARD_PROFILE);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_REST,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    // The rest-card fixture leads with the rest rec; the training rec rides as
    // the compact "Next:" secondary — now a link carrying its actionHref.
    const secondary = page.getByRole("main").getByTestId("coaching-secondary");
    await expect(secondary).toBeVisible();
    const link = secondary.getByRole("link");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/training/);
  } finally {
    await page.context().close();
  }
});

test("a target-less goal row links to the goals surface (#1219)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_ADULT,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const goalLink = page
      .getByRole("main")
      .getByTestId("goals-habits")
      .getByTestId("goal-title-link")
      .filter({ hasText: "Feel better all around" });
    await expect(goalLink).toHaveAttribute("href", "/training?tab=goals");
    await followLink(page, goalLink, /\/training\?tab=goals$/);
  } finally {
    await page.context().close();
  }
});
