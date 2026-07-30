import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { expectNoClippedContent, followLink } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_NAV_MALE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// The Health record surface (#1079): the 14 medical sections as two-level tabs —
// group tab → section sub-tab → one pane — superseding the #1042 stacked-section
// page. Grouping (FINALIZED): History (Visits · Procedures · Immunizations),
// Problems (Conditions · Allergies — un-stacked into two panes by #1449), Care (Overview stacked:
// Background + Family history + Care plan + Health goals · Providers solo),
// Specialty (Vision · Dental · Skin · Mental health · Substance use; Vision/Dental
// data-gated, Substance use life-stage-gated to adults — #1174/#1175). The
// core rule: a pane renders ONE section, except a curated set of LIGHT sections may
// share a stacked pane; heavy sections (the Immunizations chart, the Visits list,
// the Providers directory) are NEVER stacked. Bare `/records` → `/records/history/
// visits`. The removed index routes now 404 (#1635 dropped the compatibility
// table); DETAIL routes survive.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile
// (profile 1 owns conditions/allergies/immunizations/providers/optical/dental via
// scripts/seed.ts). Presence-only assertions — never exact counts of shared-seed
// rows.

const DB_PATH = workerDbPath();

test("bare /records redirects to History › Visits and renders the Visits list (#1079)", async ({
  page,
}) => {
  await page.goto("/records");
  await expect(page).toHaveURL(/\/records\/history\/visits$/);
  await expect(
    page.getByRole("heading", { name: "Health record", exact: true })
  ).toBeVisible();
  // A solo heavy pane renders alone — the Visits list, not stacked with others.
  await expect(page.getByTestId("records-visits")).toBeVisible();
  await expect(page.getByTestId("visits-past")).toBeVisible();
  await expect(page.getByTestId("records-conditions")).toHaveCount(0);
});

test("two-level tabs navigate group → sub-tab across the panes (#1079)", async ({
  page,
}) => {
  await page.goto("/records/history/visits");
  const groups = page.getByTestId("records-group-tabs");
  const subs = page.getByTestId("records-sub-tabs");

  // History secondary strip: Visits · Procedures · Immunizations.
  await followLink(
    page,
    subs.getByRole("link", { name: "Procedures" }),
    /\/records\/history\/procedures$/
  );
  await expect(page.getByTestId("records-procedures")).toBeVisible();

  // Immunizations — a solo heavy pane (its schedule chart) rendered alone.
  await followLink(
    page,
    page.getByTestId("records-sub-tabs").getByRole("link", {
      name: "Immunizations",
    }),
    /\/records\/history\/immunizations$/
  );
  await expect(page.getByTestId("records-immunizations")).toBeVisible();
  await expect(page.getByTestId("records-procedures")).toHaveCount(0);

  // Care group tab → its Overview pane.
  await followLink(
    page,
    page.getByTestId("records-group-tabs").getByRole("link", { name: "Care" }),
    /\/records\/care\/overview$/
  );
  // Care › Overview is a STACKED pane — all four light sections render together.
  await expect(page.getByTestId("records-background")).toBeVisible();
  await expect(page.getByTestId("records-family-history")).toBeVisible();
  await expect(page.getByTestId("records-care-plan")).toBeVisible();
  await expect(page.getByTestId("records-health-goals")).toBeVisible();

  // Care › Providers — the heavy directory, a solo pane.
  await followLink(
    page,
    page
      .getByTestId("records-sub-tabs")
      .getByRole("link", { name: "Providers" }),
    /\/records\/care\/providers$/
  );
  await expect(page.getByTestId("records-providers")).toBeVisible();
  await expect(page.getByTestId("records-background")).toHaveCount(0);

  // Problems is a normal two-pane group since #1449 — it was the family's one
  // stacked outlier, and the pill sub-tabs are what let its sections stop naming
  // themselves with page-scale in-page headings.
  await followLink(
    page,
    groups.getByRole("link", { name: "Problems" }),
    /\/records\/problems\/conditions$/
  );
  const problemSubs = page.getByTestId("records-sub-tabs");
  await expect(
    problemSubs.getByRole("link", { name: "Conditions" })
  ).toBeVisible();
  await expect(
    problemSubs.getByRole("link", { name: "Allergies" })
  ).toBeVisible();
  // One pane at a time: Conditions renders alone, Allergies is a sub-tab away.
  await expect(page.getByTestId("records-conditions")).toBeVisible();
  await expect(page.getByTestId("records-allergies")).toHaveCount(0);

  await followLink(
    page,
    problemSubs.getByRole("link", { name: "Allergies" }),
    /\/records\/problems\/allergies$/
  );
  await expect(page.getByTestId("records-allergies")).toBeVisible();
  await expect(page.getByTestId("records-conditions")).toHaveCount(0);

  // The bare group route forwards to its first pane, like History and Care.
  await page.goto("/records/problems");
  await expect(page).toHaveURL(/\/records\/problems\/conditions$/);
});

