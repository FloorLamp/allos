import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { E2E_LOGIN_DUP, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { CONTROL_BOX_PX } from "@/lib/tap-floor-tokens";

const DB_PATH = workerDbPath();

// Duplicate-review candidate disambiguation (issue #531). seed-events plants ONE
// same-source duplicate on a dedicated profile: two manual weigh-ins on one day,
// both labelled "Manual entry". Labelling the merge/keep buttons by source alone
// would render "Merge, keep Manual entry" / "Keep Manual entry instead" — the two
// actions indistinguishable. The fix falls back to A/B with an on-card badge. We
// assert the badges + A/B button labels; this spec never merges, so the isolated
// member session's fixture is untouched.
test.describe("Duplicate review disambiguation (#531)", () => {
  test("labels a same-source pair A/B with on-card badges", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DUP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/data?section=review");
      const review = page.getByTestId("review-inbox");
      // Scope to the two-manual-weigh-ins day this test owns — the same fixture
      // profile also carries a cross-source day for #1615.
      const pair = review
        .getByTestId("dup-body-metric-pair")
        .filter({ hasText: "2026-06-15" });
      await expect(pair).toHaveCount(1);

      // Both candidate cards carry an A/B badge (the on-element referent, correct
      // in the stacked and side-by-side layouts alike).
      const badges = pair.getByTestId("dup-candidate-badge");
      await expect(badges).toHaveCount(2);
      await expect(badges.nth(0)).toHaveText("A");
      await expect(badges.nth(1)).toHaveText("B");

      // The buttons reference the badge, not the collapsed source label.
      await expect(
        pair.getByRole("button", { name: /Merge, keep A\b/ })
      ).toBeVisible();
      await expect(
        pair.getByRole("button", { name: /Keep B instead/ })
      ).toBeVisible();
      // The old collapsed label must not appear on a button.
      await expect(
        pair.getByRole("button", { name: /keep Manual entry/i })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("an exact-equal cross-source day is absent while a disagreeing one still renders (#1615)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DUP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/data?section=review");
      const review = page.getByTestId("review-inbox");
      const pairs = review.getByTestId("dup-body-metric-pair");

      // 2026-06-16: Health Connect and Oura both recorded 55 bpm. That is normal
      // multi-source storage (#14), not an unresolved conflict — nothing to decide,
      // and merging would discard one source's provenance. It must not be here.
      await expect(pairs.filter({ hasText: "2026-06-16" })).toHaveCount(0);

      // 2026-06-17: the same two sources disagree (55 vs 56), which IS reviewable —
      // and the card names the measure and both sources.
      const disagreeing = pairs.filter({ hasText: "2026-06-17" });
      await expect(disagreeing).toHaveCount(1);
      await expect(
        disagreeing.getByText("Same-day resting HR from two rows")
      ).toBeVisible();
      // Both source labels and both readings are on the card (each label also
      // appears on its merge button, so assert containment rather than a node).
      await expect(disagreeing).toContainText("Google Health Connect");
      await expect(disagreeing).toContainText("Oura Ring");
      await expect(disagreeing).toContainText("55 bpm");
      await expect(disagreeing).toContainText("56 bpm");

      // And BOTH rows of the agreeing day are still stored, unedited — the fix
      // suppresses the Review card, it never auto-merges away a source.
      const db = new Database(DB_PATH, { readonly: true });
      try {
        db.pragma("busy_timeout = 5000");
        const rows = db
          .prepare(
            `SELECT source, edited FROM body_metrics
               WHERE date = '2026-06-16' AND resting_hr = 55
               ORDER BY source`
          )
          .all() as { source: string; edited: number | null }[];
        expect(rows.map((r) => r.source)).toEqual(["health-connect", "oura"]);
        expect(rows.every((r) => !r.edited)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      await page.context().close();
    }
  });
});

test.describe("duplicate resolution actions at phone width (#3747)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("renders every pair action at the shared floor and wraps inside its card", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_DUP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/data?section=review");
      const pair = page
        .getByTestId("dup-body-metric-pair")
        .filter({ hasText: "2026-06-15" });
      await expect(pair).toHaveCount(1);

      const actions = pair.getByTestId("duplicate-resolution-actions");
      await expect(actions).toBeVisible();
      const buttons = actions.getByRole("button");
      await expect(buttons).toHaveCount(4);

      const boxes = await buttons.evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            height: box.height,
          };
        })
      );
      const cardBox = await pair.boundingBox();
      expect(cardBox).not.toBeNull();
      for (const box of boxes) {
        // The one control box (#3938) — the 44 is effective now, supplied by the
        // reach a coarse pointer gets around it, which this run does not have.
        expect(box.height).toBeGreaterThanOrEqual(CONTROL_BOX_PX);
        expect(box.left).toBeGreaterThanOrEqual(cardBox!.x);
        expect(box.right).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
      }
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          const first = boxes[a];
          const second = boxes[b];
          expect(
            first.right <= second.left ||
              second.right <= first.left ||
              first.bottom <= second.top ||
              second.bottom <= first.top
          ).toBe(true);
          expect(
            Math.max(
              second.left - first.right,
              first.left - second.right,
              second.top - first.bottom,
              first.top - second.bottom
            )
          ).toBeGreaterThanOrEqual(7);
        }
      }
      expect(
        await actions.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      ).toBe(true);

      const primary = buttons.nth(0);
      const alternate = buttons.nth(1);
      await primary.focus();
      await page.keyboard.press("Tab");
      await expect(alternate).toBeFocused();
      expect(
        await alternate.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            style.boxShadow !== "none" ||
            (style.outlineStyle !== "none" &&
              Number.parseFloat(style.outlineWidth) > 0)
          );
        })
      ).toBe(true);
    } finally {
      await page.context().close();
    }
  });
});
