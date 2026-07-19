import { test, expect, type Page, type Locator } from "@playwright/test";
import { settledClick } from "./helpers";

// The illness "first hour" front door (issue #843). Three doors, one story:
//   A. the dashboard Symptoms widget's inactive state IS the front door — a calm
//      "Feeling sick?" line whose ONE tap activates Illness AND expands the full card;
//   B. fever-at-7am works the moment the door opens — temperature + reading time is
//      reachable within two taps of a fresh dashboard;
//   C. an OTC quick-add (name → label-default prefill → confirm) on /medications and
//      inline on the symptom card, creating the SAME intake_items row the full form does.
// The final spec walks the whole "sick day 1" story end to end.
//
// The seed makes profile 1 already sick, so each test creates a FRESH, healthy profile
// (an admin can act as any profile) and switches to it — isolated, and an adult by
// default (no pediatric edge cases).

let profileSeq = 0;

// The seed's default admin profile (profile 1). Each test switches the shared session's
// active profile to a fresh one, so afterEach switches it BACK — otherwise the change
// leaks into every later spec (CI runs one worker sharing the session).
const ADMIN_PROFILE = "admin";

// Switch the shared session's active profile via the sidebar UserMenu. Retry-click
// through the hydration window (#730), as the household specs do.
async function switchToProfile(page: Page, name: string): Promise<void> {
  const target = page
    .getByTestId("user-menu-popover")
    .getByRole("button", { name });
  await expect(async () => {
    await page.getByTestId("user-menu-trigger").click();
    await expect(target).toBeVisible({ timeout: 2_000 });
  }).toPass();
  await target.click();
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name);
}

// Create a fresh healthy (illness-free, adult) profile via Settings → Family and switch
// the active profile to it. Returns the (unique) profile name.
async function freshProfile(page: Page, label: string): Promise<string> {
  const name = `${label}-${Date.now()}-${++profileSeq}`;
  await page.goto("/settings/family");
  const profilesCard = page
    .locator("div.card")
    .filter({ hasText: "Add a profile" });
  await profilesCard.getByPlaceholder("Name", { exact: true }).fill(name);
  await profilesCard.getByRole("button", { name: "Add", exact: true }).click();
  // Wait for the new row inside the (visible) Profiles card — not the hidden switcher
  // popover, where the same name also renders.
  await expect(profilesCard.getByText(name)).toBeVisible();
  await switchToProfile(page, name);
  // Goal-based onboarding (#719/#814): a profile created in-app starts with
  // onboarding_state "not_started", so its first dashboard visit redirects to
  // /onboarding. These specs exercise the dashboard itself — defer setup through
  // the product's own affordance so the fresh profile lands on the dashboard.
  await page.goto("/");
  if (page.url().includes("/onboarding")) {
    await page
      .getByRole("button", { name: "Set up later, take me to my dashboard" })
      .click();
    await expect(page).toHaveURL(/\/$|\/\?/);
  }
  return name;
}

// Restore the shared session to the default admin profile so this spec never leaks its
// active-profile switch into another spec.
test.afterEach(async ({ page }) => {
  await page.goto("/");
  if (
    (await page.getByTestId("user-menu-trigger").textContent())?.includes(
      ADMIN_PROFILE
    )
  ) {
    return;
  }
  await switchToProfile(page, ADMIN_PROFILE);
});

// Pick a medication from the quick-add combobox: type it, then CLICK the matching
// listbox option so the combobox's onPick fires (which runs the #846 resolver prefill).
// Clicking the option is more robust than pressing Enter, which submits the form if the
// dropdown hasn't opened yet.
async function pickMedication(
  scope: Page | Locator,
  value: string
): Promise<void> {
  const input = scope.getByRole("combobox", { name: "Medication" });
  await input.click();
  await input.fill(value);
  const option = scope
    .getByRole("listbox")
    .getByText(value, { exact: true })
    .first();
  await expect(option).toBeVisible();
  await option.click();
}

