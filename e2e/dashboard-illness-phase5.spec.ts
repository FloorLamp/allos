import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";
import {
  comboboxRows,
  expectNoClippedContent,
  hydratedClick,
  openDashboardAll,
  settledBoxes,
  settledClick,
  settledFill,
} from "./helpers";
import { addFromPicker, openTempEntry, settledTap } from "./symptom-helpers";
import {
  E2E_LOGIN_CARE,
  E2E_LOGIN_ILLNESS_CAREGIVER,
  E2E_LOGIN_ILLNESS_RO,
  E2E_LOGIN_MULTI_ILLNESS,
  MULTI_ILLNESS_PROFILE,
  E2E_LOGIN_SICK_COLLAPSE,
  E2E_LOGIN_SICK_SELF,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// This spec owns the multi-episode profile's three episodes, its cough/nausea, its
// 101.9 °F reading, and its Ibuprofen administrations. Reset only those rows before
// driving it so a retry or repeat starts from the seeded baseline without touching
// the fixture's headache or any other profile's data.
//
// IT RESTORES WHAT THIS FILE'S OWN TESTS SPEND. The simultaneous-episode test ENDS
// all three episodes and its end-episode dialog can stop the Ibuprofen with them, so
// "reset the writes" had to mean the episodes and the med too — otherwise the first
// test in a worker consumed the fixture and every later test sharing that DB (and
// every RETRY of the test itself, which opens by counting three cockpits) ran against
// a profile with no open illness and no medication. Both restores are UPDATEs against
// the seeded rows, so the fixture's start dates and dose are unchanged.
function resetMultiIllnessWrites(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(MULTI_ILLNESS_PROFILE) as { id: number };
    db.prepare(
      `DELETE FROM symptom_logs
        WHERE profile_id = ? AND symptom IN ('cough', 'nausea')`
    ).run(profile.id);
    db.prepare(
      `DELETE FROM medical_records
        WHERE profile_id = ? AND canonical_name = 'Body Temperature'
          AND value_num = 101.9`
    ).run(profile.id);
    db.prepare(
      `DELETE FROM intake_item_logs
        WHERE item_id IN (
          SELECT id FROM intake_items
           WHERE profile_id = ? AND name = 'Ibuprofen'
        )`
    ).run(profile.id);
    db.prepare(
      `UPDATE illness_episodes SET end_date = NULL WHERE profile_id = ?`
    ).run(profile.id);
    db.prepare(
      `UPDATE situations SET active = 1, illness_type = 1
        WHERE profile_id = ? AND name IN ('Flu', 'Migraine', 'Stomach bug')`
    ).run(profile.id);
    db.prepare(
      `UPDATE intake_items SET active = 1
        WHERE profile_id = ? AND name = 'Ibuprofen'`
    ).run(profile.id);
  } finally {
    db.close();
  }
}

const credentials = (username: string) => ({
  username,
  password: E2E_MEMBER_PASSWORD,
});

