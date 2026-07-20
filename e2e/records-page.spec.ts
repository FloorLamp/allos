import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// The merged Health record page (#1042 phase 6): the eleven core Medical index
// pages (Conditions, Allergies, Procedures, Immunizations, Family history,
// Visits, Providers, Background, Care plan, Health goals, Coverage gaps) fold into
// ONE stacked-section page at real anchors (/records#conditions, #visits, …), the
// removed index routes 308-redirect there (query strings preserved), and the
// DETAIL routes (/providers/[id], /encounters/[id], /immunizations/[vaccine])
// survive at their own URLs. Section visibility mirrors the nav's predicate: none
// of the eleven constituent leaves carried a nav gate, so all eleven sections
// always render (each with its own empty state) — there is deliberately NO
// hidden-section case to assert here.
//
// Fixture hygiene (#868): read-only against the shared seeded admin profile
// (profile 1 owns conditions/allergies/immunizations/providers/… via
// scripts/seed.ts). Presence-only assertions — never exact counts of shared-seed
// rows.

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

// The eleven sections in render order: their jump-link label, the section testid,
// and the section-header heading text.
const SECTIONS = [
  { label: "Conditions", id: "conditions", heading: "Conditions" },
  { label: "Allergies", id: "allergies", heading: "Allergies" },
  { label: "Procedures", id: "procedures", heading: "Procedures" },
  { label: "Immunizations", id: "immunizations", heading: "Immunizations" },
  { label: "Family history", id: "family-history", heading: "Family history" },
  { label: "Visits", id: "visits", heading: "Visits" },
  { label: "Providers", id: "providers", heading: "Providers" },
  { label: "Background", id: "background", heading: "Background" },
  { label: "Care plan", id: "care-plan", heading: "Care plan" },
  { label: "Health goals", id: "health-goals", heading: "Health goals" },
  { label: "Coverage gaps", id: "coverage", heading: "Coverage gaps" },
] as const;

// The removed index routes and the anchor each 308-redirects to. The anchor
// differs from the route name for three: /encounters→#visits, /care-goals→
// #health-goals, /medical/background→#background.
const REDIRECTS = [
  { from: "/conditions", anchor: "conditions" },
  { from: "/allergies", anchor: "allergies" },
  { from: "/procedures", anchor: "procedures" },
  { from: "/immunizations", anchor: "immunizations" },
  { from: "/family-history", anchor: "family-history" },
  { from: "/encounters", anchor: "visits" },
  { from: "/providers", anchor: "providers" },
  { from: "/care-plan", anchor: "care-plan" },
  { from: "/care-goals", anchor: "health-goals" },
  { from: "/coverage", anchor: "coverage" },
  { from: "/medical/background", anchor: "background" },
] as const;

test("renders all eleven anchored sections with the seeded data (#1042)", async ({
  page,
}) => {
  await page.goto("/records");
  await expect(
    page.getByRole("heading", { name: "Health record", exact: true })
  ).toBeVisible();

  const jump = page.getByTestId("records-jump-links");
  for (const s of SECTIONS) {
    // Each section is linked in the sticky jump row …
    await expect(jump.getByRole("link", { name: s.label })).toBeVisible();
    // … and renders with its own section-header heading (scoped to the section so
    // the heading name is unambiguous across the eleven).
    const section = page.getByTestId(`records-${s.id}`);
    await expect(
      section.getByRole("heading", { name: s.heading, exact: true })
    ).toBeVisible();
  }
});

test("the sticky jump links scroll to their sections (#1042)", async ({
  page,
}) => {
  await page.goto("/records");
  // A jump link is a plain in-page hash anchor — a native click sets the hash and
  // scrolls the (far-down) Providers section near the top.
  await page
    .getByTestId("records-jump-links")
    .getByRole("link", { name: "Providers" })
    .click();
  await expect(page).toHaveURL(/#providers$/);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const el = document.getElementById("providers");
        return el ? el.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
      })
    )
    .toBeLessThan(200);
});

test("the eleven removed index routes 308-redirect to their anchored sections (#1042)", async ({
  page,
}) => {
  for (const r of REDIRECTS) {
    await page.goto(r.from);
    await expect(page).toHaveURL(
      new RegExp(`/records#${r.anchor.replace(/[-]/g, "-")}$`)
    );
    await expect(page.getByTestId(`records-${r.anchor}`)).toBeVisible();
  }

  // Query strings ride through the redirect — the Visits Book-CTA deep link
  // (?new=1&title=…) still lands on the merged booking form.
  await page.goto("/encounters?new=1&title=Physical");
  await expect(page).toHaveURL(/\/records\?new=1&title=Physical#visits$/);
  await expect(page.getByTestId("records-visits")).toBeVisible();
});

test("a detail route survives and its back-link points at the merged section (#1042)", async ({
  page,
}) => {
  // Only the INDEX pages folded — the provider detail page keeps its route, and
  // its back-link points at the merged Providers section.
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
  ).toHaveAttribute("href", "/records#providers");

  // The per-vaccine detail page likewise survives with a repointed back-link.
  await page.goto("/immunizations/tdap");
  await expect(
    page.getByRole("link", { name: /Back to immunizations/ }).first()
  ).toHaveAttribute("href", "/records#immunizations");
});

test("the Medical nav group shows one Health record leaf in place of the eleven (#1042)", async ({
  page,
}) => {
  // Being on /records (a Medical child) force-expands the group — the children are
  // asserted with zero interaction flake (the nav-consolidation pattern).
  await page.goto("/records");
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
    "Coverage gaps",
    "Background",
  ]) {
    await expect(nav.getByRole("link", { name: gone })).toHaveCount(0);
  }
});
