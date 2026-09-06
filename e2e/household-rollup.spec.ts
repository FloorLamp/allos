import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_HH_CAREGIVER,
  E2E_LOGIN_HH_SOLO,
  E2E_LOGIN_HH_VIEWER,
} from "./fixture-logins";

// Household view for members, and the card's composition (issue #31, recomposed by
// #1463 §1). The Household screen is open to ANY login that can reach 2+ profiles (a
// caregiver member with several grants, or an admin), and each card is now a SUMMARY:
// status strip, the member's 7-day digest, and one link to where the work is done.
//
// IN-APP ACTIONS ARE CEDED, NOT LOST. The cards used to carry per-dose confirm forms
// so a caregiver could act without switching profile; Upcoming multi-view owns that
// now, and e2e/multi-view.spec.ts proves the cross-profile confirm on its rows. What
// these specs hold is the boundary that is still this page's own:
//   1. a member granted 2 profiles sees both cards, and no card offers a dose action;
//   2. a single-profile member has no Household nav and is redirected off the URL;
//   3. a read-only member sees the same cards a write member does.
// Plus the recomposed card itself, asserted as admin at the bottom of this file.
//
// The default specs run authenticated as admin (storageState); here we sign in as the
// SEEDED caregiver fixtures (e2e/fixture-logins.ts) in fresh contexts — replacing the
// former runtime member-creation through Settings → Family, whose router.refresh() grant
// rows went stale under CI load (the #868 create-member census flake).

const SEEDED_PROFILE_2 = "2"; // "Sam Rivers"

// Sign in as the given credentials in a brand-new, explicitly cookie-less context
// (so it does NOT inherit the admin storageState). Returns the member's page.
async function loginAs(
  browser: Browser,
  creds: { username: string; password: string }
): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill('input[name="username"]', creds.username);
  await page.fill('input[name="password"]', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  return page;
}