test("simultaneous episodes keep whole controls and close independently", async ({
  browser,
}) => {
  resetMultiIllnessWrites();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_MULTI_ILLNESS,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const cockpits = page
      .getByTestId("illness-now-group")
      .locator("[data-episode-key]");
    await expect(cockpits).toHaveCount(3);
    await cockpits
      .nth(1)
      .locator('[data-testid^="illness-cockpit-toggle-"]')
      .click();
    await expect(cockpits.nth(1)).toHaveAttribute("data-expanded", "false");
    await expect(cockpits.nth(0)).toHaveAttribute("data-expanded", "true");
    await expect(cockpits.nth(2)).toHaveAttribute("data-expanded", "true");
    await cockpits
      .nth(1)
      .locator('[data-testid^="illness-cockpit-toggle-"]')
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const hrefs = await cockpits
      .getByTestId("illness-cockpit-full-episode")
      .evaluateAll((links) =>
        links.map((link) => (link as HTMLAnchorElement).getAttribute("href")!)
      );
    const situationNames = async () =>
      cockpits.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-situation"))
      );
    expect(await situationNames()).toEqual(["Stomach bug", "Migraine", "Flu"]);
    const toggles = cockpits.locator(
      '[data-testid^="illness-cockpit-toggle-"]'
    );
    const toggleLabels = await toggles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label"))
    );
    const detailLabels = await cockpits
      .getByTestId("illness-cockpit-full-episode")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label"))
      );
    expect(new Set(toggleLabels).size).toBe(3);
    expect(new Set(detailLabels).size).toBe(3);
    expect(toggleLabels.join(" ")).toContain("Stomach bug episode");
    expect(toggleLabels.join(" ")).toContain("Migraine episode");
    expect(toggleLabels.join(" ")).toContain("Flu episode");

    const bySituation = (situation: string) =>
      page
        .getByTestId("illness-now-group")
        .locator(`[data-situation="${situation}"]`);
    async function addSymptom(cockpit: Locator, symptom: string) {
      const bar = cockpit.getByTestId("symptom-log-bar");
      await addFromPicker(bar, symptom, settledTap(page));
      await expect(bar.getByTestId(`symptom-${symptom}-sev-1`)).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    }
    await addSymptom(bySituation("Flu"), "cough");
    await addSymptom(bySituation("Migraine"), "nausea");
    await page.reload();
    await expect(
      bySituation("Flu").getByTestId("symptom-cough-sev-1")
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      bySituation("Migraine").getByTestId("symptom-nausea-sev-1")
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByTestId("illness-now-group").getByTestId("symptom-cough-sev-1")
    ).toHaveCount(1);
    await expect(
      page.getByTestId("illness-now-group").getByTestId("symptom-nausea-sev-1")
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByTestId("symptom-headache-sev-2")
    ).toHaveCount(1);

    const owningCockpit = bySituation("Stomach bug");
    await expect(
      page.getByTestId("illness-now-group").getByTestId("temp-quick-toggle")
    ).toHaveCount(1);
    await expect(
      page.getByTestId("illness-now-group").getByTestId("cockpit-prn")
    ).toHaveCount(1);
    await expect(
      owningCockpit.getByTestId("illness-shared-profile-controls-context")
    ).toContainText("shared across");
    for (const situation of ["Migraine", "Flu"]) {
      await expect(
        bySituation(situation).getByTestId("temp-quick-toggle")
      ).toHaveCount(0);
      await expect(
        bySituation(situation).getByTestId("cockpit-prn")
      ).toHaveCount(0);
    }
    const owningBar = owningCockpit.getByTestId("symptom-log-bar");
    await openTempEntry(owningBar);
    await owningBar.getByTestId("temp-quick-input").fill("101.9");
    await owningBar.getByTestId("temp-quick-time").fill("12:00");
    await settledClick(page, owningBar.getByTestId("temp-quick-save"));
    // GIVING A MED IS TWO TAPS NOW (#4752 item 4): the chip opens the med and the
    // panel's labeled-verb chip writes the dose it names. The chip deliberately does
    // not write — its label is the med's NAME, and a chip whose tap wrote a dose the
    // reader never saw would break the one thing the primitive promises.
    await hydratedClick(
      page,
      owningCockpit
        .locator('[data-testid^="cockpit-med-chip-"]')
        .filter({ hasText: "Ibuprofen" })
    );
    await settledClick(
      page,
      owningCockpit.getByTestId("cockpit-med-panel").getByTestId("prn-log-now")
    );
    await page.reload();
    await expect(
      bySituation("Stomach bug").getByTestId("cockpit-summary-temperature")
    ).toContainText("101.9");
    await expect(
      bySituation("Stomach bug").getByTestId("cockpit-summary-medication")
    ).toContainText("Ibuprofen");
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByTestId("cockpit-summary-temperature")
        .filter({ hasText: "101.9" })
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByTestId("cockpit-summary-medication")
        .filter({ hasText: "Ibuprofen" })
    ).toHaveCount(1);

    const standingFingerprint = () =>
      page
        .getByTestId("dashboard-standing")
        .locator('[data-testid="dashboard-candidate"]')
        .evaluateAll((nodes) =>
          nodes.map(
            (node) =>
              `${node.getAttribute("data-candidate-id")}|${node.getAttribute("data-fact-key")}`
          )
        );
    const standingBefore = await standingFingerprint();
    expect(standingBefore.length).toBeGreaterThan(0);

    async function close(situation: string, remaining: string[]) {
      const cockpit = page
        .getByTestId("illness-now-group")
        .locator("[data-episode-key]")
        .filter({ hasText: situation });
      await cockpit.getByTestId("cockpit-end-episode").click();
      const dialog = page.getByRole("dialog", { name: "End this episode?" });
      await dialog.getByRole("button", { name: "End episode" }).click();
      await expect(
        page.getByTestId("illness-now-group").locator("[data-episode-key]")
      ).toHaveCount(remaining.length);
      if (remaining.length > 0)
        expect(await situationNames()).toEqual(remaining);
      expect(await standingFingerprint()).toEqual(standingBefore);
    }

    await close("Stomach bug", ["Migraine", "Flu"]);
    await close("Migraine", ["Flu"]);
    await close("Flu", []);

    // Restore the isolated fixture through the real reopen controls so this remains
    // repeat-safe while proving the same three stable episode rows return.
    for (const href of hrefs) {
      await page.goto(href);
      await page.getByTestId("episode-reopen-action").click();
      const dialog = page.getByRole("dialog", { name: "Reopen this episode?" });
      await dialog.getByRole("button", { name: "Reopen episode" }).click();
      await expect(page.getByText("Episode reopened.")).toBeVisible();
    }
    await page.goto("/");
    await expect(
      page.getByTestId("illness-now-group").locator("[data-episode-key]")
    ).toHaveCount(3);
  } finally {
    await page.context().close();
  }
});

