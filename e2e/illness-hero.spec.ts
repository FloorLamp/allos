import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { openTempEntry } from "./symptom-helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SICK_SELF,
  E2E_LOGIN_SICK_COLLAPSE,
  E2E_LOGIN_CARE,
  E2E_LOGIN_COCARE,
} from "./fixture-logins";

// Illness hero (#858). The sick-day cockpit is pinned above the customizable grid: the
// acting profile's OWN open episode renders as a full cockpit; every other accessible
// profile's open episode is a compact accordion line that expands in place WITHOUT
// switching the acting profile. These specs OWN dedicated fixture logins (seed-events.ts)
// so their mutations — collapse state, a cross-profile temp/dose — never touch the shared
// admin session's live episode, staying deterministic under CI's --repeat-each=3.

function creds(username: string) {
  return { username, password: E2E_MEMBER_PASSWORD };
}

test("active profile's open episode renders a full cockpit at hero position, no duplicate symptom card", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SICK_SELF));
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.reload();

  const hero = page.getByTestId("illness-hero");
  await expect(hero).toBeVisible();

  // The acting profile's own cockpit (data-active="true"), expanded by default, with the
  // one-tap symptom bar inside it.
  const own = hero.locator('[data-active="true"]');
  await expect(own).toHaveCount(1);
  await expect(own).toHaveAttribute("data-expanded", "true");
  await expect(own.getByTestId("symptom-log-bar")).toBeVisible();
  await expect(own.getByTestId("illness-cockpit-temperature")).toBeHidden();
  await expect(own.getByTestId("illness-cockpit-fever-status")).toBeHidden();
  await expect(
    own.getByRole("heading", { name: "Symptoms & Temperature", level: 3 })
  ).toBeVisible();
  await expect(own.getByText("Daily symptoms", { exact: true })).toHaveCount(0);
  await expect(
    own.getByRole("heading", { name: "Meds", level: 3 })
  ).toBeVisible();
  await expect(
    own.getByRole("link", { name: "View all meds" })
  ).toHaveAttribute("href", "/medications");
  await expect(own.getByTestId("illness-add-medication")).toBeVisible();
  await expect(page.getByTestId("quick-log-prn")).toHaveCount(1);
  const latest = own.getByTestId("episode-latest-readings");
  await expect(latest.getByTestId("school-return-status")).toContainText(
    /Fever-free \d+h\/\d+h/i
  );
  await expect(latest.getByText("Fever status", { exact: true })).toBeVisible();
  await expect(latest.getByTestId("episode-last-temperature")).toContainText(
    "101.3 °F"
  );
  await expect(
    latest.getByTestId("episode-last-temperature-value")
  ).toHaveClass(/text-rose-600/);
  await expect(latest.getByTestId("episode-last-temperature")).toContainText(
    /00:05 \((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
  );
  await expect(latest.getByTestId("episode-last-dose")).toHaveText(
    "Not logged"
  );
  await expect(latest.getByText("Last Meds", { exact: true })).toBeVisible();
  const fullEpisode = own.getByTestId("illness-cockpit-full-episode");
  await expect(fullEpisode).toHaveAccessibleName(
    /^More details about .+'s illness episode$/
  );
  await expect(fullEpisode).toContainText("More details");
  await expect(fullEpisode).toHaveClass(/min-h-10/);
  await expect(fullEpisode).toHaveClass(/focus-visible:ring-2/);
  await expect(fullEpisode).toHaveClass(/text-brand-600/);
  await expect(fullEpisode).not.toHaveClass(/\bbadge\b/);
  await expect(fullEpisode.locator("svg")).toHaveCount(0);
  await expect(own.getByText("More details", { exact: true })).toHaveCount(1);
  const headerToggle = own.locator('[data-testid^="illness-cockpit-toggle-"]');
  const controlledBodyId = await headerToggle.getAttribute("aria-controls");
  expect(controlledBodyId).toBeTruthy();
  await expect(own.locator(`#${controlledBodyId}`)).toBeVisible();
  await expect(headerToggle).toHaveClass(/min-h-10/);
  await expect(headerToggle).toHaveClass(/flex-1/);
  await expect(
    headerToggle.locator('[data-testid^="illness-cockpit-name-"]')
  ).toBeVisible();
  await expect(headerToggle.getByRole("link")).toHaveCount(0);
  const statusRow = headerToggle.getByTestId("illness-cockpit-status-row");
  await expect(statusRow).toBeVisible();
  const headerRow = own.getByTestId("illness-cockpit-header-row");
  await expect(
    headerRow.getByTestId("illness-cockpit-full-episode")
  ).toBeVisible();
  await expect(
    headerRow.locator('[data-testid^="illness-cockpit-toggle-"]')
  ).toHaveCount(1);
  const chevron = headerToggle.getByTestId("illness-cockpit-chevron");
  await headerToggle.hover();
  await expect(chevron).not.toHaveCSS("filter", "none");

  // The dashboard uses the same confirmation as the episode page before resolving.
  await own.getByTestId("cockpit-end-episode").click();
  const resolveDialog = page.getByRole("dialog", {
    name: "End this episode?",
  });
  await expect(resolveDialog).toBeVisible();
  await resolveDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(own).toHaveAttribute("data-expanded", "true");

  // The symptom bar appears EXACTLY once (in the hero; #858 no-duplicate). The
  // unified "How are you today?" card (#992) stays up for the mood tap but its
  // illness branch defers to the hero — no second "Not feeling well?" affordance.
  await expect(page.getByTestId("symptom-log-bar")).toHaveCount(1);
  await expect(page.getByTestId("feeling-sick-activate")).toHaveCount(0);
  await expect(page.getByTestId("mood-episode-note")).toBeVisible();

  await page.context().close();
});

