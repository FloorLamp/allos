import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick, settledCheck } from "./helpers";
import { E2E_LOGIN_NWAY, NWAY_PROFILE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { seedNwayMergeFixture } from "./nway-merge-fixture";

// Issue #1081 — N-way activity duplicate merge on BOTH surfaces, on a DEDICATED member
// profile (#868), re-seeded per test so a --repeat-each iteration always starts from
// the unmerged state (both merges CONSUME their rows). Two independent same-day groups:
// a 3-row cross-source cluster for Data → Review, and a 3-row same-day group for the
// Journal multi-select merge.

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

// A date `days` before the frozen clock's real-start today (UTC is close enough — the
// margin keeps the Journal group on the feed's first-page window regardless of a ≤1-day
// timezone skew).
function isoBack(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const REVIEW_DATE = isoBack(3);
const JOURNAL_DATE = isoBack(2);

function nwayProfileId(db: Database.Database): number {
  return (
    db.prepare("SELECT id FROM profiles WHERE name = ?").get(NWAY_PROFILE) as {
      id: number;
    }
  ).id;
}

test.describe("N-way activity merge (#1081)", () => {
  test.beforeEach(() => {
    const db = new Database(DB_PATH);
    try {
      db.pragma("busy_timeout = 5000");
      seedNwayMergeFixture(db, nwayProfileId(db), REVIEW_DATE, JOURNAL_DATE);
    } finally {
      db.close();
    }
  });

  test("Data → Review: a 3-row cluster collapses in one action to a chosen non-default keeper", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_NWAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/data?section=review");
      const review = page.getByTestId("review-inbox");

      // The three overlapping cross-source rows surface as ONE cluster card (not
      // C(3,2)=3 pair cards).
      const cluster = review.getByTestId("dup-activity-cluster");
      await expect(cluster).toHaveCount(1);
      await expect(cluster.getByTestId("dup-cluster-member")).toHaveCount(3);
      await expect(cluster.getByText("3 copies")).toBeVisible();

      // Choose a NON-default keeper: the manual row (the default is the sourced Strava
      // row). Then one "Merge 3 into keeper" click collapses the whole group.
      await settledCheck(
        page,
        cluster.getByRole("radio", { name: "Keep NW review manual" }),
        true
      );
      await settledClick(page, cluster.getByTestId("dup-cluster-merge"));

      // The cluster is resolved — no duplicate card remains.
      await expect(review.getByTestId("dup-activity-cluster")).toHaveCount(0);

      // Only the chosen keeper survives on the feed; the other two are actually gone
      // (rollups count the session once).
      await page.goto("/training");
      await expect(page.getByText("NW review manual").first()).toBeVisible(); // first-ok: the chosen keeper after the merge THIS test performed on its own fixture profile — deterministic
      await expect(page.getByText("NW review strava")).toHaveCount(0);
      await expect(page.getByText("NW review hc")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Journal: multi-select with a sibling keeper absorbs the originating card, and undo restores all", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_NWAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/training"); // default "Log" tab renders the Journal feed

      const cardEl = page
        .locator('[id^="activity-"]')
        .filter({ hasText: "NW card" });
      await expect(cardEl).toHaveCount(1);
      await expect(page.getByText("NW sib A")).toBeVisible();
      await expect(page.getByText("NW sib B")).toBeVisible();

      // Scroll the card to the top so the (taller) downward overflow menu — checkboxes
      // + keeper select + Merge button — has full room below the trigger.
      await cardEl.evaluate((el) => el.scrollIntoView({ block: "start" }));
      // Open the originating card's overflow menu → "Merge with…" → switch to the
      // multi-select / keeper-select mode.
      await cardEl.getByRole("button", { name: "Activity actions" }).click();
      await page.getByTestId("merge-with").click();
      await page.getByTestId("merge-multi-toggle").click();

      const picker = page.getByTestId("merge-picker");
      // Combine sibling B, and choose "NW sib A" as the KEEPER (a sibling) via the
      // keeper select — which makes the originating card itself a drop (choosing a
      // sibling keeper also includes it).
      await settledCheck(
        page,
        picker
          .getByTestId("merge-target")
          .filter({ hasText: "NW sib B" })
          .getByTestId("merge-target-check"),
        true
      );
      await page
        .getByTestId("merge-keeper-select")
        .selectOption({ label: "NW sib A" });
      await settledClick(page, page.getByTestId("merge-run"));

      // The sibling keeper remains; the originating card and the other sibling are gone.
      await expect(page.getByText("NW card")).toHaveCount(0);
      await expect(page.getByText("NW sib B")).toHaveCount(0);
      await expect(page.getByText("NW sib A")).toBeVisible();

      // One undo toast reverses the entire N-way merge.
      await expect(page.getByText("Activities merged.")).toBeVisible();
      await settledClick(page, page.getByRole("button", { name: "Undo" }));
      await expect(page.getByText("Restored.")).toBeVisible();

      // Reload for a deterministic server render: every dropped row is back, incl. the
      // originating card that was absorbed by the sibling keeper.
      await page.reload();
      await expect(page.getByText("NW card")).toBeVisible();
      await expect(page.getByText("NW sib B")).toBeVisible();
      await expect(page.getByText("NW sib A")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
});
