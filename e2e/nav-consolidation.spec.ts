import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { openMobileDrawer, settledBoxes } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_NAV_FEMALE,
  E2E_LOGIN_NAV_MALE,
} from "./fixture-logins";

// Nav reorder + relevance gating (#1042 phase 1).
//
// 1. The frequency-ordered top level renders in the new order on BOTH viewports —
//    the desktop sidebar and the mobile drawer render the ONE shared
//    SidebarContent (#794), so each mount is asserted once, cheaply.
// 2. The Cycle entry is relevance-gated per cycleTrackingRelevant: visible for a
//    female premenopausal fixture, hidden for a male fixture with no cycle rows —
//    and the gate is COSMETIC (the page renders on a direct URL either way).
// 3. The four specialty surfaces (Vision/Dental/Skin/Mental health) folded into the
//    Health record page (#1042 final tail) — none is a Medical nav leaf anymore.
//
// Fixture hygiene (#868): the gating tests run as the two dedicated read-only
// nav fixtures (e2e/fixture-logins.ts) in their own cookie-less contexts; the
// order tests only READ the shared admin session's sidebar (profile 1 owns
// vision/dental/cycle data, so every entry is present there). No mutations.

// The #1042 frequency order, re-applied in #3079 to MEASURED frequency instead of
// the estimate it was first set from. Six rows the owner never opened deliberately
// became children of one "Plan & review" group; none of the six was retired, and
// each kept the gate it carried as a top-level row (Household still needs 2+
// profiles, Longevity is still adult-only, Wellness/Progress photos still carry
// their relevance bits). #2762 removes the once-a-year retrospective from permanent
// nav chrome; the command palette and recent-pages carry it instead, since #3958
// phase 2 deleted the Timeline header action that used to be its one in-app door.
//
// UNCHANGED by #1522 on purpose: the medicine-cabinet row this repo just deleted was
// a child of the Medical GROUP, not a top-level entry, so it never appeared in this
// list. The list that DID change is the Medical group's children, asserted below —
// "Medicine cabinet" moved from present to gone there.
const TOP_LEVEL_ORDER: (string | RegExp)[] = [
  "Dashboard",
  "Training",
  "Nutrition",
  "Trends",
  "Sleep",
  // #3079: Timeline (now History), Upcoming, Household, Wellness, Longevity and
  // Progress photos
  // are children of this group now, so the top level carries ONE row where it used
  // to carry six. Collapsed on "/" (no child route is active), which is why the
  // group's whole text content here is its header label.
  "Plan & review",
  "Medical",
  // The Data entry carries the import-review badge since #1801 (it is Data →
  // Review's count), so its text is "Data" plus a digit whenever the seeded
  // always-failing Strava integration is in a failed state. A prefix match keeps
  // the ORDER assertion about order rather than about that count.
  /^Data/,
  "Settings",
];

test("desktop sidebar renders the frequency-ordered top level (#1042)", async ({
  page,
}) => {
  await page.goto("/");
  // The desktop aside is the only <aside> while the drawer is closed. On "/" no
  // Medical child is active, so the group is collapsed and each top-level entry's
  // text content is exactly its label.
  const entries = page.locator("aside nav > *");
  await expect(entries).toHaveText(TOP_LEVEL_ORDER);
});

// The same list, read on the surface where the groups are NOT folded (#3343 Q4).
// A group entry's text content is its header followed by its inline children, so
// the two group rows are prefix-anchored here and every leaf stays exact — same
// entries, same positions, still one row per top-level entry.
const GROUP_LABELS = ["Plan & review", "Medical"];
const DRAWER_TOP_LEVEL_ORDER: (string | RegExp)[] = TOP_LEVEL_ORDER.map((e) =>
  typeof e === "string" && GROUP_LABELS.includes(e) ? new RegExp(`^${e}`) : e
);

test("mobile drawer renders the same order through the shared content (#1042)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const drawer = await openMobileDrawer(page);
  const drawerNav = drawer.locator("nav");
  await expect(drawerNav.locator("> *")).toHaveText(DRAWER_TOP_LEVEL_ORDER);
});