function memberCockpit(page: Page, name: string) {
  return page
    .getByTestId("illness-now-group")
    .locator("[data-episode-key]")
    .filter({ hasText: name });
}

async function expand(cockpit: Locator) {
  if ((await cockpit.getAttribute("data-expanded")) !== "true") {
    await cockpit.locator('[data-testid^="illness-cockpit-toggle-"]').click();
  }
  await expect(cockpit).toHaveAttribute("data-expanded", "true");
}

async function pickMedication(page: Page, scope: Page | Locator, name: string) {
  await settledFill(page, scope.getByRole("combobox", { name: "Name" }), name);
  // Portaled listbox (#3271): it lives on <body>, not inside `scope`.
  const option = comboboxRows(page).filter({ hasText: name }).first(); // first-ok: the typed medication narrows this transient list
  await expect(option).toBeVisible();
  await option.click();
}

test("an active illness renders the real cockpit with exact candidate identity", async ({
  browser,
}) => {
  const page = await loginAs(browser, credentials(E2E_LOGIN_SICK_SELF));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const cockpit = page
      .getByTestId("illness-now-group")
      .locator('[data-active="true"]');
    await expect(cockpit).toHaveCount(1);
    await expect(cockpit).toHaveAttribute("data-expanded", "true");
    await expect(cockpit.getByTestId("symptom-log-bar")).toBeVisible();
    // THE HEADER IS THE STATUS (#4752 item 1). The three-stat readings grid it
    // replaces is retired from the cockpit; the recovery header states the same
    // facts as one prose line under the countdown.
    await expect(cockpit.getByTestId("cockpit-recovery-header")).toBeVisible();
    await expect(cockpit).toHaveAttribute(
      "data-candidate-id",
      /illness\.state:/
    );
    await expect(cockpit).toHaveAttribute("data-fact-key", /illness\.episode:/);
    const factKeys = await page
      .locator("[data-fact-key]")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.getAttribute("data-fact-key"))
          .filter((value): value is string => value != null)
      );
    expect(new Set(factKeys).size).toBe(factKeys.length);

    await expectNoClippedContent(page);
    await cockpit.getByTestId("cockpit-end-episode").click();
    const dialog = page.getByRole("dialog", { name: "End this episode?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(cockpit).toHaveAttribute("data-expanded", "true");
  } finally {
    await page.context().close();
  }
});

test("collapse and expansion survive a reload", async ({ browser }) => {
  const page = await loginAs(browser, credentials(E2E_LOGIN_SICK_COLLAPSE));
  try {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/");
    const cockpit = () =>
      page.getByTestId("illness-now-group").locator('[data-active="true"]');
    const toggle = () =>
      cockpit().locator('[data-testid^="illness-cockpit-toggle-"]');

    async function persist(want: "true" | "false") {
      await expect(async () => {
        if ((await cockpit().getAttribute("data-expanded")) !== want)
          await settledClick(page, toggle());
        await page.reload();
        await expect(cockpit()).toHaveAttribute("data-expanded", want, {
          timeout: 3_000,
        });
      }).toPass({ timeout: 25_000 }); // topass-ok: the async preference write has no earlier persisted marker
    }

    await persist("true");
    await settledClick(page, toggle());
    await expect(cockpit()).toHaveAttribute("data-expanded", "false");
    await expect(cockpit().getByTestId("symptom-log-bar")).toHaveCount(0);
    await expect(
      cockpit().getByTestId("illness-cockpit-temperature")
    ).toBeVisible();
    await persist("false");
    await persist("true");
  } finally {
    await page.context().close();
  }
});