test.describe("Household view for members (issue #31)", () => {
  test("a member with two grants sees both cards, and no card offers a dose action", async ({
    browser,
  }) => {
    // Local `next dev` compiles the family/household routes on first hit.
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_HH_CAREGIVER,
      password: E2E_MEMBER_PASSWORD,
    });

    // The Household nav entry is now visible for a multi-profile member. Exact:
    // the #1009 dashboard promotion link ("See the household's visit & illness
    // history") also carries "household" in its accessible name — a non-exact
    // role query is a strict-mode collision when the house is sick.
    // #3079 moved Household into the collapsed "Plan & review" group, so the row
    // is one disclosure away; the multi-profile gate it demonstrates is unchanged.
    const memberNav = memberPage.locator("aside nav");
    await memberNav.getByRole("button", { name: "Plan & review" }).click();
    await expect(
      memberNav.getByRole("link", { name: "Household", exact: true })
    ).toBeVisible();

    await memberPage.goto("/household");
    await expect(memberPage.getByTestId("household-card")).toHaveCount(2);

    // The active profile is the first accessible one (profile 1, named "admin"),
    // NOT the other member on the page.
    await expect(memberPage.getByTestId("profile-identity-bar")).toContainText(
      "admin"
    );

    // THE CEDED HALF (#1463 §1). A WRITE-granted caregiver used to get a Confirm on
    // every due dose here; the page carries no dose write at all now, for anyone.
    // Asserted for the write member specifically, because "no button" is also true
    // of the read-only member below for an entirely different reason — a removal
    // proven only on the login that never had one proves nothing.
    const p2Card = memberPage.locator(
      `[data-testid="household-card"][data-profile-id="${SEEDED_PROFILE_2}"]`
    );
    await expect(p2Card).toBeVisible();
    await expect(p2Card.getByTestId("household-confirm-dose")).toHaveCount(0);
    await expect(
      memberPage.getByRole("button", { name: /^Confirm/ })
    ).toHaveCount(0);

    // …and the card still says what it is for: this member's week.
    await expect(p2Card.getByTestId("household-digest")).toBeVisible();

    await memberPage.context().close();
  });

  test("a single-profile member has no Household nav and is redirected from the URL", async ({
    browser,
  }) => {
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_HH_SOLO,
      password: E2E_MEMBER_PASSWORD,
    });

    // Nav link hidden for a single-profile login… and the group it now lives in
    // (#3079) is EXPANDED first, with an ungated sibling proving the expansion —
    // otherwise this count reads 0 because the group is collapsed and the
    // requiresMultiProfile gate goes untested while staying green. Trends
    // (#4965), not History — History left this group for a top-level row.
    const soloNav = memberPage.locator("aside nav");
    await soloNav.getByRole("button", { name: "Plan & review" }).click();
    await expect(soloNav.getByRole("link", { name: "Trends" })).toBeVisible();
    await expect(
      memberPage.getByRole("link", { name: "Household" })
    ).toHaveCount(0);

    // …and the page's own server gate bounces a direct visit to the dashboard.
    await memberPage.goto("/household");
    await memberPage.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });

    await memberPage.context().close();
  });

  test("a read-only member sees the same cards a write member does", async ({
    browser,
  }) => {
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_HH_VIEWER,
      password: E2E_MEMBER_PASSWORD,
    });

    await memberPage.goto("/household");
    await expect(memberPage.getByTestId("household-card")).toHaveCount(2);

    // Reads are allowed, so the whole card renders — the summary the write member
    // sees, not a stripped one. This is the CONVERSE of the removal above: the card
    // lost its actions, not its content, and an absence assertion alone would pass on
    // a page that had lost both.
    const p2Card = memberPage.locator(
      `[data-testid="household-card"][data-profile-id="${SEEDED_PROFILE_2}"]`
    );
    await expect(p2Card.getByTestId("household-digest")).toBeVisible();
    await expect(p2Card).toContainText("Supplements");
    await expect(p2Card).toContainText("Biomarkers optimal");

    await memberPage.context().close();
  });
});

// ── The recomposed card (#1463 §1) ───────────────────────────────────────────
//
// Runs as the default admin (storageState) on the shared seed, so it asserts the
// card's SHAPE rather than a digest line the seed could move under it. What each line
// SAYS is pinned where it is computed — lib/__db_tests__/digest-recent-changes.test.ts
// over the same collector, at the same 7-day window this page asks for.
test.describe("the household card is a status board, not an action surface", () => {
  test("every card carries a week digest, and none carries a dose action", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/household");
    const cards = page.getByTestId("household-card");
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const digest = card.getByTestId("household-digest");
      await expect(digest).toBeVisible();
      // Either the week's lines or the one quiet line — never an empty block, and
      // never news manufactured to fill it.
      const lines = digest.getByTestId("household-digest-line");
      const quiet = digest.getByTestId("household-digest-quiet");
      expect((await lines.count()) + (await quiet.count())).toBeGreaterThan(0);
      // The cap is the collector's and the card never exceeds it (#1463 §2).
      expect(await lines.count()).toBeLessThanOrEqual(4);
    }

    // The rows and their writes are gone from the page entirely.
    await expect(page.getByTestId("household-due-dose")).toHaveCount(0);
    await expect(page.getByTestId("household-confirm-dose")).toHaveCount(0);
    await expect(page.getByTestId("household-dose-aggregate")).toHaveCount(0);
  });

  // THE OVERFLOW LINE'S DESTINATION (#1463 §1, delta 1). `/timeline` is gone and
  // #1329 took `?subject=` out of the URL grammar, so a member's day is reachable only
  // by switching to them first — the control posts the member and the action resolves
  // their day server-side. Driven on the ACTING profile's own card, so the switch this
  // asserts is a no-op for the session and no neighbour inherits a moved pointer.
  //
  // The seed gives profile 1 far more than four changes in the window, so the control
  // is unconditionally present; a seed that went quiet fails here loudly rather than
  // letting the assertion pass on an absent control (probed with
  // `ALLOS_DB_PATH=<worker db> npx tsx` over collectRecentChanges at sinceDays 7:
  // profile 1 reported overflow=36).
  test("the digest's overflow line lands on that member's own day", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/household");
    const ownCard = page.locator(
      '[data-testid="household-card"][data-profile-id="1"]'
    );
    const more = ownCard.getByTestId("household-digest-more");
    await expect(more).toBeVisible();
    await expect(more).toHaveText(/^\+\d+ more this week$/);

    await more.click();
    await page.waitForURL(/\/history\?day=\d{4}-\d{2}-\d{2}/, {
      timeout: 20_000,
    });
    // It is the DAY view it landed on, not the record's default listing.
    await expect(page.getByTestId("app-content-container")).toBeVisible();
  });

  test("the attention count links out to Upcoming rather than acting here", async ({
    page,
  }) => {
    await page.goto("/household");
    const links = page.getByTestId("household-attention-link");
    // The seeded household has due doses, so at least one card states a count — and
    // every one that does states it the same way. Asserted over the whole set rather
    // than a first, because "the door exists somewhere" is not the claim.
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(links.nth(i)).toHaveAttribute("href", "/upcoming");
      await expect(links.nth(i)).toHaveText(/^\d+ needs? attention$/);
    }
  });
});

