import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import {
  expectNoClippedContent,
  hydratedClick,
  settledCheck,
  settledSelect,
} from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_PANELGROUPS,
  E2E_LOGIN_PANELINDEX,
  E2E_MEMBER_PASSWORD,
  PANEL_GROUPS_OTHER_ANALYTE,
} from "./fixture-logins";

// Results › Biomarkers becomes an INDEX (issue #1499). Mobile project (390×844)
// because the feature is a page-height fix measured at phone width: this was the
// tallest page in the app (13.4k px, first reading card 4.8k px down), and the
// collapse is what makes it browsable with a thumb. The grouping itself is NOT
// viewport-conditional — one `<tr>` per group header serves both the desktop table
// and the card stack — and the desktop specs (#1482/#1502) still cover that side.
//
// FIXTURE OWNERSHIP (#868). The headers publish COUNTS, and a count is the one thing
// that must never be asserted against the shared seed. Everything here runs as
// `e2e_panelgroups`, whose whole lab history is the fourteen readings e2e/seed/medical.ts
// gives it: Lipids (5 analytes, LDL currently high), Thyroid (2, none flagged) and one
// un-canonicalized reading in "Other". Read-only — only the client-side disclosure is
// driven — so it is repeat-safe with no reset.

const BIOMARKERS = "/results/biomarkers";

async function openBrowser(
  browser: Parameters<typeof loginAs>[0],
  url: string = BIOMARKERS
) {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PANELGROUPS,
    password: E2E_MEMBER_PASSWORD,
  });
  // loginAs opens a raw context, which does not inherit the `mobile` project's
  // viewport — pin it so the assertions are about the phone layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  return page;
}

function group(page: Page, panel: string) {
  return page.locator(
    `[data-testid="biomarker-panel-group"][data-panel="${panel}"]`
  );
}

test("the master list arrives as collapsed panel groups, in clinical order (#1499)", async ({
  browser,
}) => {
  const page = await openBrowser(browser);

  const table = page.getByTestId("biomarkers-table");
  await expect(table).toBeVisible();

  // Every panel this profile has readings in is present as ONE header, in
  // PANEL_LABELS order with the reserved `other` bucket last — nothing dropped.
  await expect(page.getByTestId("biomarker-panel-header")).toHaveCount(3);
  const panels = await page
    .getByTestId("biomarker-panel-group")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-panel")));
  expect(panels).toEqual(["lipids", "thyroid", "other"]);

  // Each header states its analyte count, and the flagged group says so. These are
  // exact because the profile is spec-owned.
  const lipids = group(page, "lipids");
  await expect(lipids.getByTestId("biomarker-panel-toggle")).toHaveAttribute(
    "aria-label",
    "Lipids · 5 analytes · 1 flagged"
  );
  // The Triglycerides pair is the proof: a historical high whose CURRENT reading is
  // normal is NOT a flag — only the still-high LDL counts.
  await expect(lipids.getByTestId("biomarker-panel-flagged")).toHaveText(
    "1 flagged"
  );

  // The unflagged group carries no flag badge — the two self-identify apart.
  const thyroid = group(page, "thyroid");
  await expect(thyroid.getByTestId("biomarker-panel-toggle")).toHaveAttribute(
    "aria-label",
    "Thyroid · 2 analytes"
  );
  await expect(thyroid.getByTestId("biomarker-panel-flagged")).toHaveCount(0);

  // Collapsed means COLLAPSED: no reading rows in the DOM at all — the height IS
  // the DOM, which is the whole point of the change.
  await expect(table.locator('td[data-card="title"]')).toHaveCount(0);
  await expect(lipids).toHaveAttribute("data-open", "false");

  // And the index fits a phone without a sideways escape hatch.
  await expectNoClippedContent(page);

  await page.context().close();
});

test("tapping a group expands its readings, and only that group (#1499)", async ({
  browser,
}) => {
  const page = await openBrowser(browser);
  const lipids = group(page, "lipids");
  const thyroid = group(page, "thyroid");
  await expect(lipids).toBeVisible();

  await hydratedClick(page, lipids.getByTestId("biomarker-panel-toggle"));

  await expect(lipids).toHaveAttribute("data-open", "true");
  await expect(
    lipids.getByRole("link", { name: "LDL Cholesterol", exact: true })
  ).not.toHaveCount(0);
  // The count the header published is the number of DISTINCT analytes the expansion
  // draws — one computation, two renderings. (Rows, not analytes, are what the
  // expansion lists: LDL has three readings and Triglycerides two.)
  const names = await lipids
    .locator('td[data-card="title"]')
    .evaluateAll((els) => [
      ...new Set(els.map((e) => (e.textContent ?? "").trim())),
    ]);
  expect(names.sort()).toEqual([
    "LDL Cholesterol",
    "Lipoprotein(a)",
    "Total Cholesterol",
    "Triglycerides",
    "VLDL Cholesterol",
  ]);
  await expect(lipids.locator("tr")).toHaveCount(12); // 1 header + 11 readings

  // Its neighbour stayed shut: expansion is per group, not a page-wide "show all".
  await expect(thyroid).toHaveAttribute("data-open", "false");
  await expect(thyroid.locator('td[data-card="title"]')).toHaveCount(0);

  // Tapping again puts it back.
  await hydratedClick(page, lipids.getByTestId("biomarker-panel-toggle"));
  await expect(lipids).toHaveAttribute("data-open", "false");

  await page.context().close();
});