test("household episodes stay ordered and a writable accordion logs without switching", async ({
  browser,
}) => {
  const page = await loginAs(browser, credentials(E2E_LOGIN_CARE));
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      "Care Parent"
    );
    const illnessGroup = page.getByTestId("illness-now-group");
    const names = await illnessGroup
      .locator('[data-testid^="illness-cockpit-name-"]')
      .allTextContents();
    expect(names).toEqual([
      "Care Parent (e2e)",
      "Sick Kid A (e2e)",
      "Sick Kid B (e2e)",
    ]);
    // Now is a BAND OF ROWS since #4076, and the illness group stands in it where
    // its first episode placed — so the reading order is read off the band's own
    // children rather than off a grid of cards.
    const nowIds = await page
      .getByTestId("now-strip")
      .locator(":scope > ul > li")
      .evaluateAll((rows) =>
        rows.map(
          (row) =>
            row.getAttribute("data-candidate-id") ??
            row.getAttribute("data-testid")!
        )
      );
    const safetyIndex = nowIds.findIndex((id) =>
      id.startsWith("attention.fact:mental-health:crisis:")
    );
    const illnessIndex = nowIds.indexOf("dashboard-illness-group");
    const workoutIndex = nowIds.findIndex((id) =>
      id.startsWith("workout.live:")
    );
    expect(safetyIndex).toBeGreaterThanOrEqual(0);
    expect(safetyIndex).toBeLessThan(illnessIndex);
    expect(illnessIndex).toBeLessThan(workoutIndex);

    const kidA = memberCockpit(page, "Sick Kid A");
    await expand(kidA);
    const bar = kidA.getByTestId("symptom-log-bar");
    await openTempEntry(bar);
    await bar.getByTestId("temp-quick-input").fill("103.4");
    await bar.getByTestId("temp-quick-time").fill("12:00");
    await settledClick(page, bar.getByTestId("temp-quick-save"));
    await expect(kidA.getByTestId("cockpit-summary-temperature")).toContainText(
      "103.4"
    );
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      "Care Parent"
    );
    const kidB = memberCockpit(page, "Sick Kid B");
    await expand(kidB);
    await expect(kidA).toHaveAttribute("data-expanded", "false");
    await expect(kidB).toHaveAttribute("data-expanded", "true");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await switchToProfile(page, "Sick Kid A");
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      "Sick Kid A"
    );
    await expect(
      page
        .getByTestId("illness-now-group")
        .locator('[data-active="true"]')
        .locator('[data-testid^="illness-cockpit-name-"]')
    ).toContainText("Sick Kid A");
    await switchToProfile(page, "Care Parent");
  } finally {
    await page.context().close();
  }
});

