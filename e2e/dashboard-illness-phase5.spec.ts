import { expect, test } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { createProfileViaFamily, switchToProfile } from "./family-helpers";
import {
  comboboxRows,
  expectNoClippedContent,
  openDashboardAll,
  settledClick,
  settledClickApplied,
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

// This spec owns the multi-episode profile's cough/nausea, 101.9 °F reading, and
// Ibuprofen administrations. Reset only those rows before driving it so a retry or
// repeat starts from the seeded baseline without touching the fixture's headache or
// any other profile's data.
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
    await settledClick(page, owningCockpit.getByTestId("prn-log-now"));
    await page.reload();
    await expect(
      bySituation("Stomach bug").getByTestId("episode-last-temperature")
    ).toContainText("101.9");
    await expect(
      bySituation("Stomach bug").getByTestId("episode-last-dose")
    ).toContainText("Ibuprofen");
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByTestId("episode-last-temperature")
        .filter({ hasText: "101.9" })
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByTestId("episode-last-dose")
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
    await expect(cockpit.getByTestId("episode-latest-readings")).toBeVisible();
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
    const nowCardIds = await page
      .getByTestId("now-strip")
      .locator(':scope > div.grid > [data-testid^="now-strip-card-"]')
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-testid")!)
      );
    const safetyIndex = nowCardIds.findIndex((id) =>
      id.startsWith("now-strip-card-attention.fact:mental-health:crisis:")
    );
    const illnessIndex = nowCardIds.indexOf("now-strip-card-illness-group");
    const workoutIndex = nowCardIds.findIndex((id) =>
      id.startsWith("now-strip-card-workout.live:")
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
    await expect(kidA.getByTestId("episode-last-temperature")).toContainText(
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
    await expect(cockpit.getByTestId("episode-latest-readings")).toBeVisible();
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
    await page.goto("/");
    await openDashboardAll(page);
    await settledClickApplied(
      page,
      page.getByTestId("symptom-illness-bridge-activate"),
      page.getByTestId("illness-now-group")
    );
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
        .getByTestId("episode-last-temperature")
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
    await expect(page.getByTestId("prn-log-now")).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByTestId("illness-now-group")
        .getByText("Ibuprofen", { exact: true })
    ).toBeVisible();
  });
});