// Open the Medical group WITHOUT clicking: navigating to an always-visible child
// route (Illness episodes) force-expands the group (active-child rule), so the
// children list is asserted with zero interaction flake.
async function gotoExpandedMedical(page: Page): Promise<void> {
  await page.goto("/medical/episodes");
  await expect(
    page.locator("aside nav").getByRole("link", { name: "Illness episodes" })
  ).toBeVisible();
}

test("Cycle entry shows for a female premenopausal profile; the folded Medical group is its final shape (#1042)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NAV_FEMALE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await gotoExpandedMedical(page);
    const nav = page.locator("aside nav");
    await expect(nav.getByRole("link", { name: "Cycle" })).toBeVisible();
    // The #1042 target Medical group — Health record · Results · Medications ·
    // Illness episodes · Cycle · Passport — is present. (Substance use, a #998
    // surface, folded into Health record › Specialty as an adult-gated section in
    // #1175, so it is no longer a Medical nav leaf.)
    for (const present of [
      "Health record",
      "Results",
      "Medications",
      "Illness episodes",
      "Cycle",
      "Passport",
    ]) {
      await expect(nav.getByRole("link", { name: present })).toBeVisible();
    }
    // The eleven core index leaves collapsed into "Health record" …
    for (const gone of ["Conditions", "Providers", "Coverage gaps", "Visits"]) {
      await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
    }
    // … and the specialty leaves (incl. Substance use, folded into Records ›
    // Specialty in #1175) + the standalone Crisis support leaf are gone too (all
    // folded into Health record; /crisis-resources stays a route, only its nav slot
    // was removed).
    for (const gone of [
      "Vision",
      "Dental",
      "Skin",
      "Mental health",
      "Substance use",
      "Crisis support",
    ]) {
      await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
    }
  } finally {
    await page.context().close();
  }
});

// ── Physical registries are reached from their consumers (#1522) ─────────────
// The shared ADMIN session is the fixture that matters here: it reaches 2+ profiles,
// which is the exact condition the old `requiresMultiProfile` "Medicine cabinet" row
// appeared under. Asserting its absence on a single-profile login would pass
// vacuously. Read-only — these cases only navigate and inspect the sidebar.