test("target-profile authorization controls every household cockpit write", async ({
  browser,
}) => {
  const readOnly = await loginAs(browser, credentials(E2E_LOGIN_ILLNESS_RO));
  try {
    await readOnly.goto("/");
    const cockpit = memberCockpit(readOnly, "admin");
    await expand(cockpit);
    // THE HEADER IS THE STATUS (#4752 item 1). The three-stat readings grid it
    // replaces is retired from the cockpit; the recovery header states the same
    // facts as one prose line under the countdown.
    await expect(cockpit.getByTestId("cockpit-recovery-header")).toBeVisible();
    await expect(cockpit.getByTestId("symptom-log-bar")).toHaveCount(0);
    await expect(cockpit.getByTestId("cockpit-prn")).toHaveCount(0);
    await expect(cockpit.getByTestId("cockpit-end-episode")).toHaveCount(0);
  } finally {
    await readOnly.context().close();
  }

  const writable = await loginAs(
    browser,
    credentials(E2E_LOGIN_ILLNESS_CAREGIVER)
  );
  try {
    await writable.goto("/");
    const cockpit = memberCockpit(writable, "admin");
    await expand(cockpit);
    await expect(cockpit.getByTestId("symptom-log-bar")).toBeVisible();
    await expect(cockpit.getByTestId("cockpit-end-episode")).toBeVisible();
    await expect(
      writable.getByText(/Update admin's illness care/i)
    ).toHaveCount(0);
  } finally {
    await writable.context().close();
  }
});

test.describe("fresh-profile illness front door", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/");
    if (
      !(await page.getByTestId("profile-identity-bar").textContent())?.includes(
        "admin"
      )
    )
      await switchToProfile(page, "admin");
  });

  test("one tap activates care, the second opens fever logging, and OTC quick-add works inline", async ({
    page,
  }) => {
    test.slow();
    await createProfileViaFamily(page, "phase5-front-door");
    // THE FRONT DOOR MOVED, THE JOURNEY DID NOT (#3366). The first tap used to be on
    // the dashboard tail's well-day card; the 2026-08-29 ruling retired the tail's
    // generic write cards because the quick logger is the app's one quick-write
    // surface. The `?quick=` deep link opens the SAME sheet row from any viewport
    // (lib/pwa-shortcuts.ts), so this reaches the same `SymptomLogBar` mount the
    // puck reaches without moving the rest of the test off desktop width.
    //
    // Both halves are asserted: the tail no longer offers the bridge, and the sheet
    // does — an absence alone would pass on a tree where activation vanished.
    await page.goto("/");
    await openDashboardAll(page);
    await expect(
      page.getByTestId("dashboard-all-contents").getByTestId("symptom-log-bar")
    ).toHaveCount(0);

    await page.goto("/?quick=log-symptom");
    const panel = page.getByTestId("quick-symptom-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await settledClick(
      page,
      panel.getByTestId("symptom-illness-bridge-activate")
    );
    // Read the activation back from a fresh server render rather than from the
    // overlay it was made in: a resolved action is not a committed episode, and the
    // cockpit is where the rest of this journey happens.
    await page.goto("/");
    await expect(page.getByTestId("illness-now-group")).toBeVisible({
      timeout: 20_000,
    });
    const bar = page
      .getByTestId("illness-now-group")
      .getByTestId("symptom-log-bar");
    await bar.getByTestId("temp-quick-toggle").click();
    await expect(bar.getByTestId("temp-quick-entry")).toBeVisible();
    await bar.getByTestId("temp-quick-input").fill("102");
    await bar.getByTestId("temp-quick-time").fill("07:00");
    await settledClick(page, bar.getByTestId("temp-quick-save"));
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByTestId("cockpit-summary-temperature")
    ).toContainText("102");

    await page.getByTestId("illness-add-medication").click();
    const inline = page.getByTestId("illness-medication-quick-add");
    await pickMedication(page, inline, "Ibuprofen");
    // The pick fills the dose from the OTC label, and the chip row STATES it — the
    // whole point of the two-tap path is that nothing has to be opened to see it.
    await expect(inline.getByTestId("intake-fact-dose")).toContainText("mg");
    await settledClick(
      page,
      inline.getByRole("button", { name: "Add", exact: true })
    );
    await expect(inline).toBeHidden({ timeout: 15_000 });
    // THE ADD LANDS AS A CHIP (#4752 item 4). What a fresh cockpit gains from this
    // journey is the medication's NAME in the flow row — the dose and the tap that
    // writes it live one tap inside, so `prn-log-now` is deliberately not on screen
    // until somebody opens the med.
    const added = page
      .getByTestId("cockpit-med-chips")
      .locator('[data-testid^="cockpit-med-chip-"]')
      .filter({ hasText: "Ibuprofen" });
    await expect(added).toBeVisible();
    await expect(page.getByTestId("prn-log-now")).toHaveCount(0);
    await page.reload();
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByText("Ibuprofen", { exact: true })
    ).toBeVisible();
  });
});

