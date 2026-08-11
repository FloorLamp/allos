import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { followLink } from "./helpers";
import { medicationList, medicationRow } from "./med-card-helpers";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { workerDbPath, frozenNow } from "./worker-env";

// IA split (#746): supplements folded into the Nutrition → Supplements tab,
// medications became a standalone Medical-group page. (The old /medicine route was
// removed outright in #1635 and 404s.) This spec proves all three surfaces:
//   1. Nutrition is a URL-driven Food | Supplements umbrella
//   2. /medications renders the medication cards + add form
//   3. an INFANT profile (Food-logging gated off) can still reach the Supplements
//      tab — infant supplements are real (vitamin D drops) — while the Food tab
//      shows the calm note.

function dbPath(): string {
  return workerDbPath();
}

test("Nutrition is a Food | Supplements tab umbrella (#746)", async ({
  page,
}) => {
  // Default tab is Food — the serving logger.
  await page.goto("/nutrition");
  await expect(
    page.getByText(
      "Log food groups, review your week, and manage supplements.",
      { exact: true }
    )
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Food" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Supplements" })).toBeVisible();
  await expect(page.getByTestId("nutrition-workspace-card")).toHaveCount(0);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();

  // Switch to Supplements — the schedule workspace + status render, and the
  // URL is deep-linkable. The tab is a NavTabs Next <Link>, so followLink rides
  // out the pre-hydration swallow (#889 sweep).
  await followLink(
    page,
    page.getByRole("tab", { name: "Supplements" }),
    /tab=supplements/
  );
  await expect(page.getByTestId("situations-bar")).toHaveCount(0);
  await expect(page.getByTestId("supplements-status")).toBeVisible();
  await expect(page.getByTestId("supplements-status-desktop")).toBeVisible();
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
  const bucketHeadings = page.locator(
    '[data-testid^="supplement-bucket-"] > h3'
  );
  expect(await bucketHeadings.count()).toBeGreaterThan(0);
  const highPriorityRow = page
    .getByTestId("supplement-row")
    .filter({ hasText: "Evening Vitamin C (e2e)" });
  // The seeded item is a `must` (#1505 renamed the band); the badge renders for any
  // obligation other than the `should` default.
  await expect(
    highPriorityRow.getByTestId("intake-obligation-must")
  ).toHaveText("Must");
  await expect(highPriorityRow.getByTestId("adherence-summary")).toBeVisible();
  const supplementNameBox = await highPriorityRow
    .getByTestId("medicine-name")
    .boundingBox();
  const supplementActionBox = await highPriorityRow
    .getByTestId("dose-status")
    .boundingBox();
  expect(supplementNameBox).not.toBeNull();
  expect(supplementActionBox).not.toBeNull();
  expect(supplementActionBox!.x).toBeGreaterThan(supplementNameBox!.x);
  const markTaken = highPriorityRow.getByTestId("dose-take");
  await expect(markTaken.locator("svg")).toBeVisible();
  await expect(markTaken).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");

  // Creation is secondary to today's doses: a compact action opens the short
  // name/dose/time path in a modal, with advanced metadata behind a disclosure.
  const addCard = page.getByTestId("add-supplement-card");
  const addButton = addCard.getByTestId("supplement-add-toggle");
  await expect(addButton).toHaveClass(/\bbtn\b/);
  await expect(addButton).not.toHaveClass(/\bbtn-primary\b/);
  await expect(addButton.getByText("Add supplement")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Add supplement" })
  ).toHaveCount(0);
  await addButton.click();
  const addDialog = page.getByRole("dialog", { name: "Add supplement" });
  const addPanel = addDialog.getByTestId("supplement-add-panel");
  await expect(addPanel).toBeVisible();
  await expect(addPanel).toHaveCSS("padding-left", "4px");
  await expect(addDialog.getByLabel("Name")).toBeVisible();
  await expect(addDialog.getByLabel("Amount").first()).toBeVisible(); // first-ok: first basic dose row in the scoped modal
  await expect(
    addDialog.getByTestId("supplement-more-options")
  ).not.toHaveAttribute("open", "");
  await addDialog.getByRole("button", { name: "Close" }).click();

  // Supplements use the same recent-day lens as Food, then large slot cards.
  const dayToggle = page.getByTestId("supplement-day-toggle");
  await expect(dayToggle.getByRole("button")).toHaveCount(7);
  await expect(page.getByTestId("supplement-day-today")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await page.getByTestId("supplement-day-yesterday").click();
  await expect(page.getByTestId("supplement-day-yesterday")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(
    page.getByTestId("supplement-context-heading")
  ).toHaveAccessibleName("Yesterday Supplements");
  await expect(page.getByTestId("supplement-context-label")).toHaveCount(0);
  await expect(page.getByTestId("supplement-slot-chip")).toHaveCount(0);
  await page.getByTestId("supplement-day-today").click();
  await expect(
    page.getByTestId("supplement-context-heading")
  ).toHaveAccessibleName(/Today Supplements(?: (?:Workout|Rest) day)?/);

  // The large schedule cards rest on All and narrow to one supplement time slot.
  await expect(page.getByTestId("supplement-slot-selector")).toHaveAttribute(
    "data-variant",
    "large"
  );
  await expect(
    page.getByRole("heading", { name: "Time slots", level: 3 })
  ).toHaveClass(/\bsr-only\b/);
  await expect(page.getByTestId("supplement-slot-all")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByTestId("supplement-slot-chip")).toHaveCount(0);
  await page.getByTestId("supplement-slot-morning").click();
  await expect(page.getByTestId("supplement-slot-morning")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByTestId("supplement-slot-chip")).toHaveText("Morning");
  await expect(
    page.getByTestId("supplement-context-heading")
  ).toHaveAccessibleName(/Today Morning Supplements(?: (?:Workout|Rest) day)?/);
  await expect(page.getByTestId("supplement-context-label")).toHaveText(
    "Morning"
  );
  await expect(page.getByTestId("supplement-bucket-morning")).toBeVisible();
  await expect(page.getByTestId("supplement-bucket-evening")).toHaveCount(0);

  // Secondary coaching uses the same stable modal pattern as Food's lab suggestions.
  const suggestionBadge = page.getByTestId("supplement-suggestions-badge");
  await expect(suggestionBadge).toHaveAttribute(
    "data-variant",
    "insight-launcher"
  );
  await expect(suggestionBadge).toHaveAttribute("aria-haspopup", "dialog");
  await expect(suggestionBadge).not.toHaveAttribute("aria-expanded", /.*/);
  const sidebar = page.getByTestId("supplement-sidebar-surface");
  const sidebarBefore = await sidebar.boundingBox();
  expect(sidebarBefore).not.toBeNull();
  await suggestionBadge.click();
  const suggestionsDialog = page.getByRole("dialog", {
    name: "Suggestions",
  });
  await expect(
    suggestionsDialog.getByTestId("supplement-suggestions-panel")
  ).toBeVisible();
  const sidebarWhileOpen = await sidebar.boundingBox();
  expect(sidebarWhileOpen).not.toBeNull();
  expect(sidebarWhileOpen!.x).toBeCloseTo(sidebarBefore!.x, 0);
  expect(sidebarWhileOpen!.y).toBeCloseTo(sidebarBefore!.y, 0);
  expect(sidebarWhileOpen!.width).toBeCloseTo(sidebarBefore!.width, 0);
  expect(sidebarWhileOpen!.height).toBeCloseTo(sidebarBefore!.height, 0);
  await suggestionsDialog.getByRole("button", { name: "Close" }).click();

  // Back to Food (NavTabs Next <Link> → followLink, #889 sweep).
  await followLink(page, page.getByRole("tab", { name: "Food" }), /tab=food/);
  await expect(page.getByTestId("food-log-bar")).toBeVisible();
});

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
           VALUES (1, ?, 1, 'supplement', 'may', 'daily', 'manual', ?)`
        )
        .run(name, createdAt).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses
         (item_id, amount, time_of_day, food_timing, sort, created_at)
       VALUES (?, '1 cap', 'Morning', 'any', 0, ?)`
    ).run(itemId, createdAt);

    await page.goto("/nutrition?tab=supplements");
    await expect(page.getByTestId("medicine-name").filter({ hasText: name }))
      .toBeVisible;
    await page.getByTestId("supplement-day-yesterday").click();
    await expect(
      page.getByTestId("medicine-name").filter({ hasText: name })
    ).toHaveCount(0);
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
    await page.getByTestId("supplement-suggestions-badge").click();
    const suggestion = page
      .getByRole("dialog", { name: "Suggestions" })
      .locator("div.rounded-lg")
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
    await page.getByTestId("supplement-suggestions-badge").click();
    const dialog = page.getByRole("dialog", { name: "Suggestions" });

    // The curated card: badged Curated, naming the flagged biomarker, with no dose.
    const curated = dialog.getByTestId("curated-supplement-suggestion-folate");
    await expect(curated).toBeVisible();
    await expect(curated).toHaveAttribute("data-origin", "curated");
    await expect(curated.getByTestId("suggestion-origin-badge")).toHaveText(
      "Curated"
    );
    await expect(curated).toContainText("Folate");
    await expect(curated).toContainText("Folic acid");

    // The AI card: same panel, badged Generated.
    const generated = dialog
      .locator('[data-origin="generated"]')
      .filter({ hasText: generatedName });
    await expect(generated).toBeVisible();
    await expect(generated.getByTestId("suggestion-origin-badge")).toHaveText(
      "Generated"
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

  test("the Food tab is gated but the Supplements tab works", async ({
    page,
  }) => {
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
        page.getByTestId("medicine-name").filter({ hasText: BABY_SUPP })
      ).toBeVisible();
    } finally {
      // Restore the default active profile for any following spec.
      await switchProfile(page, "admin");
    }
  });
});
