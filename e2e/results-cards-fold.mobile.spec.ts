import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_PANELINDEX, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Results › Biomarkers on a phone: how the cards around the panel index behave at
// 390×844 (issues #1578 and #1647). Mobile project because the whole claim is about
// phone height. #1499 collapsed the tab from 13.4k px to 2.8k px; #1578 capped the
// two tallest cards and the first panel header still sat 1,913 px down — 2.3
// viewports — because those two cards are 579 px and 435 px even capped, so they
// exceed an 844 px screen between them. #1647 answers that by re-ordering the phone
// stack instead of shrinking it further: the trajectory warning keeps its place above
// the index and folds its rows there, and the two glance cards move BELOW the index,
// whole. Every slot's order resets at `sm`, so desktop is unchanged.
//
// GEOMETRY, NOT PIXELS. The assertions are relational — what is laid out versus what
// is not, which block sits above which, whether folding moves the index — with ONE
// absolute: the first panel header must sit inside the first viewport height, because
// that is the thing #1578 asked for in those words and #1647 delivered. No card height
// is pinned; the design may change what a tile weighs and this spec should not care.
//
// FIXTURE OWNERSHIP (#868). `e2e_panelindex` owns its whole profile: six starred
// analytes (past the phone tile cap, so the fold is exercised rather than skipped)
// and one complete nine-analyte PhenoAge draw, so the bio-age blocks render their
// full variants. Read-only — only client-side disclosure is driven — so it is
// repeat-safe with no reset.
//
// #2367 SPLIT the bio-age hero off this page: what sits in the glance slot here is
// now the INPUT PANEL (which does not fold — nine checklist rows below the index cost
// the first screen nothing), and the tall per-input hero moved to Longevity, where
// its fold still has to hold. The hero's fold test therefore travels to /longevity
// inside this file rather than into a new spec of its own.

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
  const header = page.getByTestId("biomarker-panel-header").first(); // first-ok: the spec-owned e2e_panelindex profile — "where the index starts" IS the first header
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

// Top of an element in document coordinates.
function topOf(el: Locator): Promise<number> {
  return el.evaluate(
    (n) => (n as HTMLElement).getBoundingClientRect().top + window.scrollY
  );
}

// THE ACCEPTANCE TEST for #1647, and the one place this spec pins an absolute number
// — because "the first panel header is inside the first screen" is not expressible
// any other way. Everything else here stays relational.
test("the panel index leads on a phone, inside the first viewport (#1647)", async ({
  browser,
}) => {
  const page = await openPhone(browser);

  // This profile is the case the issues measured, not one that dodges it by having
  // nothing around the list: both capped cards render, and so does the warning.
  await expect(page.getByTestId("starred-biomarkers")).toBeVisible();
  await expect(page.getByTestId("bio-age-inputs-card")).toBeVisible();
  await expect(page.getByTestId("trajectory-findings")).toBeVisible();

  const header = await firstHeaderTop(page);
  expect(header).toBeLessThan(PHONE.height);

  // And it leads because the two glance cards are BELOW it — not because they were
  // hidden. Both are still fully laid out, one scroll away.
  expect(await topOf(page.getByTestId("starred-biomarkers"))).toBeGreaterThan(
    header
  );
  expect(
    await topOf(page.getByTestId("bio-age-inputs-card"))
  ).toBeGreaterThan(header);

  // The warning is the one card that keeps its place above the index.
  expect(await topOf(page.getByTestId("trajectory-findings"))).toBeLessThan(
    header
  );

  // The filter bar travels WITH the table across the re-order: a control that
  // narrows a list has to stay attached to the list it narrows.
  const filters = await topOf(page.getByTestId("medical-filters"));
  expect(filters).toBeLessThan(header);
  expect(filters).toBeGreaterThan(
    await topOf(page.getByTestId("trajectory-findings"))
  );

  // The add CTA travels with the index instead of being buried after every card.
  const add = await topOf(page.getByTestId("add-result-panel"));
  expect(add).toBeGreaterThan(
    await topOf(page.getByTestId("trajectory-findings"))
  );
  expect(add).toBeLessThan(header);
  expect(add).toBeLessThan(await topOf(page.getByTestId("bio-age-inputs-card")));

  await page.context().close();
});