// ── THE RECOVERY-LED COMPACT COCKPIT'S GEOMETRY (#4752 items 2 and 3) ───────
//
// Two claims a component test cannot make, because both are about rendered boxes:
// the card holds a readable measure instead of stretching to the viewport, and an
// expansion opens IN PLACE — the card never navigates, and nothing above the panel
// moves when it opens.
//
// THE MEASURE IS ASSERTED AS A RELATIONSHIP, NOT ONLY AS A NUMBER. `width <= 880`
// alone is satisfied by a card that has simply been made narrow, and by one whose
// own container is narrow; the claim is that the card is INSET from the column it
// sits in and centered in it, which is what "never full-bleed" means to a reader.
for (const [label, viewport, wide] of [
  ["desktop", { width: 1280, height: 900 }, true],
  ["phone", { width: 390, height: 844 }, false],
] as const) {
  test(`the illness cockpit holds a readable measure and expands in place (${label})`, async ({
    browser,
  }) => {
    // THE MULTI-EPISODE PROFILE, because it is the one whose cockpit HAS
    // medications: the chip row this test opens is empty on a profile with none,
    // and an empty row would let every geometry claim below pass vacuously.
    resetMultiIllnessWrites();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_MULTI_ILLNESS,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const card = page
        .getByTestId("illness-now-group")
        .locator('[data-situation="Stomach bug"]');
      await expect(card).toHaveAttribute("data-expanded", "true");
      // Wait for the content the measurement is about, not for the card's own
      // visibility: an empty card fits any width.
      await expect(card.getByTestId("cockpit-recovery-header")).toBeVisible();
      const chips = card.getByTestId("cockpit-med-chips");
      await expect(chips).toBeVisible();
      // THE CONTROL THIS WHOLE TEST RESTS ON. Every claim below is about a panel a
      // med chip opens, and an empty chip row would let the measure assertions pass
      // on a card with nothing in it — so the row's population is asserted, not
      // assumed, and a fixture that stops seeding the med fails HERE by name.
      await expect(
        chips.locator('[data-testid^="cockpit-med-chip-"]'),
        "the cockpit's med chips — the subject of every claim below"
      ).not.toHaveCount(0);

      // ONE SETTLED GROUP: every claim below is the card measured AGAINST its own
      // column, so the two boxes have to describe the same layout.
      const [cardBox, columnBox] = await settledBoxes([
        card,
        card.locator("xpath=.."),
      ]);
      expect(cardBox.width, `${label} cockpit measure`).toBeLessThanOrEqual(
        880
      );
      if (wide) {
        // INSET AND CENTERED in the column it sits in — the two gutters equal, and
        // both real. A full-bleed card leaves neither.
        const left = cardBox.x - columnBox.x;
        const right =
          columnBox.x + columnBox.width - (cardBox.x + cardBox.width);
        expect(left, `${label} left gutter`).toBeGreaterThan(1);
        expect(Math.abs(left - right), `${label} centering`).toBeLessThan(2);
      } else {
        // Below the cap the phone is unchanged: the card is the column.
        expect(Math.abs(cardBox.width - columnBox.width)).toBeLessThan(2);
      }

      // IN PLACE (#4752 item 3). Everything the panel opens BENEATH keeps its exact
      // box, and the card keeps its edges — a panel that reflowed the chips, or one
      // that replaced the row it belongs to, fails this.
      const above = [
        card.getByTestId("cockpit-recovery-header"),
        card.getByTestId("symptom-log-actions"),
        chips,
      ];
      const before = await settledBoxes(above);
      const url = page.url();
      // A CLIENT TOGGLE, not a write: the chip opens the med and posts nothing.
      await hydratedClick(
        page,
        chips.locator('[data-testid^="cockpit-med-chip-"]').first() // first-ok: the row's leading med chip; every chip opens the same panel
      );
      const panel = card.getByTestId("cockpit-med-panel");
      await expect(panel).toBeVisible();
      expect(page.url(), "the card never navigates").toBe(url);
      const after = await settledBoxes(above);
      expect(after).toEqual(before);
      const [panelBox] = await settledBoxes([panel]);
      const chipsBox = before[2];
      // DIRECTLY BENEATH ITS OWN ROW, and inside the card's measure.
      expect(panelBox.y).toBeGreaterThanOrEqual(
        chipsBox.y + chipsBox.height - 1
      );
      expect(panelBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(
        cardBox.x + cardBox.width + 1
      );
      const [cardAfter] = await settledBoxes([card]);
      expect(cardAfter.x).toBe(cardBox.x);
      expect(cardAfter.width).toBe(cardBox.width);
      // ── ONE GRAMMAR ACROSS THE WHOLE SECTION (#4752 items 7 and 8) ────────
      //
      // A RENDERED sweep, not a source one: what a reader meets is the accessible
      // name, and a name composed at runtime from two halves is invisible to any
      // scan of the source that builds it. Every control in the Now section is
      // read, so the claim covers the ordinary rows and the cockpit at once.
      const names = await page
        .getByTestId("now-strip")
        .getByRole("button")
        .evaluateAll((nodes) =>
          nodes.map(
            (node) =>
              node.getAttribute("aria-label") ?? node.textContent?.trim() ?? ""
          )
        );
      expect(names.length, "Now section control corpus").toBeGreaterThan(0);
      // The verb names the ACT, never the bookkeeping of it, and never says "now".
      expect(
        names.filter((name) => /mark taken|taken now|earlier dose/i.test(name)),
        names.join(" | ")
      ).toEqual([]);
      // And the clock is the ONE spelling of "happened earlier": every control that
      // asks the question asks it in those words.
      expect(
        names.filter((name) => /happened earlier/i.test(name)).length,
        names.join(" | ")
      ).toBeGreaterThan(0);

      if (!wide) await expectNoClippedContent(page);
    } finally {
      await page.context().close();
    }
  });
}
