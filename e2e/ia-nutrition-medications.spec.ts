import { test, expect } from "./fixtures";
import { closeEditor, openFact } from "./intake-form-helpers";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { followLink } from "./helpers";
import { medicationList, medicationRow } from "./med-card-helpers";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";

// IA split (#746): supplements folded into the Nutrition umbrella, medications became
// a standalone Medical-group page. (The retired combined intake route was removed
// outright in #1635 and 404s.) The umbrella's tabs read Day | Manage since #3987 —
// date-shaped on one, configuration-shaped on the other. This spec proves all three
// surfaces:
//   1. Nutrition is a URL-driven Day | Manage umbrella
//   2. /medications renders the medication cards + add form
//   3. an INFANT profile (Food-logging gated off) can still reach Manage — infant
//      supplements are real (vitamin D drops) — while the Day tab shows the calm
//      note and the food-preferences card drops out on the same life-stage gate.

function dbPath(): string {
  return workerDbPath();
}

test("Nutrition is a Day | Manage tab umbrella (#746/#3987)", async ({
  page,
}) => {
  // Default tab is Day — the one ledger, and the serving logger under it.
  await page.goto("/nutrition");
  await expect(
    page.getByText(
      "Log food groups, review your week, and manage supplements.",
      { exact: true }
    )
  ).toHaveCount(0);
  // DAY | MANAGE (#3987 phase 2). The words are the tabs' — the `?tab=` values stay
  // `food`/`supplements`, which is the deep-link vocabulary the rest of the app spells.
  await expect(page.getByRole("tab", { name: "Day" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Manage" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Supplements" })).toHaveCount(0);
  await expect(page.getByTestId("nutrition-workspace-card")).toHaveCount(0);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Switch to Manage — the stack renders and the URL is deep-linkable. The tab is a
  // NavTabs Next <Link>, so followLink rides out the pre-hydration swallow (#889).
  await followLink(
    page,
    page.getByRole("tab", { name: "Manage" }),
    /tab=supplements/
  );
  await expect(page.getByTestId("situations-bar")).toHaveCount(0);
  // THE DAY LEFT THIS TAB (#3987). The taken counter, the day switcher and the slot
  // filter went with the daily schedule; what stays is the stack you manage.
  await expect(page.getByTestId("supplements-status")).toHaveCount(0);
  await expect(page.getByTestId("supplement-stack")).toBeVisible();
  await expect(page.getByTestId("food-log-bar")).toHaveCount(0);
  await expect(page.getByTestId("supplement-workspace")).toBeVisible();
  await expect(page.getByTestId("supplement-sidebar-surface")).toBeVisible();
  const weeklyAdherence = page.getByTestId("supplement-weekly-adherence");
  await expect(weeklyAdherence).toBeVisible();
  await expect(
    weeklyAdherence.getByRole("heading", { name: "This week" })
  ).toHaveClass(/\bsection-label\b/);
  await expect(
    weeklyAdherence.getByTestId("supplement-weekly-adherence-value")
  ).toHaveText(/^(?:\d{1,3}%|—)$/);
  const weeklyDays = weeklyAdherence.getByTestId(
    "supplement-weekly-adherence-day"
  );
  const weeklyDayCount = await weeklyDays.count();
  expect(weeklyDayCount).toBeGreaterThan(0);
  expect(weeklyDayCount).toBeLessThanOrEqual(7);
  expect(
    new Set(
      await weeklyAdherence
        .getByTestId("supplement-weekly-adherence-weekday")
        .allTextContents()
    )
  ).toEqual(new Set(["Su", "M", "Tu", "W", "Th", "F", "Sa"]));
  const weeklyDayBoxes = await weeklyDays.evaluateAll((cells) =>
    cells.map((cell) => {
      const box = cell.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })
  );
  expect(weeklyDayBoxes.every((box) => box.width <= 40)).toBe(true);
  expect(weeklyDayBoxes.every((box) => box.height <= 40)).toBe(true);
  await expect(weeklyDays.last()).toHaveAttribute(
    "data-state",
    /^(?:taken|partial|skipped|missed|na|pending)$/
  );
  const weeklyLegend = weeklyAdherence.getByTestId(
    "supplement-weekly-adherence-legend"
  );
  await expect(weeklyLegend).toBeVisible();
  expect(await weeklyLegend.getByRole("listitem").count()).toBeGreaterThan(0);
  const insightsHeading = page.getByRole("heading", { name: "Insights" });
  await expect(insightsHeading).toHaveClass(/\bsection-label\b/);
  const weeklyBox = await weeklyAdherence.boundingBox();
  const insightsBox = await insightsHeading.boundingBox();
  expect(weeklyBox).not.toBeNull();
  expect(insightsBox).not.toBeNull();
  expect(weeklyBox!.y).toBeLessThan(insightsBox!.y);
  const mustRow = page
    .getByTestId("supplement-row")
    .filter({ hasText: "Evening Vitamin C (e2e)" });
  // The seeded item is a `must` (#1505 renamed the band); the badge renders for any
  // obligation other than the `should` default.
  await expect(mustRow.getByTestId("intake-obligation-must")).toHaveText(
    "Must"
  );
  await expect(mustRow.getByTestId("adherence-summary")).toBeVisible();
  // A MANAGEMENT ROW STATES ITS OWN SCHEDULE (#3987 phase 2). The bucket heading that
  // used to say it for the row went with the daily schedule in phase 1, so a stack
  // that could not say when anything is taken would be a silent capability loss.
  await expect(mustRow.getByTestId("supplement-row-schedule")).toHaveText(
    "Evening"
  );
  // NO DAY CONTROL ON A MANAGEMENT ROW (#3987): resolving today's dose is the Day
  // ledger's, and this row is what the item IS. The row action that remains is the
  // ⋯ menu, and it still sits to the right of the name.
  await expect(mustRow.getByTestId("dose-status")).toHaveCount(0);
  const supplementNameBox = await mustRow
    .getByTestId("intake-item-name")
    .boundingBox();
  const supplementActionBox = await mustRow
    .getByRole("button", { name: /^Supplement actions for/ })
    .boundingBox();
  expect(supplementNameBox).not.toBeNull();
  expect(supplementActionBox).not.toBeNull();
  expect(supplementActionBox!.x).toBeGreaterThan(supplementNameBox!.x);

  // Creation is secondary to today's doses: a compact action opens the short
  // name/dose/time path in a modal, with advanced metadata behind a disclosure.
  const addCard = page.getByTestId("add-supplement-card");
  const addButton = addCard.getByTestId("supplement-add-toggle");
  // THE ADD ACTION IS THE PRIMITIVE'S PRIMARY (#3987/#3982): the typed Button's
  // primary variant, not a hand-rolled `btn btn-sm`, so the paint, the box and the
  // focus ring are the primitive's.
  await expect(addButton).toHaveAttribute("data-button-control", "");
  await expect(addButton).toHaveClass(/\bbutton-control-primary\b/);

  // THE ADMISSION RULE, ON THE UNIT THE OWNER RULED (#4978, 2026-09-04 13:05 UTC):
  // the surface is the FORM, not the route — every form commit is primary, one per
  // form. This route paints TWO primaries and both are correct: the add toggle
  // above, which belongs to no form (it opens the modal that holds one), and the
  // suggestions form's own commit. So a COUNT over the route would pin a number
  // where a rule belongs, and would red the next time this page legitimately grows
  // a form — a guard that fails on a correct change. What the rank forbids is one
  // form carrying TWO commits, and a second action competing with Add on this card.
  // Both are asserted; neither is a total.
  await expect(addCard.locator(".button-control-primary")).toHaveCount(1);
  const formsWithTwoPrimaries = await page
    .locator("main form")
    .evaluateAll((forms) =>
      forms
        .map((form) =>
          Array.from(form.querySelectorAll(".button-control-primary"), (el) =>
            (el.textContent ?? "").trim()
          )
        )
        .filter((labels) => labels.length > 1)
    );
  expect(formsWithTwoPrimaries).toEqual([]);
  // The positive control that keeps that sweep off an empty population: the route's
  // OTHER primary is a form commit, so `main form` had something ranked to look at.
  // It also names the second primary, which is the fact the rule rests on.
  const suggestCommit = page.getByRole("button", { name: "Get suggestions" });
  await expect(suggestCommit).toHaveClass(/\bbutton-control-primary\b/);
  expect(
    await suggestCommit.evaluate((el) => el.closest("form") !== null)
  ).toBe(true);
  await expect(addButton.getByText("Add supplement")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Add supplement" })
  ).toHaveCount(0);
  await addButton.click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  const addPanel = addDialog.getByTestId("supplement-add-panel");
  await expect(addPanel).toBeVisible();
  await expect(addPanel).toHaveCSS("padding-left", "4px");
  // The modal opens on the name and the facts it will save — no editors (#3216), so
  // the dose is a chip that PROMPTS for itself rather than an empty input.
  await expect(addDialog.getByLabel("Name")).toBeVisible();
  await expect(addDialog.getByTestId("intake-editor")).toHaveCount(0);
  await expect(addDialog.getByTestId("intake-fact-dose")).toHaveAttribute(
    "data-fact-state",
    "missing"
  );
  const dose = await openFact(page, "dose", addDialog);
  await expect(dose.getByLabel("Amount").first()).toBeVisible(); // eslint-disable-line no-restricted-properties -- first-ok: first basic dose row in the scoped modal
  await closeEditor(page, addDialog);
  await addDialog.getByRole("button", { name: "Close" }).click();

  // THE DAY-SHAPED CHROME IS GONE FROM THIS TAB, and this is the REMOVAL half of the
  // claim (#3987): the recent-day lens, the slot filter and the day heading all went
  // with the schedule.
  await expect(page.getByTestId("supplement-day-toggle")).toHaveCount(0);
  await expect(page.getByTestId("supplement-slot-selector")).toHaveCount(0);
  await expect(page.getByTestId("supplement-context-heading")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Time slots", level: 3 })
  ).toHaveCount(0);

  // SUGGESTIONS ARE ROWS, NOT A BADGE THAT OPENS A DIALOG (#3987 phase 2). Pending
  // ones only, each carrying the origin badge that says which half wrote it — a
  // curated claim and a generated one must never look alike (#2378) — with the
  // AI-origin explainer stated ONCE for the surface (#3970) and reachable by tap
  // rather than by hover (#3375).
  const suggestions = page.getByTestId("supplement-suggestions");
  await expect(suggestions).toBeVisible();
  await expect(page.getByTestId("supplement-suggestions-badge")).toHaveCount(0);
  await expect(suggestions.getByTestId("generated-origin-help")).toHaveCount(1);
  await expect(
    // eslint-disable-next-line no-restricted-properties -- first-ok: any curated row proves the origin split renders; the claim is about the shape
    suggestions
      .locator('[data-testid^="curated-supplement-suggestion-"]')
      .first()
  ).toBeVisible();

  // …and the safety layer sits below the stack rather than above it, which is the
  // whole of #3892's intent transferred here: still on the page, still full height,
  // just no longer spending the first screen (#2385).
  const insightsSection = page.getByTestId("supplement-insights");
  const stackBox = await page.getByTestId("supplement-stack").boundingBox();
  const insightsSectionBox = await insightsSection.boundingBox();
  expect(stackBox).not.toBeNull();
  expect(insightsSectionBox).not.toBeNull();
  expect(stackBox!.y).toBeLessThan(insightsSectionBox!.y);
  // rda-adequacy-calcium is the same seeded finding mobile-density-sweep pins on this
  // route, so this names a fact about the shared seed that is already checked twice.
  await expect(
    insightsSection.getByTestId("rda-adequacy-calcium")
  ).toBeVisible();

  // Back to Food (NavTabs Next <Link> → followLink, #889 sweep).
  await followLink(page, page.getByRole("tab", { name: "Day" }), /tab=food/);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
});

