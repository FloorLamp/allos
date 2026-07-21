import { expect, type Locator, type Page } from "@playwright/test";
import { followLink } from "./helpers";

// Shared drivers for the medication/supplement CARD anatomy (#868 class-2 migration:
// "cross-ownership anatomy assertions"). Before this module, every spec that reached a
// medication's list row or its /medications/[id] clinical-record detail hand-rolled the
// SAME locators — `medication-row`, `medication-row-link`, `medication-detail`, the
// shared `refill-days-left` / `refill-run-out` badge (parity with the supplement row,
// #38/#301/#852), the per-item `food-guidance` line (#154) — so every UI rework of the
// medication card broke a fistful of neighbor specs the author never knew pinned it
// (med-card-parity, food-drug-interactions, smoke, medications-ux-r2, medications-
// followups, …). This driver OWNS those selectors; specs call the semantic helpers and
// keep only their own value assertions (badge text, adherence %, guidance copy).
//
// The helpers are PURELY about locating/reading the component — they return Locators (or
// navigate + return the detail Locator). The semantic assertions stay in the specs, the
// same split as e2e/symptom-helpers.ts.
//
// TWO detail-navigation strategies coexist DELIBERATELY, and this module preserves both:
//
//   • openMedDetailViaLink — a blessed followLink (#868/#889) click on the row's Next
//     <Link>. Used where the spec lands on the detail from a light list state and the
//     pre-hydration swallow (#500/#730/#830) is the only hazard (food-drug-interactions,
//     smoke #272).
//   • openMedDetailViaHref — read the row link's href and page.goto() it directly. This
//     is the #852 settle-race fix: on a HEAVY list page a client-side Link transition can
//     be interrupted/reverted (detaching detail-page chips mid-interaction), so a full
//     navigation is deterministic. Used by the specs that first assert the row in place
//     and then open the detail (med-card-parity, medications-ux-r2, medications-followups).
//
// Both assume the caller is already on /medications (the caller controls the initial
// goto, so a spec can assert the row BEFORE opening the detail — med-card-parity's flow).
// Neither asserts the detail is visible: it returns the detail Locator and the spec makes
// that assertion (assertions stay in the specs).

const MED_DETAIL_HREF = /\/medications\/\d+/;

// A medication's scannable row on the /medications list, filtered to its name. Seeded med
// names are unique, so the filter yields exactly one row.
export function medicationRow(page: Page, name: string): Locator {
  return page.getByTestId("medication-row").filter({ hasText: name });
}

// The /medications/[id] clinical-record detail container.
export function medicationDetail(page: Page): Locator {
  return page.getByTestId("medication-detail");
}

// The shared refill badge (RefillBadge, testid `refill-days-left`) — identical on a
// supplement row, a medication row, and the medication detail card (the #747 parity).
// `scope` is the row/detail Locator, or the Page for a page-level lookup (the supplements
// list, where the caller narrows to the leading badge itself).
export function refillBadge(scope: Locator | Page): Locator {
  return scope.getByTestId("refill-days-left");
}

// The projected run-out DATE sub-badge (`refill-run-out`, "runs out ~<date>", #852 item 3),
// nested inside a refill badge / row / detail scope.
export function refillRunOut(scope: Locator | Page): Locator {
  return scope.getByTestId("refill-run-out");
}

// A per-item food–drug guidance line (`food-guidance`, #154) on the detail page, narrowed
// to the distinctive food/advice text (a med may carry several guidance rows).
export function foodGuidance(scope: Locator | Page, text: string): Locator {
  return scope.getByTestId("food-guidance").filter({ hasText: text }).first(); // first-ok: narrowed to the distinctive guidance text
}

// Open a med's detail from its list row via the blessed followLink — the pre-hydration-safe
// Link nav. Assumes the caller is on /medications. Returns the detail Locator (unasserted).
export async function openMedDetailViaLink(
  page: Page,
  name: string
): Promise<Locator> {
  const link = medicationRow(page, name)
    .first() // first-ok: filtered to a unique seeded medication name
    .getByTestId("medication-row-link");
  await followLink(page, link, MED_DETAIL_HREF);
  return medicationDetail(page);
}

// Open a med's detail via a DIRECT goto to the row link's href (the #852 settle-race fix:
// deterministic where a client Link transition on a heavy list can be interrupted). Assumes
// the caller is on /medications. Asserts the href shape (nav plumbing) and returns the
// detail Locator (unasserted).
export async function openMedDetailViaHref(
  page: Page,
  name: string
): Promise<Locator> {
  const rowLink = medicationRow(page, name).getByTestId("medication-row-link");
  await expect(rowLink).toBeVisible();
  const href = await rowLink.getAttribute("href");
  expect(href).toMatch(MED_DETAIL_HREF);
  await page.goto(href!);
  return medicationDetail(page);
}
