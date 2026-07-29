import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_PANELINDEX, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Results › Biomarkers, the two cards ABOVE the index (issue #1578). Mobile project
// (390×844) because the whole claim is about phone height: #1499 collapsed the tab
// from 13.4k px to 2.8k px, but the first panel header still sat 2.5k px down, and
// the two cards the design deliberately keeps above the list accounted for 1,487 px
// of it — the starred card renders one uncapped tile per star (a reader with many
// stars grows it without limit), and the hero always lists nine inputs.
//
// GEOMETRY, NOT PIXELS. The assertions are relational: what is laid out versus what
// is not, and whether folding actually moves the index up. No absolute card height is
// pinned — the design may change what a tile weighs, and this spec should not care.
//
// FIXTURE OWNERSHIP (#868). `e2e_panelindex` owns its whole profile: six starred
// analytes (past the phone tile cap, so the fold is exercised rather than skipped)
// and one complete nine-analyte PhenoAge draw, so the hero renders its tall headline
// variant rather than the checklist CTA. Read-only — only client-side disclosure is
// driven — so it is repeat-safe with no reset.

const BIOMARKERS = "/results/biomarkers";
const PHONE = { width: 390, height: 844 };

async function openPhone(browser: Parameters<typeof loginAs>[0]) {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PANELINDEX,
    password: E2E_MEMBER_PASSWORD,
  });
  // loginAs opens a raw context, which does not inherit the `mobile` project's
  // viewport — pin it so the assertions are about the phone layout.
  await page.setViewportSize(PHONE);
  await page.goto(BIOMARKERS);
  return page;
}

// Where the index starts, in document coordinates (independent of scroll position).
async function firstHeaderTop(page: Page): Promise<number> {
  const header = page.getByTestId("biomarker-panel-header").first();
  await expect(header).toBeVisible();
  return header.evaluate(
    (el) => (el as HTMLElement).getBoundingClientRect().top + window.scrollY
  );
}

function tile(page: Page, n: number): Locator {
  return page
    .getByTestId("starred-biomarkers")
    .getByTestId("starred-tile")
    .nth(n);
}

test("folding the two cards lifts the panel index up the page (#1578)", async ({
  browser,
}) => {
  const page = await openPhone(browser);

  // Both capped cards are present — this profile is the case the issue measured, not
  // one that dodges it by having nothing above the list.
  await expect(page.getByTestId("starred-biomarkers")).toBeVisible();
  await expect(page.getByTestId("bio-age-hero")).toBeVisible();
  await expect(page.getByTestId("bio-age-value")).toBeVisible();

  const folded = await firstHeaderTop(page);

  // Open both folds: the page now renders what it rendered BEFORE this change — six
  // starred tiles and the nine-input list — so the difference is exactly what the
  // caps buy.
  await hydratedClick(page, page.getByTestId("starred-fold-toggle"));
  await hydratedClick(page, page.getByTestId("bio-age-inputs-fold-toggle"));
  await expect(tile(page, 5)).toBeVisible();
  const unfolded = await firstHeaderTop(page);

  expect(unfolded).toBeGreaterThan(folded);
  // Worth having: the caps are not a rounding error on a 844px screen.
  expect(unfolded - folded).toBeGreaterThan(200);

  await page.context().close();
});

test("the starred card folds its overflow tiles on a phone (#1578)", async ({
  browser,
}) => {
  const page = await openPhone(browser);
  const card = page.getByTestId("starred-biomarkers");

  // Six stars, three shown. The heading still counts all six, so the fold hides tiles
  // rather than pretending the reader starred fewer analytes.
  await expect(card.getByRole("heading")).toContainText("(6)");
  await expect(card.getByTestId("starred-tile")).toHaveCount(6);
  await expect(tile(page, 2)).toBeVisible();
  await expect(tile(page, 3)).toBeHidden();

  const toggle = page.getByTestId("starred-fold-toggle");
  await expect(toggle).toHaveText("Show all 6 starred");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await hydratedClick(page, toggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Show fewer");
  // The revealed tiles are the SAME authored elements, laid out in the SAME grid —
  // there is no phone-only second tile tree.
  for (const t of await card.getByTestId("starred-tile").all())
    await expect(t).toBeVisible();

  // And it folds back.
  await hydratedClick(page, toggle);
  await expect(tile(page, 3)).toBeHidden();

  await page.context().close();
});

test("the bio-age hero folds its inputs but never its estimate caveat (#1578)", async ({
  browser,
}) => {
  const page = await openPhone(browser);
  const hero = page.getByTestId("bio-age-hero");

  // The answer stays: the number, the delta, the pace.
  await expect(hero.getByTestId("bio-age-value")).toBeVisible();
  await expect(hero.getByTestId("bio-age-delta")).toBeVisible();
  await expect(hero.getByTestId("bio-age-pace")).toBeVisible();
  // And so does the caveat — it qualifies the number itself, so it travels with it at
  // every width and is never behind a tap.
  await expect(hero.getByTestId("bio-age-estimate")).toBeVisible();

  // The nine-input provenance list is what folds: present in the DOM, not laid out.
  await expect(hero.getByTestId("bio-age-input")).toHaveCount(9);
  await expect(hero.getByTestId("bio-age-input").first()).toBeHidden();

  const toggle = page.getByTestId("bio-age-inputs-fold-toggle");
  await expect(toggle).toHaveText("Show the 9 inputs");
  await hydratedClick(page, toggle);
  for (const input of await hero.getByTestId("bio-age-input").all())
    await expect(input).toBeVisible();

  await page.context().close();
});

test("desktop renders both cards whole, with no fold controls (#1578)", async ({
  browser,
}) => {
  const page = await openPhone(browser);
  await page.setViewportSize({ width: 1280, height: 900 });

  // From `sm` up the folded slots are `display: contents`, so their children are laid
  // out by the parent exactly as before this change — one grid of six starred tiles,
  // one nine-item input list — and the toggles are gone because nothing is folded.
  await expect(page.getByTestId("starred-fold-toggle")).toBeHidden();
  await expect(page.getByTestId("bio-age-inputs-fold-toggle")).toBeHidden();

  const card = page.getByTestId("starred-biomarkers");
  for (const t of await card.getByTestId("starred-tile").all())
    await expect(t).toBeVisible();

  // The tiles still share ONE grid: all six sit in the same three columns, so the
  // fold wrapper contributed no row of its own.
  const lefts = await card
    .getByTestId("starred-tile")
    .evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().left))
    );
  expect(new Set(lefts).size).toBe(3);

  const hero = page.getByTestId("bio-age-hero");
  await expect(hero.getByTestId("bio-age-input")).toHaveCount(9);
  for (const input of await hero.getByTestId("bio-age-input").all())
    await expect(input).toBeVisible();

  await page.context().close();
});