// #1449 cluster C: the family had grown FOUR controls for "narrow this list" —
// filled pills on Problems, a "Show" + <select> on Immunizations, an "All statuses"
// <select> on Skin and Dental. One affordance now, the outline pill group, and each
// state is a real URL where the filter rides a query param.
test("list surfaces share ONE filter affordance — outline pills, no dropdown (#1449)", async ({
  page,
}) => {
  await page.goto("/records/problems/conditions");
  const condFilter = page.getByTestId("conditions-filter");
  await expect(condFilter).toBeVisible();
  for (const label of ["All", "Active", "Resolved"]) {
    await expect(condFilter.getByRole("link", { name: label })).toBeVisible();
  }
  // Filtering is a navigation, and the chosen pill marks itself current.
  await followLink(
    page,
    condFilter.getByRole("link", { name: "Active" }),
    /\/records\/problems\/conditions\?cond=active$/
  );
  await expect(
    page.getByTestId("conditions-filter").getByRole("link", { name: "Active" })
  ).toHaveAttribute("aria-current", "true");

  // Immunizations: the same pill group, and no <select> left behind.
  await page.goto("/records/history/immunizations");
  const vaxFilter = page.getByTestId("immunization-status-filter");
  await expect(vaxFilter).toBeVisible();
  await expect(vaxFilter.getByRole("link", { name: "All" })).toBeVisible();
  await expect(
    vaxFilter.getByRole("link", { name: "Needs attention" })
  ).toBeVisible();
  // Scoped to the FILTER, exactly like the Skin case below: a form field is not a
  // filter affordance, and the add/edit dose form legitimately carries its own
  // <select> (the #1406 route picker). The invariant this test owns is "no filter
  // dropdown", not "no <select> anywhere on the pane".
  await expect(vaxFilter.locator("select")).toHaveCount(0);

  // Skin: a client-state list, so buttons rather than links — same pills either way.
  // (Only the FILTER is pinned here: the per-row edit forms below legitimately keep
  // their <select>s — a form field is not a filter affordance.)
  await page.goto("/records/specialty/skin");
  const skinFilter = page.getByTestId("skin-status-filter");
  await expect(skinFilter).toBeVisible();
  await expect(skinFilter.getByRole("button", { name: "All" })).toBeVisible();
  await expect(skinFilter.locator("select")).toHaveCount(0);
});

// #1449 layout kin: the CDC schedule grid has more age columns than a phone has
// pixels. It used to squeeze them to slivers and clip the right edge silently; it
// must now scroll INSIDE its own container, leaving the page body itself free of
// horizontal scroll (the wide-content rule).
test("the CDC schedule grid scrolls in-container on a phone (#1449)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/records/history/immunizations");
  const grid = page.getByTestId("cdc-schedule-grid");
  await expect(grid).toBeVisible();

  const overflow = await grid.evaluate((el) => ({
    scrollable: el.scrollWidth > el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
  }));
  expect(overflow.scrollable).toBe(true);
  expect(overflow.overflowX).toBe("auto");

  // …and the grid's width is CONTAINED: every element's right edge inside the
  // viewport unless it sits in a scroller that itself fits (which is exactly the
  // grid's own container, asserted above). The page-level width comparison this
  // replaces could not fail (#1543) — the app shell clips the overflow, so the
  // document never reports itself wider than the viewport, in either direction.
  await expectNoClippedContent(page);
});