// The Day ledger collapses a bucket's still-due doses into ONE row with a bulk
// Take-all (#3987/#3936), so the individual names are behind that fold. Every dose
// assertion below opens them first.
async function expandDueGroups(page: Page): Promise<void> {
  const groups = page.locator('[data-testid^="ledger-due-group-"]');
  const n = await groups.count();
  for (let i = 0; i < n; i++) {
    const row = groups.nth(i);
    if ((await row.getAttribute("aria-expanded")) === "false")
      await row.click();
  }
}

test("a newly scheduled supplement does not appear on earlier days", async ({
  page,
}) => {
  const name = "New schedule boundary (e2e)";
  const db = new Database(dbPath());
  db.pragma("busy_timeout = 5000");
  let itemId: number | null = null;
  try {
    const createdAt = frozenNow().toISOString();
    itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, obligation, condition, source, created_at)
           VALUES (1, ?, 1, 'supplement', 'should', 'daily', 'manual', ?)`
        )
        .run(name, createdAt).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, '1 cap', 'Morning', 'any', 0, ?)`
    ).run(itemId, createdAt);

    // AND THE CONVERSE OF THAT REMOVAL: the day lens did not vanish, it MOVED. The
    // lifetime bound it existed to demonstrate — an item created today is not owed on
    // an earlier day — is now the Day ledger's, on the Food tab, where the day lives.
    await page.goto("/nutrition?tab=supplements");
    // `.toBeVisible` WITHOUT ITS PARENTHESES was a no-op here before #3987 touched
    // this test, so the today half of "appears today, not earlier" had never run.
    await expect(
      page.getByTestId("intake-item-name").filter({ hasText: name })
    ).toBeVisible();
    await page.goto("/nutrition?tab=food");
    const ledger = page.getByTestId("day-ledger");
    await expandDueGroups(page);
    await expect(ledger).toContainText(name);
    await page.getByTestId("food-day-yesterday").click();
    await expandDueGroups(page);
    await expect(ledger).not.toContainText(name);
  } finally {
    if (itemId != null) {
      db.prepare("DELETE FROM intake_item_doses WHERE item_id = ?").run(itemId);
      db.prepare("DELETE FROM intake_items WHERE id = ?").run(itemId);
    }
    db.close();
  }
});