test("search expands the groups it matched, so a hit is never hidden (#1499)", async ({
  browser,
}) => {
  const page = await openBrowser(browser);

  // An analyte that lives INSIDE a group which is collapsed by default. A search
  // that left it folded would read as no-results — the failure mode the rule exists
  // to prevent.
  await page.goto(`${BIOMARKERS}?q=Free+T4`);
  const thyroid = group(page, "thyroid");
  await expect(thyroid).toHaveAttribute("data-open", "true");
  await expect(
    thyroid.getByRole("link", { name: "Free T4", exact: true })
  ).toBeVisible();

  // The `?panel=` facet (#1502) composes the same way: naming one group opens it.
  await page.goto(`${BIOMARKERS}?panel=lipids`);
  const lipids = group(page, "lipids");
  await expect(lipids).toHaveAttribute("data-open", "true");
  await expect(group(page, "thyroid")).toHaveCount(0);

  await page.context().close();
});

test("an un-canonicalized reading lands in Other rather than being dropped (#1499)", async ({
  browser,
}) => {
  const page = await openBrowser(browser);
  const other = group(page, "other");

  await expect(other.getByTestId("biomarker-panel-toggle")).toHaveAttribute(
    "aria-label",
    "Other · 1 analyte"
  );
  await hydratedClick(page, other.getByTestId("biomarker-panel-toggle"));
  await expect(other.getByText(PANEL_GROUPS_OTHER_ANALYTE)).toBeVisible();

  await page.context().close();
});

test("the add-a-reading form is behind '+ Add result', and deep links auto-expand (#1499)", async ({
  browser,
}) => {
  const page = await openBrowser(browser);

  // No standing form: the panel is collapsed, so its fields are out of the page.
  const panel = page.getByTestId("add-result-panel");
  await expect(panel).toHaveAttribute("data-open", "false");
  await expect(panel.getByLabel("Name", { exact: true })).toBeHidden();

  await hydratedClick(page, page.getByTestId("add-result-panel-toggle"));
  await expect(panel).toHaveAttribute("data-open", "true");
  await expect(panel.getByLabel("Name", { exact: true })).toBeVisible();

  // The palette / medication-monitoring "Add result" deep link says it came to add
  // something, so it arrives open and prefilled.
  await page.goto(`${BIOMARKERS}?new=1&name=Ferritin#add-result`);
  await expect(page.getByTestId("add-result-panel")).toHaveAttribute(
    "data-open",
    "true"
  );
  await expect(
    page.locator("#add-result").getByLabel("Name", { exact: true })
  ).toHaveValue("Ferritin");

  await page.context().close();
});

// ── The index is the WHOLE set, not a page (#1581) ────────────────────────────
// Runs as `e2e_panelindex`, whose lab history is eighty-one readings across seven
// panels — more than the retired 50-row page held, and deliberately so: under the
// page a name-sorted slice stopped partway through the alphabet and the panels
// after it had no header at all.

async function openIndex(
  browser: Parameters<typeof loginAs>[0],
  url: string = BIOMARKERS
) {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PANELINDEX,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  return page;
}

// `table-sort-select` is the shared card-mode control; scope it to this tab's own
// section so the locator names one element rather than "whichever came first".
function sortSelect(page: Page) {
  return page
    .getByTestId("results-biomarkers")
    .getByTestId("table-sort-select");
}

// Clinical order, `other` last. Seven panels come from stored readings; `lipids`,
// `glycemic` and `kidney` also absorb derived indices, and `biological-age` exists
// ONLY because the derived PhenoAge row lands there.
const INDEX_PANELS = [
  "lipids",
  "glycemic",
  "inflammation",
  "kidney",
  "liver",
  "cbc",
  "thyroid",
  "biological-age",
];

