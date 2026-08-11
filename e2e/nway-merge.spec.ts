import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { hydratedClick, settledClick, settledCheck } from "./helpers";
import {
  E2E_LOGIN_NWAY,
  NWAY_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { seedNwayMergeFixture } from "./nway-merge-fixture";
import { workerDbPath, frozenNow } from "./worker-env";

// Issue #1081 — N-way activity duplicate merge on BOTH surfaces, plus the #1431
// per-field conflict picker, on a DEDICATED member profile (#868), re-seeded per
// test so a --repeat-each iteration always starts from the unmerged state (the
// merges CONSUME their rows). Three independent same-day groups: a 3-row
// cross-source cluster for Data → Review, a 3-row cross-source cluster with a
// material DISTANCE conflict for the picker, and a 3-row same-day group for the
// Training Log multi-select merge.

const DB_PATH = workerDbPath();

// A date `days` before the frozen clock's real-start today (UTC is close enough — the
// margin keeps the Training Log group on the feed's first-page window regardless of a ≤1-day
// timezone skew).
function isoBack(days: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const REVIEW_DATE = isoBack(3);
const TRAINING_LOG_DATE = isoBack(2);
const CONFLICT_DATE = isoBack(4);

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
      seedNwayMergeFixture(
        db,
        nwayProfileId(db),
        REVIEW_DATE,
        TRAINING_LOG_DATE,
        CONFLICT_DATE
      );
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
      // C(3,2)=3 pair cards). Scoped by title: the fixture profile also carries the
      // #1431 conflict cluster on its own day.
      const cluster = review
        .getByTestId("dup-activity-cluster")
        .filter({ hasText: "NW review manual" });
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

      // The cluster is resolved — THIS cluster's card leaves the inbox (the #1431
      // conflict cluster on its own day is untouched by this test).
      await expect(cluster).toHaveCount(0);

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

  test("Review cluster: the per-field picker lands a non-keeper's distance (#1431)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_NWAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/data?section=review");
      const review = page.getByTestId("review-inbox");
      const cluster = review
        .getByTestId("dup-activity-cluster")
        .filter({ hasText: "NW conf manual" });
      await expect(cluster).toHaveCount(1);

      // Merging a materially-conflicting cluster opens the SHARED picker instead
      // of a silent keeper-wins fold. Distances disagree (5/8/12 km), durations
      // agree — so distance is the one surfaced conflict.
      // NOT settledClick, and this is the one control in the failing set whose
      // behaviour depends on its DATA: onMergeClick posts the merge outright for a
      // clean cluster (the sibling test above), but a cluster with conflicts only
      // opens the picker client-side. The write is the confirm below.
      await hydratedClick(page, cluster.getByTestId("dup-cluster-merge"));
      const dialog = page.getByTestId("merge-conflict-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId("conflict-distance_km")).toBeVisible();
      await expect(dialog.getByTestId("conflict-duration_min")).toHaveCount(0);

      // A radio across ALL THREE members' values, pre-selected to the default
      // keeper's (the Strava row — sourced + richest).
      await expect(
        dialog.getByRole("radio", { name: "Keep Distance from Strava" })
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        dialog.getByRole("radio", {
          name: "Use Distance from Google Health Connect",
        })
      ).toBeVisible();

      // Pick the NON-keeper Manual distance (5 km) and merge.
      // The radio only writes MergeConflictDialog's local `choices`; the merge
      // POST comes from the confirm below. aria-checked is this click's signal.
      const manual = dialog.getByRole("radio", {
        name: "Use Distance from Manual entry",
      });
      await hydratedClick(page, manual);
      await expect(manual).toHaveAttribute("aria-checked", "true");
      await settledClick(page, dialog.getByTestId("merge-conflict-confirm"));
      await expect(cluster).toHaveCount(0);

      // The surviving keeper is the Strava row carrying the CHOSEN distance —
      // the manual row's 5 km, not its own 8 — proven against the DB. The two
      // absorbed members are actually gone.
      const db = new Database(DB_PATH);
      try {
        db.pragma("busy_timeout = 5000");
        const profileId = nwayProfileId(db);
        const keeper = db
          .prepare(
            "SELECT title, distance_km FROM activities WHERE profile_id = ? AND external_id = 'strava:nwc-1'"
          )
          .get(profileId) as { title: string; distance_km: number };
        expect(keeper.title).toBe("NW conf strava");
        expect(keeper.distance_km).toBe(5);
        const absorbed = db
          .prepare(
            "SELECT COUNT(*) c FROM activities WHERE profile_id = ? AND title IN ('NW conf manual', 'NW conf hc')"
          )
          .get(profileId) as { c: number };
        expect(absorbed.c).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await page.context().close();
    }
  });

  test("Training Log: multi-select with a sibling keeper absorbs the originating card, and undo restores all", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_NWAY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/training"); // default "Log" tab renders the Training Log feed

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
