import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_NAV_MALE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The Health record surface (#1079): the 14 medical sections as two-level tabs —
// group tab → section sub-tab → one pane — superseding the #1042 stacked-section
// page. Grouping (FINALIZED): History (Visits · Procedures · Immunizations),
// Problems (one stacked pane: Conditions + Allergies), Care (Overview stacked:
// Background + Family history + Care plan + Health goals · Providers solo),
// Specialty (Vision · Dental · Skin · Mental health · Substance use; Vision/Dental
// data-gated, Substance use life-stage-gated to adults — #1174/#1175). The
// core rule: a pane renders ONE section, except a curated set of LIGHT sections may
// share a stacked pane; heavy sections (the Immunizations chart, the Visits list,
// the Providers directory) are NEVER stacked. Bare `/records` → `/records/history/
// visits`. Removed index routes 308-redirect to the owning pane; DETAIL routes
// survive.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile
// (profile 1 owns conditions/allergies/immunizations/providers/optical/dental via
// scripts/seed.ts). Presence-only assertions — never exact counts of shared-seed
// rows.

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

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

  // Problems is a single stacked pane (no secondary strip): Conditions + Allergies.
  await followLink(
    page,
    groups.getByRole("link", { name: "Problems" }),
    /\/records\/problems$/
  );
  await expect(page.getByTestId("records-conditions")).toBeVisible();
  await expect(page.getByTestId("records-allergies")).toBeVisible();
  // A single-pane group shows no secondary strip.
  await expect(page.getByTestId("records-sub-tabs")).toHaveCount(0);
});

test("the five specialty sub-tabs render for the seeded profile, with their forms + crisis line (#1079)", async ({
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
    page.getByTestId("records-vision").getByTestId("optical-prescription-form")
  ).toBeVisible();

  await followLink(
    page,
    page.getByTestId("records-sub-tabs").getByRole("link", { name: "Dental" }),
    /\/records\/specialty\/dental$/
  );
  await expect(
    page.getByTestId("records-dental").getByTestId("dental-procedure-form")
  ).toBeVisible();

  await followLink(
    page,
    page.getByTestId("records-sub-tabs").getByRole("link", { name: "Skin" }),
    /\/records\/specialty\/skin$/
  );
  await expect(
    page.getByTestId("records-skin").getByTestId("skin-lesion-form")
  ).toBeVisible();

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

test("the removed index routes 308-redirect to their owning panes (#1079)", async ({
  page,
}) => {
  // Request-level assertion — no per-route Chromium navigation. Each old route points
  // at the pane that now owns its section.
  const redirects = [
    { from: "/conditions", to: "/records/problems" },
    { from: "/allergies", to: "/records/problems" },
    { from: "/procedures", to: "/records/history/procedures" },
    { from: "/immunizations", to: "/records/history/immunizations" },
    { from: "/family-history", to: "/records/care/overview" },
    { from: "/encounters", to: "/records/history/visits" },
    { from: "/providers", to: "/records/care/providers" },
    { from: "/care-plan", to: "/records/care/overview" },
    { from: "/care-goals", to: "/records/care/overview" },
    { from: "/medical/background", to: "/records/care/overview" },
    { from: "/vision", to: "/records/specialty/vision" },
    { from: "/dental", to: "/records/specialty/dental" },
    { from: "/skin", to: "/records/specialty/skin" },
    { from: "/medical/instruments", to: "/records/specialty/mental-health" },
    // Coverage gaps relocated to Data → Coverage (#1086).
    { from: "/coverage", to: "/data?section=coverage" },
  ];
  for (const r of redirects) {
    const res = await page.request.get(r.from, { maxRedirects: 0 });
    expect(res.status(), r.from).toBe(308);
    expect(res.headers()["location"], r.from).toBe(r.to);
  }

  // Query strings ride through — the Visits Book-CTA deep link keeps its prefill.
  const withQuery = await page.request.get("/encounters?new=1&title=Physical", {
    maxRedirects: 0,
  });
  expect(withQuery.status()).toBe(308);
  expect(withQuery.headers()["location"]).toBe(
    "/records/history/visits?new=1&title=Physical"
  );
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