test("supplement suggestion provenance stays visually bounded", async ({
  page,
}) => {
  const name = "Source preview guard (e2e)";
  const db = new Database(dbPath());
  db.pragma("busy_timeout = 5000");
  try {
    db.prepare(
      "DELETE FROM intake_item_suggestions WHERE profile_id = 1 AND name = ?"
    ).run(name);
    db.prepare(
      `INSERT INTO intake_item_suggestions
         (profile_id, name, rationale, trigger, source_detail, status, food_timing)
       VALUES (1, ?, 'Fixture rationale', 'labs', ?, 'pending', 'any')`
    ).run(
      name,
      "New/changed biomarkers: Vitamin D, Ferritin, Magnesium, Vitamin B12, Folate, Zinc, Copper, Selenium"
    );

    await page.goto("/nutrition?tab=supplements");
    // Keyed on the row's OWN testid, not on `div.rounded-lg`: the frame is `sm:`-only
    // since #3987 put these rows inside `main` under #3673's flat ban, so the class
    // this used to select on is absent at every width below `sm`.
    const suggestion = page
      .getByTestId("supplement-suggestions")
      .locator('[data-testid^="generated-supplement-suggestion-"]')
      .filter({ hasText: name });
    await expect(suggestion).toBeVisible();
    await expect(
      suggestion.getByTestId("supplement-suggestion-source")
    ).toHaveClass(/\bline-clamp-2\b/);
  } finally {
    db.prepare(
      "DELETE FROM intake_item_suggestions WHERE profile_id = 1 AND name = ?"
    ).run(name);
    db.close();
  }
});

