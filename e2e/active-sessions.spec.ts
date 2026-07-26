import { test, expect } from "@playwright/test";
import { hydratedClick } from "./helpers";

// The Active sessions list on Settings → Account & security (#1451.A).
//
// What was wrong: the card rendered each session's RAW user-agent, truncated — so
// every row on the same OS read the identical "Mozilla/5.0 (X11; Linux x…", 22 of
// them uncollapsed, ~2,000px tall on a phone, with per-row "Revoke" buttons you
// could only pick between by timestamp. The fix has four parts, three of which are
// structural and asserted here (the fourth, the "Chrome · Linux" parsing itself, is
// unit-tested in lib/__tests__/user-agent-label.test.ts over real UA strings).
//
// READ-ONLY: this spec never revokes a session, so it can't disturb the shared
// storageState the rest of the suite runs on.
test.describe("Active sessions list (#1451.A)", () => {
  test("rows carry a parsed device label, not a truncated raw user-agent", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/account");
    const card = page.getByTestId("active-sessions");
    await expect(card).toBeVisible();

    const rows = card.getByTestId("session-row");
    await expect(rows.first()).toBeVisible(); // first-ok: spec-owned assertion that the list renders at all
    const labels = await card.getByTestId("session-device").allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      // The whole point: a row is identified by a short device label, never by the
      // raw UA the old card printed.
      expect(label).not.toMatch(/^Mozilla\/5\.0/);
      expect(label.length).toBeLessThan(40);
    }

    // The current session is still marked and still un-revokable from here.
    await expect(card.getByText("This device")).toBeVisible();
  });

  test("'Sign out everywhere else' sits above the list, and the list collapses past a handful", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/account");
    const card = page.getByTestId("active-sessions");
    await expect(card).toBeVisible();

    // The bulk action is the one you reach for when the list is long, so it belongs
    // ABOVE the rows rather than buried under them. It only renders when there IS
    // another session to sign out.
    const bulk = card.getByRole("button", { name: "Sign out everywhere else" });
    const rows = card.getByTestId("session-row");
    if ((await bulk.count()) > 0) {
      const bulkBox = await bulk.boundingBox();
      const firstRowBox = await rows.first().boundingBox(); // first-ok: comparing the bulk control against the topmost row is the assertion
      expect(bulkBox).not.toBeNull();
      expect(firstRowBox).not.toBeNull();
      expect(bulkBox!.y).toBeLessThan(firstRowBox!.y);
    }

    // Collapse rule: at most five rows are shown until "Show all N" is used. Asserted
    // in both directions so it holds whatever the fixture DB's session count is.
    const shown = await rows.count();
    const showAll = card.getByTestId("sessions-show-all");
    if ((await showAll.count()) === 0) {
      expect(shown).toBeLessThanOrEqual(5);
    } else {
      expect(shown).toBe(5);
      const label = await showAll.innerText();
      const total = Number(label.replace(/\D+/g, ""));
      expect(total).toBeGreaterThan(5);
      await hydratedClick(page, showAll);
      await expect(rows).toHaveCount(total);
      // …and it collapses back.
      await hydratedClick(page, card.getByTestId("sessions-show-all"));
      await expect(rows).toHaveCount(5);
    }
  });
});