test("the medicine cabinet has no nav row, even for a multi-profile session (#1522)", async ({
  page,
}) => {
  await gotoExpandedMedical(page);
  const nav = page.locator("aside nav");
  // The group is expanded (Illness episodes proves it), so a surviving row WOULD be
  // visible — the absence below is a real observation, not a collapsed group.
  await expect(
    nav.getByRole("link", { name: "Illness episodes" })
  ).toBeVisible();
  await expect(nav.getByRole("link", { name: "Medications" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Medicine cabinet" })).toHaveCount(
    0
  );
});

test("a registry route reached from its consumers highlights its PARENT entry (#1522)", async ({
  page,
}) => {
  const nav = page.locator("aside nav");

  // The cabinet: no row of its own, so it lights Medications — and the Medical group
  // force-expands around it, which is what puts the lit entry on screen at all.
  await page.goto("/supplies");
  await expect(page.getByTestId("supplies-page")).toBeVisible();
  await expect(nav.getByRole("link", { name: "Medications" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  // Exactly ONE entry claims the page — the child never lights itself, and the plain
  // prefix rule drags nothing else along.
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

  // The equipment registry, whose pattern this follows, had the same orphan wart.
  await page.goto("/equipment");
  await expect(nav.getByRole("link", { name: "Training" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);

  // Sanity: an ordinary route still highlights itself, so the map didn't swallow
  // the normal rule. Since #3079 this ALSO exercises group auto-expansion — the
  // History row is only in the DOM at all because navigating to a grouped child
  // force-expands its group (isGroupActive). It is the row Timeline vacated when
  // #3958 phase 2 retired that route (#3343).
  await page.goto("/history");
  await expect(nav.getByRole("link", { name: "History" })).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
});

// ── The episodic group (#3079) ───────────────────────────────────────────────
//
// Membership is pinned here so a future edit cannot silently promote a child back
// to the top level: TOP_LEVEL_ORDER above would still pass if a child were ADDED
// to the group, and would still pass if the group were empty. These cases close
// both directions — the exact children, and each child reached with the group
// auto-expanding around it.

// The group's children AS THE SHARED ADMIN FIXTURE SEES THEM, in registry order.
//
// PROGRESS PHOTOS IS THE SIXTH CHILD AND IS DELIBERATELY ABSENT HERE: it rides the
// `progress` relevance bit, and profile 1 seeds no progress photos — which is why
// it was missing from TOP_LEVEL_ORDER before this change too. Listing it would
// assert a row that cannot render for this fixture. Its membership is pinned where
// it can be: as text in lib/__tests__/nav-routes.test.ts, and behaviorally in
// e2e/progress-photos.spec.ts, which watches the row appear inside this group the
// moment that profile's first photo lands (and, being on /progress at the time,
// proves the same auto-expansion the case below asserts for the others).
// History INHERITED Timeline's place here when #3958 phase 2 deleted that route
// (#3343: "when phase 2 absorbs the timeline and vacates its slot, History inherits
// it"). The list is the group's whole membership, so the substitution is the
// assertion — a row added beside the inherited one, rather than in place of it,
// fails this.
const PLAN_REVIEW_CHILDREN = [
  "Upcoming",
  "History",
  "Wellness",
  "Longevity",
  "Household",
];

test("the episodic group holds exactly its children, and none of them is a top-level row (#3079)", async ({
  page,
}) => {
  await page.goto("/");
  const nav = page.locator("aside nav");
  // Collapsed to begin with: the group is the demotion, so a group that renders
  // its children unprompted would not be one.
  const header = nav.getByRole("button", { name: "Plan & review" });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  for (const child of PLAN_REVIEW_CHILDREN) {
    await expect(nav.getByRole("link", { name: child })).toHaveCount(0);
  }

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  // The group's panel — NOT the whole nav — so "exactly these, in this order" is a
  // statement about MEMBERSHIP. Read from the panel the header controls, which is
  // the only handle that survives the group being re-styled or re-wrapped.
  // Read by ATTRIBUTE rather than as a `#id` selector: the panel id is derived
  // from the group's label, and an id selector is the one consumer that cares
  // whether that derivation left punctuation behind.
  const panelId = await header.getAttribute("aria-controls");
  const panel = nav.locator(`[id="${panelId}"]`);
  await expect(panel.getByRole("link")).toHaveText(PLAN_REVIEW_CHILDREN);
});

// ── The drawer expands the group, the sidebar keeps the fold (#3343 Q4) ──────
//
// ONE test carrying BOTH halves, deliberately: either half alone still passes on a
// tree where the two surfaces behave identically, and identical is the state this
// ruling changes away from. The phone half is the ruling — on a phone scrolling is
// cheap and taps are expensive, the reverse of the desktop trade the fold was
// designed for. The desktop half is what the ruling must not take with it.
//
// #2651 fixed the DOCK at four slots; this is the drawer's own pin.
test("the phone drawer renders the group inline while the desktop sidebar still folds (#3343)", async ({
  page,
}) => {
  // DESKTOP first, so the drawer is opened last and no assertion can resolve to
  // the wrong <aside>.
  await page.goto("/");
  const sidebarNav = page.locator("aside nav");
  const header = sidebarNav.getByRole("button", { name: "Plan & review" });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  for (const child of PLAN_REVIEW_CHILDREN) {
    await expect(sidebarNav.getByRole("link", { name: child })).toHaveCount(0);
  }

  // PHONE. Nothing here taps the group: openMobileDrawer taps the dock's More
  // slot and stops, so every row below is on screen at zero cost.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const drawer = await openMobileDrawer(page);
  const group = drawer.locator('[data-nav-group="Plan & review"]');
  await expect(group.getByRole("link")).toHaveText(PLAN_REVIEW_CHILDREN);
  // And nothing to tap: the header is a label here, not a disclosure control.
  await expect(
    drawer.getByRole("button", { name: "Plan & review" })
  ).toHaveCount(0);

  // GROUPED FOR SOMEONE WHO CANNOT SEE THE INDENT. Dropping the disclosure button
  // dropped its aria-controls with it, so the association is restated on the
  // container — and the assertion has to be the COMPUTED NAME, not the presence of
  // an `aria-labelledby`: a container labelled by nothing, or by the wrong
  // element, still HAS the attribute. This resolves the reference and reads what a
  // screen reader would announce, and the rows above are read from the very same
  // container, so "named" and "contains the rows" are one element's two facts.
  await expect(group).toHaveRole("group");
  await expect(group).toHaveAccessibleName("Plan & review");

  // STILL GROUPED UNDER ITS HEADER, which is the half of the ruling that a
  // flattening change would quietly satisfy. Two readings, because "inline" could
  // honestly mean either one:
  //   · the rows and the header share the group's OWN container (the locator
  //     above), and the nav's direct children are still one per top-level entry —
  //     so the group did not dissolve its rows into its neighbours;
  //   · and a child's label starts to the RIGHT of its header's label. Measured
  //     between two real elements inside this group rather than against a gutter
  //     constant: indentation is a relationship, and it is the thing a person
  //     looking at the drawer actually sees.
  await expect(drawer.locator("nav > *")).toHaveCount(TOP_LEVEL_ORDER.length);
  const [headerLabel, childLabel] = await settledBoxes([
    group.getByText("Plan & review", { exact: true }),
    group.getByText("History", { exact: true }),
  ]);
  expect(
    childLabel.x,
    "a group child's label is indented past its own header's"
  ).toBeGreaterThan(headerLabel.x);
});

test("navigating to any grouped child auto-expands its group and lights exactly one row (#3079)", async ({
  page,
}) => {
  const nav = page.locator("aside nav");
  const HREFS: Record<string, string> = {
    Upcoming: "/upcoming",
    History: "/history",
    Wellness: "/wellness",
    Longevity: "/longevity",
    Household: "/household",
  };
  for (const [label, href] of Object.entries(HREFS)) {
    await page.goto(href);
    // No click anywhere: the group opened because its child route is active, which
    // is the whole reason a demoted surface is not stranded behind a disclosure.
    const row = nav.getByRole("link", { name: label, exact: true });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("aria-current", "page");
    // Exactly one entry claims the page — the group header lights up too, but it is
    // a <button>, not an aria-current link, so the "one lit row" rule is intact.
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  }
});

test("Cycle entry hides for a male profile with no cycle rows, but the page never hard-blocks (#1042)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NAV_MALE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await gotoExpandedMedical(page);
    const nav = page.locator("aside nav");
    await expect(
      nav.getByRole("link", { name: "Illness episodes" })
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: "Cycle" })).toHaveCount(0);
    // The nav gate is cosmetic — a direct URL still renders the Cycle page.
    await page.goto("/medical/cycles");
    await expect(
      page.getByRole("heading", { name: "Cycle", exact: true })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

// ── THE DRAWER'S LENGTH IS NOW A MEASURED THING (#4102, closing #3343's flag) ─
//
// The Q4 ruling grew the drawer's nav from ~9 rows to ~21, and the lane that
// landed it recorded the gap rather than papering over it: *"nothing in the repo
// would currently notice if that made the drawer unusably long: every existing
// drawer spec passes regardless, because Playwright's visibility check is not
// viewport-bounded."*
//
// THAT SENTENCE IS THIS TEST'S WHOLE SUBJECT. `toBeVisible()` asks whether an
// element has a box, is displayed and is not `visibility: hidden`. It does NOT
// ask whether the box is on the screen. An element 3000px down a scroll container
// is "visible" to every drawer spec in this repo, so a drawer that had grown past
// anything a thumb could reach would have gone green everywhere. `toBeInViewport`
// is the matcher that asks the other question, and the two are asserted together
// below on the SAME element at the SAME moment, because the pair is the lesson.
//
// TWO INDEPENDENT WAYS THIS CAN FAIL, and they catch different defects:
//
//   1. THE PANEL ESCAPES THE VIEWPORT. The drawer is `absolute inset-y-0` inside a
//      `fixed inset-0` host and scrolls its own overflow. If any of that comes
//      undone — a height that grows with content, an `overflow-y` that stops being
//      `auto`, a transformed ancestor re-parenting the fixed host — then content
//      past the fold is unreachable no matter how hard anyone scrolls, and the page
//      behind is scroll-locked so there is no second scroller to rescue it. That is
//      the "unusably long" defect in its literal form, and it is asserted as a
//      RELATIONSHIP (panel box against viewport box), never against a constant.
//   2. THE FOOTER IS NOT REACHABLE. Scroll the drawer to its end and the last row
//      must be FULLY on screen (`ratio: 1`, not merely intersecting), because a
//      Disclaimer link half off the bottom edge is not a reachable Disclaimer link.
//
// AND IT IS GUARDED AGAINST BEING VACUOUS, which is the failure mode this whole
// test exists because of. If the drawer fitted on one screen, "reachable by
// scroll" would be a claim about nothing: the footer would already be there and
// the scroll would be a no-op. So the overflow itself is asserted first, and the
// footer is asserted OFF SCREEN before the scroll.
//
// THE MARGIN, MEASURED, because a control nobody has costed is a guess — and
// RE-DERIVED against the shorter drawer in #4280, which is what this note said to
// do rather than dropping the check. The calendar band left for /history and took
// 318px with it (302px of band plus the column's own `gap-4`), not the ~230px the
// move was estimated at: on the seeded admin at 390x844 the drawer's content was
// 1336px inside an 844px panel — 1.58 screens, 492px of overflow — and is 1018px
// now, 1.21 screens, 174px over. The footer assertion below is the tighter of the
// two and it also survived: the Disclaimer link's top was 1304px and is 986px,
// still 142px past an 844px fold.
//
// AND THE GUARD CAN STILL FAIL, which is the only thing that makes 174px a margin
// rather than a number. Measured by hiding one nav group in the rendered drawer
// (the Medical group alone): `scrollHeight` drops to exactly `clientHeight` and
// the assertion below reds. So the drawer is one nav group away from fitting one
// screen, and this control is watching a live quantity — not passing because
// nothing could ever make it fail.
test("the drawer is viewport-bounded and its footer is reachable by scroll at 390x844 with every group expanded (#4102)", async ({
  page,
}) => {
  const VIEWPORT = { width: 390, height: 844 };
  await page.setViewportSize(VIEWPORT);
  await page.goto("/");
  const drawer = await openMobileDrawer(page);

  // THE PRECONDITION THE LENGTH CLAIM IS ABOUT. Nothing is tapped to get here —
  // the drawer expands every group by ruling — so asserting the children are
  // present is asserting the drawer is at its FULL height, which is the only
  // height worth measuring. Both groups, because a claim about "all groups
  // expanded" that checked one of them would be measuring a shorter drawer.
  for (const group of GROUP_LABELS) {
    // Every one of the group's rows, not just its first: "all groups expanded" is
    // a claim about the whole membership, and a partially-rendered group would
    // give a shorter drawer than the one this test exists to measure.
    const rows = drawer
      .locator(`[data-nav-group="${group}"]`)
      .getByRole("link");
    await expect(rows).not.toHaveCount(0);
    for (const row of await rows.all()) await expect(row).toBeVisible();
  }
  await expect(
    drawer.getByRole("link", { name: "Illness episodes" })
  ).toBeVisible();

  const geometry = await drawer.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });

  // (1) The panel's own box, against the viewport it must not exceed.
  expect(
    geometry.top,
    "the drawer starts at or below the viewport top"
  ).toBeGreaterThanOrEqual(-1);
  expect(
    geometry.bottom,
    "the drawer ends at or above the viewport bottom — a panel taller than the screen puts its tail out of every reach"
  ).toBeLessThanOrEqual(VIEWPORT.height + 1);

  // The non-vacuity control: with every group inline the content really is longer
  // than one screen, so everything below is a claim about a scroll that matters.
  expect(
    geometry.scrollHeight,
    "the drawer overflows one screen with all groups expanded"
  ).toBeGreaterThan(geometry.clientHeight);

  const footer = drawer.getByRole("link", { name: "Disclaimer" });
  // THE PAIR. Same element, same instant, opposite answers — and the left-hand one
  // is what every other drawer spec in this repo would have been satisfied by.
  await expect(footer).toBeVisible();
  await expect(footer).not.toBeInViewport();

  // (2) Reachable. Scroll the drawer's own scroller, not the page's: the page is
  // scroll-locked behind the modal, so `mouse.wheel` would move nothing.
  await drawer.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(footer).toBeInViewport({ ratio: 1 });
});

test("an upgraded browser drops the retired Frequent tally on load (#4102)", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("allos:page-visits:v1", '{"/history":{"n":9,"t":1}}')
  );

  await page.reload();

  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("allos:page-visits:v1"))
    )
    .toBeNull();
});