test("the index lists every panel in the data, with no pager (#1581 section A)", async ({
  browser,
}) => {
  const page = await openIndex(browser);
  await expect(page.getByTestId("biomarkers-table")).toBeVisible();

  const panels = await page
    .getByTestId("biomarker-panel-group")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-panel")));
  expect(panels).toEqual(INDEX_PANELS);

  // The row cap this replaces existed to bound an UNBOUNDED reading list; the
  // collapsed index is bounded by the closed panel taxonomy instead, so there is
  // nothing left to page and no pager to scroll away from.
  await expect(page.getByTestId("biomarkers-pagination")).toHaveCount(0);
  await expect(page.getByText(/Showing \d+–\d+ of \d+/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Next" })).toHaveCount(0);

  // A whole panel's count, not the sliver of it that fit on a page: five stored lipid
  // analytes plus the two derived lipid ratios, and three of the seven currently out
  // of range (total cholesterol, LDL, and the derived Non-HDL they imply).
  await expect(
    group(page, "lipids").getByTestId("biomarker-panel-toggle")
  ).toHaveAttribute("aria-label", "Lipids · 7 analytes · 3 flagged");
  // Twenty-seven stored analytes across seven panels, three draws each — eighty-one
  // rows plus the derived indices, all of it shipped at once.
  await expect(
    group(page, "cbc").getByTestId("biomarker-panel-toggle")
  ).toHaveAttribute("aria-label", "Complete blood count · 7 analytes");

  await page.context().close();
});

test("no filter change leaves a group the reader opened collapsed (#1581 section A)", async ({
  browser,
}) => {
  const page = await openIndex(browser);
  const thyroid = group(page, "thyroid");
  await expect(thyroid).toHaveAttribute("data-open", "false");

  await hydratedClick(page, thyroid.getByTestId("biomarker-panel-toggle"));
  await expect(thyroid).toHaveAttribute("data-open", "true");

  // Every control in the filter bar narrows, and a narrowed view opens its groups —
  // so the reader's expansion is never yanked shut by reaching for a filter. "Current
  // values only" was the last one that did not count as a narrowing, which is why it
  // is the one driven here.
  await settledCheck(page, page.getByLabel("Current values only"), true);
  await expect(page).toHaveURL(/current=1/);
  await expect(group(page, "thyroid")).toHaveAttribute("data-open", "true");
  await expect(group(page, "lipids")).toHaveAttribute("data-open", "true");

  // Sorting re-derives the initial disclosure state — it is a different ordering of
  // the same set, and the collapse is the default view. What it must NOT do is what
  // the pager did: reset the reader mid-list on a navigation that showed them the
  // same rows they were already reading. There is no such navigation left.
  await settledSelect(page, sortSelect(page), "date:desc", {
    destination: /sort=date/,
  });
  await expect(page.getByTestId("biomarkers-pagination")).toHaveCount(0);

  await page.context().close();
});

test("sorts by name ascending by default, and an old ?sort=panel falls back to it (#1581 section B)", async ({
  browser,
}) => {
  const page = await openIndex(browser);
  const select = sortSelect(page);
  await expect(select).toHaveValue("name:asc");
  // `panel` is not offered at all — grouping already emits the panels in clinical
  // order, so the control did nothing a reader could perceive.
  const options = await select
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(options.some((v) => v.startsWith("panel:"))).toBe(false);

  // An old bookmark parses to the default rather than failing.
  const stale = await openIndex(browser, `${BIOMARKERS}?sort=panel`);
  await expect(sortSelect(stale)).toHaveValue("name:asc");
  await stale.context().close();

  // Within an expanded group, one analyte's readings run newest-first.
  await hydratedClick(
    page,
    group(page, "thyroid").getByTestId("biomarker-panel-toggle")
  );
  const dates = await group(page, "thyroid")
    .locator('td[data-card="meta"]')
    .filter({ hasText: /\d{4}-\d{2}-\d{2}/ })
    .evaluateAll((els) =>
      els.map(
        (e) => ((e.textContent ?? "").match(/\d{4}-\d{2}-\d{2}/) ?? [""])[0]
      )
    );
  const freeT4 = dates.slice(0, 3);
  expect(freeT4).toEqual([...freeT4].sort().reverse());

  await page.context().close();
});

test("the panel facet offers only panels this browser can return (#1581 section D)", async ({
  browser,
}) => {
  const page = await openIndex(browser);
  const facet = page.getByTestId("panel-filter");
  const labels = await facet
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));

  // Gone: their analytes carry a category this browser excludes, so choosing one
  // could only ever say "No records match these filters".
  //   Mental health screens → `instrument`, and #1076's exclusion is a SENSITIVITY
  //   decision — offering the facet advertised data the browser refuses to show.
  //   Blood type → `reference`, which lives in the passport.
  expect(labels).not.toContain("Mental health screens");
  expect(labels).not.toContain("Blood type");

  // Kept: PhenoAge still renders here as a derived row, so the panel is reachable.
  expect(labels).toContain("Biological age");
  // Kept: #1076 left these browsable on purpose — they have no other home.
  for (const label of ["Vital signs", "Vision", "Hearing", "Dental", "Other"])
    expect(labels).toContain(label);

  // And the kept one actually returns its row.
  await page.goto(`${BIOMARKERS}?panel=biological-age`);
  const bioAge = group(page, "biological-age");
  await expect(bioAge).toHaveAttribute("data-open", "true");
  await expect(
    bioAge.getByTestId("derived-badge").first() // first-ok: spec-owned e2e_panelindex; the group holds only PhenoAge rows
  ).toBeVisible();

  await page.context().close();
});