test("mobile: the illness hero is the first content block (the 7am case)", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SICK_SELF));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  const hero = page.getByTestId("illness-hero");
  await expect(hero).toBeVisible();
  const needs = page.getByTestId("needs-attention");
  await expect(needs).toBeVisible();

  // The hero sits ABOVE the Needs-attention hero at phone width — it leads the page.
  const heroBox = await hero.boundingBox();
  const needsBox = await needs.boundingBox();
  expect(heroBox).not.toBeNull();
  expect(needsBox).not.toBeNull();
  expect(heroBox!.y).toBeLessThan(needsBox!.y);

  await page.context().close();
});

test("below xl: the priority cards do not create horizontal page overflow", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SICK_SELF));
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.reload();

  await expect(page.getByTestId("illness-hero")).toBeVisible();
  await expect(page.getByTestId("needs-attention")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

  await page.context().close();
});

test("xl: illness and Needs attention share an equal-width priority row", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SICK_SELF));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();

  const hero = page.getByTestId("illness-hero");
  const needs = page.getByTestId("needs-attention");
  await expect(hero).toBeVisible();
  await expect(needs).toBeVisible();
  const heroBox = await hero.boundingBox();
  const needsBox = await needs.boundingBox();
  expect(heroBox).not.toBeNull();
  expect(needsBox).not.toBeNull();
  expect(Math.abs(heroBox!.width - needsBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(heroBox!.y - needsBox!.y)).toBeLessThanOrEqual(1);

  const own = hero.locator('[data-active="true"]');
  const toggle = own.locator('[data-testid^="illness-cockpit-toggle-"]');
  await expect(own).toHaveAttribute("data-expanded", "true");
  await expect(own.getByTestId("illness-cockpit-body")).toBeVisible();
  await expect(toggle).toBeDisabled();
  await expect(own.getByTestId("illness-cockpit-chevron")).toHaveCount(0);
  await expect(own.getByTestId("illness-cockpit-temperature")).toBeHidden();
  await expect(own.getByTestId("illness-cockpit-fever-status")).toBeHidden();
  await expect(own.getByTestId("episode-last-temperature")).toBeVisible();
  await expect(own.getByTestId("school-return-status")).toBeVisible();

  await page.context().close();
});

test("the acting profile's cockpit collapses to its status and the collapse persists", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SICK_COLLAPSE));
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.reload();
  const ownFor = () =>
    page.getByTestId("illness-hero").locator('[data-active="true"]');
  const toggleFor = () =>
    ownFor().locator('[data-testid^="illness-cockpit-toggle-"]');
  await expect(ownFor()).toBeVisible();

  // Drive the cockpit to a target collapse state and confirm it SURVIVES a reload (the
  // persistence claim). The toggle's save is a fire-and-forget server action, so the
  // reload-then-assert is wrapped in a retry: reload until the server-rendered state
  // reflects the persisted save. This is the sanctioned last-resort for an async write
  // (no networkidle/waitForTimeout). Idempotent — clicks only when the state must flip —
  // so a prior --repeat-each run's persisted state can't skew it.
  async function persistExpanded(want: "true" | "false") {
    await expect(async () => {
      if ((await ownFor().getAttribute("data-expanded")) !== want) {
        await settledClick(page, toggleFor());
      }
      await page.reload();
      await expect(ownFor()).toHaveAttribute("data-expanded", want, {
        timeout: 3_000,
      });
    }).toPass({ timeout: 25_000 }); // topass-ok: reload-until-persisted: confirm the async expand/collapse write survives a reload; no single event marks 'persisted AND reflected'
  }

  // Start from a known EXPANDED, persisted baseline (repeat-safe).
  await persistExpanded("true");
  await expect(
    ownFor().getByTestId("illness-cockpit-temperature")
  ).toBeHidden();
  await expect(
    ownFor().getByTestId("illness-cockpit-fever-status")
  ).toBeHidden();

  // Collapse to the compact status — the body (symptom bar) disappears immediately...
  await settledClick(
    page,
    ownFor().locator('[data-testid^="illness-cockpit-name-"]')
  );
  await expect(ownFor()).toHaveAttribute("data-expanded", "false");
  await expect(ownFor().getByTestId("symptom-log-bar")).toHaveCount(0);
  await expect(ownFor().getByTestId("illness-cockpit-day")).toContainText(
    /Day \d+/
  );
  const collapsedTemp = ownFor().getByTestId("illness-cockpit-temperature");
  await expect(collapsedTemp).toContainText("101.3 °F at 00:05");
  await expect(collapsedTemp).toContainText(
    /\((?:just now|\d+ (?:min|mins|hr|hrs) ago)\)/
  );
  await expect(collapsedTemp.locator("span")).toHaveClass(/text-rose-600/);
  await expect(
    ownFor().getByTestId("illness-cockpit-fever-status")
  ).toContainText(/Fever-free \d+h\/\d+h/i);
  await expect(
    ownFor().getByTestId("illness-cockpit-full-episode")
  ).toBeVisible();

  // ...and the collapse PERSISTS across a reload (stored per profile).
  await persistExpanded("false");
  await expect(ownFor().getByTestId("symptom-log-bar")).toHaveCount(0);

  // Restore expanded so the next --repeat-each run starts from the same baseline.
  await persistExpanded("true");

  await page.context().close();
});