test("the trajectory watch keeps its headline above the index and folds its rows (#1647)", async ({
  browser,
}) => {
  const page = await openPhone(browser);
  const card = page.getByTestId("trajectory-findings");

  // The signal survives the fold: the card is still there, still says how many
  // analytes are trending and names them. Only the per-analyte detail folds.
  await expect(card.getByRole("heading")).toContainText("Trajectory watch");
  await expect(card).toContainText("trending before a single reading");
  await expect(
    card.getByTestId("trajectory-rollup").first() // first-ok: spec-owned profile; any one folded row proves the list is not laid out
  ).toBeHidden();

  const toggle = page.getByTestId("trajectory-rows-fold-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The label says how much is behind the tap, so it answers "is this worth one?".
  await expect(toggle).toHaveText(/^Show \d+ trending analytes?$/);

  // Relational, the way #1646's assertion was: unfolding the rows pushes the index
  // back down, so the fold is what buys the index its place on the first screen.
  const folded = await firstHeaderTop(page);
  await hydratedClick(page, toggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByTestId("trajectory-rollup").first()).toBeVisible(); // first-ok: same spec-owned row
  const unfolded = await firstHeaderTop(page);
  expect(unfolded - folded).toBeGreaterThan(100);

  // And it folds back.
  await hydratedClick(page, toggle);
  await expect(card.getByTestId("trajectory-rollup").first()).toBeHidden(); // first-ok: same spec-owned row

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

test("the bio-age panel here is the INPUT list, not the hero (#2367)", async ({
  browser,
}) => {
  const page = await openPhone(browser);
  const card = page.getByTestId("bio-age-inputs-card");

  // The headline block is not on this page at all — that is the whole point of the
  // split, and it is what the phone stack no longer has to carry.
  await expect(page.getByTestId("bio-age-hero")).toHaveCount(0);
  await expect(page.getByTestId("bio-age-value")).toHaveCount(0);

  // What is here is the catalog question and its answer, laid out whole: nine rows,
  // no fold, because below the index its height costs the first screen nothing.
  await expect(card.getByTestId("bio-age-input")).toHaveCount(9);
  for (const input of await card.getByTestId("bio-age-input").all())
    await expect(input).toBeVisible();
  await expect(page.getByTestId("bio-age-inputs-fold-toggle")).toHaveCount(0);
  await expect(card.getByTestId("bio-age-hero-link")).toBeVisible();

  await page.context().close();
});

test("the bio-age hero folds its inputs but never its estimate caveat (#1578)", async ({
  browser,
}) => {
  // The hero's home since #2367 — same fold, same rule, one page over.
  const page = await openPhone(browser);
  await page.goto("/longevity");
  const hero = page.getByTestId("bio-age-hero");

  // The answer stays: the number, the delta, the pace.
  await expect(hero.getByTestId("bio-age-value")).toBeVisible();
  await expect(hero.getByTestId("bio-age-delta")).toBeVisible();
  await expect(hero.getByTestId("bio-age-pace")).toBeVisible();
  // And so does the caveat — it qualifies the number itself, so it travels with it at
  // every width and is never behind a tap.
  await expect(hero.getByTestId("bio-age-estimate")).toBeVisible();

  // The per-input list is what folds: present in the DOM, not laid out. Ten rows now
  // — the nine analytes plus chronological age (#2366).
  await expect(hero.getByTestId("bio-age-input")).toHaveCount(10);
  await expect(
    hero.getByTestId("bio-age-input").first() // first-ok: spec-owned profile; any one folded input proves the list is not laid out
  ).toBeHidden();

  const toggle = page.getByTestId("bio-age-inputs-fold-toggle");
  await expect(toggle).toHaveText("Show what moves it (10 inputs)");
  await hydratedClick(page, toggle);
  for (const input of await hero.getByTestId("bio-age-input").all())
    await expect(input).toBeVisible();

  await page.context().close();
});

test("desktop renders every card whole, above the index, with no fold controls (#1578/#1647)", async ({
  browser,
}) => {
  const page = await openPhone(browser);
  await page.setViewportSize({ width: 1280, height: 900 });

  // From `sm` up the folded slots are `display: contents`, so their children are laid
  // out by the parent exactly as before this change — one grid of six starred tiles,
  // one nine-item input list, the trajectory rows inline — and the toggles are gone
  // because nothing is folded.
  await expect(page.getByTestId("starred-fold-toggle")).toBeHidden();
  await expect(page.getByTestId("trajectory-rows-fold-toggle")).toBeHidden();
  await expect(
    page.getByTestId("trajectory-rollup").first() // first-ok: spec-owned profile; any one row proves the list is inline again
  ).toBeVisible();

  // Every stack slot resets its order at `sm`, so the page renders in DOM order —
  // the unchanged #1499 section D order, glance first and index below it.
  const header = await firstHeaderTop(page);
  for (const id of [
    "starred-biomarkers",
    "trajectory-findings",
    "bio-age-inputs-card",
  ])
    expect(await topOf(page.getByTestId(id))).toBeLessThan(header);
  expect(await topOf(page.getByTestId("starred-biomarkers"))).toBeLessThan(
    await topOf(page.getByTestId("trajectory-findings"))
  );
  expect(await topOf(page.getByTestId("trajectory-findings"))).toBeLessThan(
    await topOf(page.getByTestId("bio-age-inputs-card"))
  );

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

  const card = page.getByTestId("bio-age-inputs-card");
  await expect(card.getByTestId("bio-age-input")).toHaveCount(9);
  for (const input of await card.getByTestId("bio-age-input").all())
    await expect(input).toBeVisible();

  await page.context().close();
});