// ── The glance's biomarker line, and the doors above it (#3487) ──────────────
//
// Runs as the default admin (storageState), read-only, on the shared seed — so it
// asserts the SHAPE of the line rather than a number the seed could move under it.
// The number itself is pinned where the computation lives: the pillar's own
// `optimalRangeHitRate` tests, which this page now shares (#2023/#3487 item 1).
test.describe("the household glance's biomarker line (#3487)", () => {
  test("the member card states the broad-panel optimal fraction, never a rose out-of-range count", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/household");
    const cards = page.getByTestId("household-card");
    await expect(cards.first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: the set is judged below, order-agnostic
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      // The label is the dashboard's, because the axis is now the dashboard's.
      await expect(card).toContainText("Biomarkers optimal");
      // Either the fraction, or the honest absence when nothing is judgeable.
      const line = card.getByTestId("household-biomarkers");
      await expect(line).toHaveText(/(\d+ of \d+|no results yet)/);
      // The retired framing: a bare count of everything outside the LAB range,
      // rendered rose. Neither the phrasing nor the label may come back.
      await expect(card).not.toContainText("Out of range");
      await expect(card).not.toContainText(/\d+ biomarkers?\b/);
    }

    // A judged card carries the verdict as TEXT beside the colour (#1220): a
    // colour-only judgment is the thing that mapping exists to prevent.
    const judged = page
      .getByTestId("household-biomarkers")
      .filter({ hasText: /\d+ of \d+/ });
    if (await judged.count()) {
      const badge = judged.first().getByTestId("pillar-tone-badge"); // eslint-disable-line no-restricted-properties -- first-ok: one judged card is enough to prove the badge rides the fraction
      await expect(badge).toBeVisible();
    }
  });

  test("both header doors end on one glyph (#3487 item 5)", async ({
    page,
  }) => {
    await page.goto("/household");
    const cabinet = page.getByTestId("shared-supplies-link");
    const history = page.getByTestId("household-history-link");
    await expect(cabinet).toBeVisible();
    await expect(history).toBeVisible();

    // One glyph, and it is an SVG chevron on BOTH — not a literal arrow character on
    // one and a chevron on the other, which is what this row shipped.
    for (const door of [cabinet, history]) {
      await expect(door.locator("svg.h-4.w-4").last()).toBeVisible(); // last-ok: the trailing glyph is the one under test
      expect(await door.innerText()).not.toContain("→");
    }
  });
});