test("the five specialty sub-tabs render with rare entry collapsed and the crisis line present (#1079, #1497)", async ({
  page,
}) => {
  test.slow();
  // Profile 1 owns optical + dental rows (Vision/Dental relevant) and is an adult
  // (Substance use ungated), so all five specialty sub-tabs show.
  await page.goto("/records/specialty/vision");
  const subs = page.getByTestId("records-sub-tabs");
  for (const label of [
    "Vision",
    "Dental",
    "Skin",
    "Mental health",
    "Substance use",
  ]) {
    await expect(subs.getByRole("link", { name: label })).toBeVisible();
  }

  await expect(
    page
      .getByTestId("records-vision")
      .getByTestId("add-prescription-panel-toggle")
  ).toBeVisible();
  await expect(page.getByTestId("optical-prescription-form")).toBeHidden();

  await followLink(
    page,
    page.getByTestId("records-sub-tabs").getByRole("link", { name: "Dental" }),
    /\/records\/specialty\/dental$/
  );
  await expect(
    page
      .getByTestId("records-dental")
      .getByTestId("add-dental-record-panel-toggle")
  ).toBeVisible();
  await expect(page.getByTestId("dental-procedure-form")).toBeHidden();

  await followLink(
    page,
    page.getByTestId("records-sub-tabs").getByRole("link", { name: "Skin" }),
    /\/records\/specialty\/skin$/
  );
  await expect(
    page.getByTestId("records-skin").getByTestId("add-skin-lesion-panel-toggle")
  ).toBeVisible();
  await expect(page.getByTestId("skin-lesion-form")).toBeHidden();

  // Mental health — its crisis line travels WITH the route (the safety contract is
  // content, not route, #716/#1079).
  await followLink(
    page,
    page.getByTestId("records-sub-tabs").getByRole("link", {
      name: "Mental health",
    }),
    /\/records\/specialty\/mental-health$/
  );
  await expect(
    page.getByTestId("records-mental-health").getByTestId("instruments-form")
  ).toBeVisible();
  await expect(
    page
      .getByTestId("records-mental-health")
      .getByTestId("instrument-crisis-support-link")
  ).toBeVisible();

  // Substance use — the 5th specialty section (#1175), adult-gated (#1174) so it
  // renders for this adult profile with its in-app screening form.
  await followLink(
    page,
    page.getByTestId("records-sub-tabs").getByRole("link", {
      name: "Substance use",
    }),
    /\/records\/specialty\/substance-use$/
  );
  await expect(
    page
      .getByTestId("records-substance-use")
      .getByTestId("substance-instruments-form")
  ).toBeVisible();
});

test("a no-data profile hides the Vision/Dental sub-tabs AND its route re-gates (#1079)", async ({
  browser,
}) => {
  // The male nav fixture owns no optical/dental rows (e2e/fixture-logins.ts), so the
  // data-gated specialty sub-tabs drop while Skin/Mental health stay, and a direct
  // hit on the gated route re-gates server-side (the SettingsTabs admin-tab
  // discipline: a hidden tab is an unreachable route).
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NAV_MALE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Specialty group tab lands on the first VISIBLE pane (Skin) for this profile.
    await page.goto("/records/specialty/skin");
    const subs = page.getByTestId("records-sub-tabs");
    await expect(subs.getByRole("link", { name: "Skin" })).toBeVisible();
    await expect(
      subs.getByRole("link", { name: "Mental health" })
    ).toBeVisible();
    await expect(subs.getByRole("link", { name: "Vision" })).toHaveCount(0);
    await expect(subs.getByRole("link", { name: "Dental" })).toHaveCount(0);

    // The gated route re-gates: a direct hit redirects to the first visible pane.
    await page.goto("/records/specialty/vision");
    await expect(page).toHaveURL(/\/records\/specialty\/skin$/);
    await page.goto("/records/specialty/dental");
    await expect(page).toHaveURL(/\/records\/specialty\/skin$/);
  } finally {
    await page.context().close();
  }
});

test("detail routes survive and their back-links point at the owning panes (#1079)", async ({
  page,
}) => {
  // Only the INDEX pages folded — the provider detail page keeps its route, and its
  // back-link points at the Providers pane.
  const db = new Database(DB_PATH, { readonly: true });
  let providerId: number;
  try {
    const row = db
      .prepare("SELECT id FROM providers ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    if (!row) throw new Error("no seeded provider");
    providerId = row.id;
  } finally {
    db.close();
  }

  await page.goto(`/providers/${providerId}`);
  await expect(
    page.getByRole("link", { name: /Back to providers/ })
  ).toHaveAttribute("href", "/records/care/providers");

  await page.goto("/immunizations/tdap");
  await expect(
    page.getByRole("link", { name: /Back to immunizations/ }).first() // first-ok: the single "Back to immunizations" link on the tdap detail page; href asserted
  ).toHaveAttribute("href", "/records/history/immunizations");
});

test("the Medical nav group shows one Health record leaf in place of the old ones (#1079)", async ({
  page,
}) => {
  await page.goto("/records/history/visits");
  const nav = page.locator("aside nav");
  await expect(nav.getByRole("link", { name: "Health record" })).toBeVisible();
  for (const gone of [
    "Conditions",
    "Allergies",
    "Procedures",
    "Immunizations",
    "Family History",
    "Visits",
    "Providers",
    "Care Plan",
    "Health Goals",
    "Background",
  ]) {
    await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
  }
});