// Locate one household member's accordion cockpit by the name on its header (no
// positional disambiguation — #534). `[data-active]` matches only cockpit containers.
function memberCockpit(page: Page, name: string) {
  return page
    .getByTestId("illness-hero")
    .locator("[data-active]")
    .filter({ hasText: name });
}

// Expand a cockpit idempotently — a prior --repeat-each run may have left its expansion
// persisted, so click only when it's collapsed (the toggle would otherwise close it).
async function ensureExpanded(
  page: Page,
  cockpit: ReturnType<typeof memberCockpit>
) {
  if ((await cockpit.getAttribute("data-expanded")) !== "true") {
    await settledClick(
      page,
      cockpit.locator('[data-testid^="illness-cockpit-toggle-"]')
    );
  }
  await expect(cockpit).toHaveAttribute("data-expanded", "true");
}

test("multi-sick: a caregiver logs a temperature for one child cross-profile without switching", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_CARE));

  // Acting as the well base profile — no own cockpit, two children as accordions.
  await expect(page.getByTestId("user-menu-trigger")).toContainText(
    "Care Parent"
  );
  const hero = page.getByTestId("illness-hero");
  await expect(hero).toBeVisible();
  await expect(hero.locator('[data-active="true"]')).toHaveCount(0);
  const kidA = memberCockpit(page, "Sick Kid A");
  const kidB = memberCockpit(page, "Sick Kid B");
  await expect(kidA).toHaveCount(1);
  await expect(kidB).toHaveCount(1);

  // Expand Kid A in place and log a temperature for HER — a cross-profile write.
  await ensureExpanded(page, kidA);

  const bar = kidA.getByTestId("symptom-log-bar");
  await openTempEntry(bar);
  await bar.getByTestId("temp-quick-input").fill("103.4");
  // An explicit reading time strictly LATER than the seeded 00:05 reading, so the logged
  // value is unambiguously the episode's latest temp regardless of the wall-clock the
  // suite runs at (avoids a just-after-midnight "now" losing to the seed reading).
  await bar.getByTestId("temp-quick-time").fill("12:00");
  await settledClick(page, bar.getByTestId("temp-quick-save"));

  // The reading landed on Kid A (her compact status reflects the new latest temp) and the
  // acting profile never switched.
  await expect(
    kidA.locator('[data-testid^="illness-cockpit-line-"]')
  ).toContainText("103.4");
  await expect(page.getByTestId("user-menu-trigger")).toContainText(
    "Care Parent"
  );

  await page.context().close();
});

test("co-caregiver: a dose one caregiver logs for the child shows on the other caregiver's hero", async ({
  browser,
}) => {
  // Caregiver A logs a PRN dose for Sick Kid A from the hero cockpit (cross-profile).
  const pageA = await loginAs(browser, creds(E2E_LOGIN_CARE));
  const kidA = memberCockpit(pageA, "Sick Kid A");
  await expect(kidA).toHaveCount(1);
  await ensureExpanded(pageA, kidA);
  await settledClick(pageA, kidA.getByTestId("prn-log-now"));
  // The dose registered — the redose window line now computes for the med.
  await expect(kidA.getByTestId("prn-redose-line")).toBeVisible();
  await pageA.context().close();

  // Caregiver B (a DIFFERENT login granted the same child) sees the dose on their hero —
  // the passive double-dose guard, no switching, no notification.
  const pageB = await loginAs(browser, creds(E2E_LOGIN_COCARE));
  const kidALine = memberCockpit(pageB, "Sick Kid A").locator(
    '[data-testid^="illness-cockpit-line-"]'
  );
  await expect(kidALine).toContainText(/ibuprofen/i);
  await pageB.context().close();
});
