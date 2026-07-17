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

  const hero = page.getByTestId("illness-hero");
  await expect(hero).toBeVisible();

  // The acting profile's own cockpit (data-active="true"), expanded by default, with the
  // one-tap symptom bar inside it.
  const own = hero.locator('[data-active="true"]');
  await expect(own).toHaveCount(1);
  await expect(own).toHaveAttribute("data-expanded", "true");
  await expect(own.getByTestId("symptom-log-bar")).toBeVisible();

  // The symptom bar appears EXACTLY once (the widget slot renders nothing while the hero
  // is up) and the inactive-state "Feeling sick?" card is gone (#858 no-duplicate).
  await expect(page.getByTestId("symptom-log-bar")).toHaveCount(1);
  await expect(page.getByTestId("feeling-sick-card")).toHaveCount(0);

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

test("the acting profile's cockpit collapses to its headline and the collapse persists", async ({
  browser,
}) => {
  const page = await loginAs(browser, creds(E2E_LOGIN_SICK_COLLAPSE));
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
    }).toPass({ timeout: 25_000 });
  }

  // Start from a known EXPANDED, persisted baseline (repeat-safe).
  await persistExpanded("true");

  // Collapse to the one-line headline — the body (symptom bar) disappears immediately...
  await settledClick(page, toggleFor());
  await expect(ownFor()).toHaveAttribute("data-expanded", "false");
  await expect(ownFor().getByTestId("symptom-log-bar")).toHaveCount(0);

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

  // The reading landed on Kid A (her headline reflects the new latest temp) and the
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