test("a curated supplement suggestion is visibly distinct from a generated one (#2378)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Two suggestions side by side in the same panel: one from the committed
  // biomarker→supplement map (no model involved), one from the AI route. They are
  // different CLAIMS, so they must not render identically — each carries an origin
  // badge naming where it came from.
  const generatedName = "Generated draft (e2e)";
  const db = new Database(dbPath());
  db.pragma("busy_timeout = 5000");
  const cleanup = () => {
    db.prepare(
      "DELETE FROM intake_item_suggestions WHERE profile_id = 1 AND name = ?"
    ).run(generatedName);
    db.prepare(
      "DELETE FROM medical_records WHERE profile_id = 1 AND canonical_name = 'Folate'"
    ).run();
  };
  try {
    cleanup();
    // A flagged-low Folate reading — a family the curated map covers, absent from the
    // seed, and one the seeded stack does not already supplement.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, flag)
       VALUES (1, ?, 'lab', 'Folate', '3.1', 'ng/mL', 'Folate', 'low')`
    ).run(frozenNow().toISOString().slice(0, 10));
    db.prepare(
      `INSERT INTO intake_item_suggestions
         (profile_id, name, rationale, trigger, status, food_timing)
       VALUES (1, ?, 'Fixture rationale', 'labs', 'pending', 'any')`
    ).run(generatedName);

    await page.goto("/nutrition?tab=supplements");
    // The suggestions are a SECTION on the page now, not a modal (#3987 phase 2);
    // the scope this names is the surface, which is what "once per surface" means.
    const panel = page.getByTestId("supplement-suggestions");

    // The curated card: badged Curated, naming the flagged biomarker, with no dose.
    const curated = panel.getByTestId("curated-supplement-suggestion-folate");
    await expect(curated).toBeVisible();
    await expect(curated).toHaveAttribute("data-origin", "curated");
    await expect(curated.getByTestId("suggestion-origin-badge")).toHaveText(
      "Curated"
    );
    // #3970 rule 1: the origin explainer is a CONSTANT — every card in this list is
    // curated — so it states itself ONCE for the list, not once per card, and stays
    // touch- and keyboard-reachable there (#3375/#2378 bind the single mount too).
    // Stated by NAME as well as by testid: AC 1 is about the LABEL, and a
    // testid-only absence assertion binds to an artifact of the fix rather than to
    // the property — it would pass against a regression that spelled the id
    // differently or dropped it (measured on the clinical table, where the base's
    // own mount carries no testid at all).
    const CURATED_SENTENCE =
      "From the curated, human-reviewed biomarker→supplement map — the same suggestion every time, with no AI involved.";
    await expect(
      curated.getByRole("button", { name: CURATED_SENTENCE, exact: true })
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: CURATED_SENTENCE, exact: true })
    ).toHaveCount(1);
    await expect(curated.getByTestId("curated-origin-help")).toHaveCount(0);
    const curatedHelp = panel.getByTestId("curated-origin-help");
    await expect(curatedHelp).toHaveCount(1);
    await curatedHelp.click();
    await expect(page.getByRole("tooltip")).toContainText(
      "human-reviewed biomarker→supplement map"
    );
    await expect(page.getByRole("tooltip")).toContainText("no AI involved");
    await expect(curated).toContainText("Folate");
    await expect(curated).toContainText("Folic acid");

    // The AI card: same panel, badged Generated.
    const generated = panel
      .locator('[data-origin="generated"]')
      .filter({ hasText: generatedName });
    await expect(generated).toBeVisible();
    await expect(generated.getByTestId("suggestion-origin-badge")).toHaveText(
      "Generated"
    );
    const GENERATED_SENTENCE =
      "Written by AI from your data — not from the curated map. Review it before acting on it.";
    await expect(
      generated.getByRole("button", { name: GENERATED_SENTENCE, exact: true })
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: GENERATED_SENTENCE, exact: true })
    ).toHaveCount(1);
    await expect(generated.getByTestId("generated-origin-help")).toHaveCount(0);
    const generatedHelp = panel.getByTestId("generated-origin-help");
    await expect(generatedHelp).toHaveCount(1);
    await generatedHelp.click();
    await expect(page.getByRole("tooltip")).toContainText(
      "Written by AI from your data"
    );
  } finally {
    cleanup();
    db.close();
  }
});

test("the Medications page renders its list and inline add workflow (#746)", async ({
  page,
}) => {
  await page.goto("/medications");
  // The #747 parity fixture renders in the shared, scannable medication list.
  await expect(
    medicationRow(medicationList(page), "Adherence Refill Med (e2e)")
  ).toBeVisible();
  // The kind-locked add workflow opens inline instead of occupying the page at rest.
  await page.getByTestId("medication-add-toggle").click();
  await expect(page.getByTestId("medication-add-panel")).toBeVisible();
});

// ── Infant supplements reachability (#746) ───────────────────────────────────
// A profile-switch mutates SERVER-SIDE session state shared across the suite, so
// this describe runs serially and always restores the "admin" profile — the same
// discipline kids-growth.spec follows. The infant profile + its supplement are
// seeded/cleaned via a raw connection so the shared fixture is untouched.
const BABY = "Baby (e2e #746)";
const BABY_SUPP = "Baby Vitamin D (e2e #746)";

function cleanupBaby(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const ids = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .all(BABY) as { id: number }[];
    for (const { id } of ids) {
      db.prepare(
        "DELETE FROM intake_item_doses WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ?)"
      ).run(id);
      db.prepare("DELETE FROM intake_items WHERE profile_id = ?").run(id);
      db.prepare("DELETE FROM profile_settings WHERE profile_id = ?").run(id);
      // The profile row + whatever its CONSTRUCTOR seeded (the #1487 standard metric
      // saves). Deleting the row directly trips saved_items' foreign key.
      destroyFixtureProfile(db, id);
    }
  } finally {
    db.close();
  }
}

function seedBaby(): void {
  const db = new Database(dbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const pid = createFixtureProfile(db, BABY);
    // ~6 months old → getProfileAge() = 0 → life-stage "infant" → Food logging off.
    const bd = frozenNow();
    bd.setMonth(bd.getMonth() - 6);
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'birthdate', ?)"
    ).run(pid, bd.toISOString().slice(0, 10));
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, obligation, condition, source)
           VALUES (?, ?, 1, 'supplement', 'should', 'daily', 'manual')`
        )
        .run(pid, BABY_SUPP).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, '400 IU', 'Morning', 'any', 0, datetime('now'))`
    ).run(itemId);
  } finally {
    db.close();
  }
}

async function switchProfile(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("profile-identity-bar").click();
  await page
    .getByTestId("profile-switcher-panel")
    .locator("form")
    .filter({ hasText: name })
    .getByRole("button")
    .click();
  // The ASSERTION is the settle here, and it needs a real window. This switch is
  // driven from "/" — the dashboard, the one page with steady background
  // action-POST traffic — where settledClick can resolve on a bystander poll rather
  // than the switch itself (docs/internals/e2e-hygiene.md), so the blessed form is a
  // retrying read of the server-rendered marker. The default 5s was the flake: the
  // switch POST lands, then the dashboard re-renders for the NEW profile, and under
  // suite load that re-render is what runs long — the trigger simply still showed
  // the previous profile when the clock ran out (most often on the switch BACK,
  // which left the shared session on the fixture profile for whatever ran next).
  await expect(page.getByTestId("profile-identity-bar")).toContainText(name, {
    timeout: 20_000,
  });
}

test.describe("infant supplements stay reachable (#746)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    cleanupBaby();
    seedBaby();
  });
  test.afterAll(cleanupBaby);

  test("the Day tab is gated but Manage works", async ({ page }) => {
    await switchProfile(page, BABY);
    try {
      // Food tab: the calm infant note, no serving logger.
      await page.goto("/nutrition");
      await expect(page.getByTestId("nutrition-infant-note")).toBeVisible();
      await expect(page.getByTestId("food-log-bar")).toHaveCount(0);

      // Supplements tab: reachable, and the infant's supplement renders.
      await page.goto("/nutrition?tab=supplements");
      await expect(page.getByTestId("supplement-workspace")).toBeVisible();
      await expect(
        page.getByTestId("intake-item-name").filter({ hasText: BABY_SUPP })
      ).toBeVisible();
      // The food-preferences card rides the SAME life-stage gate the Settings copy
      // does (#975/#1462): the adult food-group catalog means nothing here, while
      // the stack above it does.
      await expect(page.getByTestId("food-preferences-card")).toHaveCount(0);
    } finally {
      // Restore the default active profile for any following spec.
      await switchProfile(page, "admin");
    }
  });
});