test.describe("Illness front door (#843)", () => {
  test("door A: the inactive Symptoms widget is a one-tap front door", async ({
    page,
  }) => {
    test.slow();
    await freshProfile(page, "welldash");
    await page.goto("/");

    // Well profile: the unified "How are you today?" card (#992) leads with the
    // mood tap and carries the calm illness branch — not the full symptom card.
    const front = page.getByTestId("how-are-you-card");
    await expect(front).toBeVisible();
    await expect(front.getByTestId("feeling-sick-activate")).toBeVisible();
    await expect(page.getByTestId("symptom-log-bar")).toHaveCount(0);

    // ONE tap activates Illness AND expands the full card (single action). The
    // unified card stays (mood + illness coexist, #992) but its illness branch
    // now defers to the hero.
    await page.getByTestId("feeling-sick-activate").click();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();
    await expect(page.getByTestId("feeling-sick-activate")).toHaveCount(0);
    await expect(front.getByTestId("mood-episode-note")).toBeVisible();
    await expect(page.getByTestId("symptom-logged-count")).toHaveCount(0);
    const symptomEmpty = page.getByTestId("symptom-none-logged");
    await expect(symptomEmpty).toHaveText("No symptoms logged.");
    const medicationEmpty = page.getByTestId("quick-log-prn-empty");
    await expect(medicationEmpty).toHaveText("No medications added.");
    expect(await medicationEmpty.getAttribute("class")).toBe(
      await symptomEmpty.getAttribute("class")
    );
    // Temperature quick entry is right there (door B reachability) — collapsed by
    // default (#857) to one tap.
    const actions = page.getByTestId("symptom-log-actions");
    const addSymptom = actions.getByTestId("symptom-add-picker-toggle");
    await expect(addSymptom).toBeVisible();
    await expect(actions.getByTestId("temp-quick-toggle")).toBeVisible();
    await expect(page.getByTestId("symptom-severity-legend")).toHaveCount(0);
    await addSymptom.click();
    await expect(addSymptom).toHaveText("Add symptom");
    await expect(addSymptom).toHaveAttribute("aria-expanded", "true");
    await expect(addSymptom).toHaveClass(/\bbtn-ghost\b/);
    await expect(page.getByTestId("symptom-add-picker")).toBeVisible();
    const logTemperature = actions.getByTestId("temp-quick-toggle");
    await expect(logTemperature).toHaveText("Log temperature");
    const actionsBox = await actions.boundingBox();
    const helperBox = await page
      .getByTestId("symptom-severity-legend")
      .boundingBox();
    expect(actionsBox).not.toBeNull();
    expect(helperBox).not.toBeNull();
    expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(
      helperBox!.y
    );

    // Both neutral disclosure controls follow the same accordion behavior. Opening
    // temperature closes the symptom picker; its control can close the panel again.
    await logTemperature.click();
    await expect(page.getByTestId("symptom-add-picker")).toHaveCount(0);
    await expect(page.getByTestId("symptom-severity-legend")).toHaveCount(0);
    await expect(logTemperature).toHaveText("Log temperature");
    await expect(logTemperature).toHaveAttribute("aria-expanded", "true");
    await expect(logTemperature).toHaveClass(/\bbtn-ghost\b/);
    await expect(page.getByTestId("temp-quick-entry")).toBeVisible();
    await expect(page.getByTestId("temp-quick-time")).toHaveValue(
      /^\d{2}:\d{2}$/
    );
    await logTemperature.click();
    await expect(logTemperature).toHaveText("Log temperature");
    await expect(logTemperature).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("temp-quick-entry")).toHaveCount(0);
  });

  test("door B: temperature + reading time logs within two taps of a fresh dashboard", async ({
    page,
  }) => {
    test.slow();
    await freshProfile(page, "fever7am");
    await page.goto("/");

    // Tap 1 — open the door.
    await page.getByTestId("feeling-sick-activate").click();
    // Temperature entry is collapsed by default (#857) — expand it.
    await page.getByTestId("temp-quick-toggle").click();
    await expect(page.getByTestId("temp-quick-entry")).toBeVisible();

    // A 7am fever: 102 °F at 07:00. Enter the value + time and log it.
    await page.getByTestId("temp-quick-unit").selectOption("F");
    await page.getByTestId("temp-quick-input").fill("102");
    await page.getByTestId("temp-quick-time").fill("07:00");
    await settledClick(page, page.getByTestId("temp-quick-save"));

    // Success closes the accordion (no inline error) — reopening will seed a fresh now.
    await expect(page.getByTestId("temp-quick-entry")).toHaveCount(0);
    await expect(page.getByTestId("temp-quick-error")).toHaveCount(0);
  });

  test("door C: OTC quick-add creates a med from /medications and from the symptom card", async ({
    page,
  }) => {
    test.slow();
    await freshProfile(page, "otc");

    // Entry point 1 — the Medications page quick-add.
    await page.goto("/medications");
    const quickAdd = page.getByTestId("quick-add-medication");
    await expect(quickAdd).toBeVisible();
    await pickMedication(page, "Ibuprofen");
    // Picking prefills the dose amount from the OTC label defaults (#798/#846).
    await expect(page.getByTestId("quick-add-amount")).not.toHaveValue("");
    await page.getByRole("button", { name: "Quick add" }).click();
    await expect(
      page.getByTestId("medication-row").filter({ hasText: "Ibuprofen" })
    ).toBeVisible();

    // Entry point 2 — inline on the dashboard symptom card. Open the door first.
    await page.goto("/");
    await page.getByTestId("feeling-sick-activate").click();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();
    await page.getByTestId("illness-add-medication").click();
    const inline = page.getByTestId("illness-medication-quick-add");
    await expect(inline).toBeVisible();
    await pickMedication(inline, "Acetaminophen");
    await inline.getByRole("button", { name: "Quick add" }).click();
    // The inline panel collapses back to its prompt on success.
    await expect(page.getByTestId("illness-add-medication")).toBeVisible();
    // And the med really landed on the Medications page.
    await page.goto("/medications");
    await expect(
      page.getByTestId("medication-row").filter({ hasText: "Acetaminophen" })
    ).toBeVisible();
  });

  test("sick day 1: feeling sick → symptoms + fever → quick-add ibuprofen → dose → redose chip", async ({
    page,
  }) => {
    test.slow();
    await freshProfile(page, "sickday1");
    await page.goto("/");

    // 1) Feeling sick? — one tap opens the full card.
    await page.getByTestId("feeling-sick-activate").click();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();

    // 2) Two symptoms at severities. Active-first layout (#857): add from the picker
    // (logs at severity 1), then raise.
    const bar = page.getByTestId("symptom-log-bar");
    await bar.getByTestId("symptom-add-picker-toggle").click();
    await bar.getByTestId("symptom-pick-headache").click();
    await bar.getByTestId("symptom-headache-sev-3").click();
    await expect(bar.getByTestId("symptom-headache-sev-3")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await bar.getByTestId("symptom-pick-fever").click();
    await bar.getByTestId("symptom-fever-sev-2").click();
    await expect(bar.getByTestId("symptom-fever-sev-2")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // 3) 102 °F at 07:00 (the fever curve's first reading).
    await page.getByTestId("temp-quick-toggle").click();
    await page.getByTestId("temp-quick-unit").selectOption("F");
    await page.getByTestId("temp-quick-input").fill("102");
    await page.getByTestId("temp-quick-time").fill("07:00");
    await settledClick(page, page.getByTestId("temp-quick-save"));
    await expect(page.getByTestId("temp-quick-entry")).toHaveCount(0);

    // 4) Quick-add ibuprofen right from the symptom card.
    await page.getByTestId("illness-add-medication").click();
    const inline = page.getByTestId("illness-medication-quick-add");
    await pickMedication(inline, "Ibuprofen");
    await settledClick(page, inline.getByRole("button", { name: "Quick add" }));
    await expect(page.getByTestId("illness-add-medication")).toBeVisible();

    // 5) Log a dose from the dashboard PRN quick-log widget, then the redose chip shows.
    await page.goto("/");
    const prnItem = page
      .getByTestId("quick-log-prn")
      .getByTestId("quick-log-prn-item")
      .filter({ hasText: "Ibuprofen" });
    await expect(prnItem).toBeVisible();
    await settledClick(page, prnItem.getByTestId("prn-log-now"));

    // Wait for the log to land (the toast), then the control's own refresh renders the
    // redose chip in place — interval/max came from the quick-add's label-default
    // prefill, and this dose supplies the "since" time.
    await expect(page.getByText(/Logged Ibuprofen/i)).toBeVisible();
    const redoseLine = prnItem.getByTestId("prn-redose-line");
    await expect(redoseLine).toBeVisible({
      timeout: 15_000,
    });
    await expect(redoseLine).toContainText("Next dose in");
    await expect(prnItem.getByTestId("prn-day-label")).toContainText(
      "Last dose"
    );
    await expect(prnItem.getByTestId("prn-day-label")).not.toContainText(
      /\d+ today/
    );
    await expect(redoseLine).toHaveClass(/text-slate-600/);
    await expect(redoseLine).not.toHaveClass(/text-brand/);

    // The cockpit's flat Latest row answers the two immediate safety questions without
    // requiring a chart hover or history scan. The dose name remains a detail link.
    const latest = page
      .getByTestId("illness-hero")
      .getByTestId("episode-latest-readings");
    await expect(latest.getByTestId("episode-last-temperature")).toContainText(
      "102 °F"
    );
    await expect(
      latest.getByTestId("episode-last-temperature-value")
    ).toHaveClass(/text-rose-600/);
    await expect(latest.getByTestId("episode-last-temperature")).toContainText(
      /07:00 \((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
    );
    const lastDose = latest.getByTestId("episode-last-dose");
    await expect(latest.getByText("Last Meds", { exact: true })).toBeVisible();
    await expect(lastDose).toContainText("Ibuprofen · 200 mg");
    await expect(lastDose).toContainText(
      /\d{2}:\d{2} \((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
    );
    const lastDoseLink = lastDose.getByRole("link", { name: "Ibuprofen" });
    await expect(lastDoseLink).toHaveAttribute("href", /\/medications\/\d+/);
    await expect(lastDoseLink).toHaveClass(/text-slate-700/);
    await expect(lastDoseLink).toHaveClass(/underline/);
    await expect(
      page
        .getByTestId("illness-hero")
        .locator('[data-active="true"]')
        .getByTestId("illness-cockpit-last-meds")
    ).toBeHidden();
  });
});
