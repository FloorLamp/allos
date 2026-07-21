import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { E2E_LOGIN_NAV_MALE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

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
  // Request-level assertion — no per-route Chromium navigation. Each removed index
  // route answers a 308 whose Location IS the anchored /records section (Next's
  // config-level redirect fires before auth, and page.request shares the session
  // context's cookies anyway). The coverage here is the redirect MAP; the rendered
  // target sections are asserted by the "renders all eleven anchored sections"
  // sibling test above.
  for (const r of REDIRECTS) {
    const res = await page.request.get(r.from, { maxRedirects: 0 });
    expect(res.status(), r.from).toBe(308);
    expect(res.headers()["location"], r.from).toBe(`/records#${r.anchor}`);
  }

  // Query strings ride through the redirect — the Visits Book-CTA deep link
  // (?new=1&title=…) keeps its query on the way to the merged booking form.
  const withQuery = await page.request.get("/encounters?new=1&title=Physical", {
    maxRedirects: 0,
  });
  expect(withQuery.status()).toBe(308);
  expect(withQuery.headers()["location"]).toBe(
    "/records?new=1&title=Physical#visits"
  );
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

// ── Specialty sections (#1042 final tail) ────────────────────────────────────
// Vision/Dental/Skin/Mental health fold in AFTER the eleven core sections. Section
// visibility mirrors the nav predicate: Vision/Dental are DATA-GATED (present only
// when the profile has rows — the same computation their former data-gated nav leaves
// used), while Skin/Mental health render UNCONDITIONALLY (their in-page forms are the
// only creation path). The shared seeded profile (profile 1) owns
// optical_prescriptions + dental_procedures + skin_lesions, so all four render for it.

test("the four specialty sections render for the seeded profile, with their forms (#1042)", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records");
  const jump = page.getByTestId("records-jump-links");
  for (const label of ["Vision", "Dental", "Skin", "Mental health"]) {
    await expect(jump.getByRole("link", { name: label })).toBeVisible();
  }
  // Each section renders with its own former-page form testid, proving the moved
  // content component is wired.
  await expect(
    page.getByTestId("records-vision").getByTestId("optical-prescription-form")
  ).toBeVisible();
  await expect(
    page.getByTestId("records-dental").getByTestId("dental-procedure-form")
  ).toBeVisible();
  await expect(
    page.getByTestId("records-skin").getByTestId("skin-lesion-form")
  ).toBeVisible();
  await expect(
    page.getByTestId("records-mental-health").getByTestId("instruments-form")
  ).toBeVisible();
  // Mental health's crisis line travels with the section (the safety contract is
  // content, not route, #1042) — its always-present support link is here.
  await expect(
    page
      .getByTestId("records-mental-health")
      .getByTestId("instrument-crisis-support-link")
  ).toBeVisible();
});

test("Vision/Dental sections hide for a no-data profile; Skin/Mental health still render (#1042)", async ({
  browser,
}) => {
  // The male nav fixture owns no optical/dental rows (e2e/fixture-logins.ts), so the
  // data-gated sections + their jump-links drop while the always-rendered ones stay.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_NAV_MALE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/records");
    await expect(
      page.getByRole("heading", { name: "Health record", exact: true })
    ).toBeVisible();
    const jump = page.getByTestId("records-jump-links");
    // Data-gated: absent (no rows) — both the section and its jump-link.
    await expect(page.getByTestId("records-vision")).toHaveCount(0);
    await expect(page.getByTestId("records-dental")).toHaveCount(0);
    await expect(jump.getByRole("link", { name: "Vision" })).toHaveCount(0);
    await expect(jump.getByRole("link", { name: "Dental" })).toHaveCount(0);
    // Ungated: always render (their forms are the only creation path).
    await expect(page.getByTestId("records-skin")).toBeVisible();
    await expect(page.getByTestId("records-mental-health")).toBeVisible();
    await expect(jump.getByRole("link", { name: "Skin" })).toBeVisible();
    await expect(
      jump.getByRole("link", { name: "Mental health" })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("the four specialty index routes 308-redirect to their anchored sections (#1042)", async ({
  page,
}) => {
  // Request-level assertion — no per-route Chromium navigation (the target sections'
  // render is covered by the "four specialty sections render" sibling test above).
  const redirects = [
    { from: "/vision", anchor: "vision" },
    { from: "/dental", anchor: "dental" },
    { from: "/skin", anchor: "skin" },
    { from: "/medical/instruments", anchor: "mental-health" },
  ];
  for (const r of redirects) {
    const res = await page.request.get(r.from, { maxRedirects: 0 });
    expect(res.status(), r.from).toBe(308);
    expect(res.headers()["location"], r.from).toBe(`/records#${r.anchor}`);
  }
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
