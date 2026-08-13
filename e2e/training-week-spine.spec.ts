import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_WEEK_SPINE,
  E2E_MEMBER_PASSWORD,
  WEEK_SPINE_PROFILE,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Issue #2566, Viz 1 — the WEEK SPINE.
//
// Training → Overview's "This week" was two numbers, `Sessions 4` and `Days 3`: a
// tally with no shape, with which days and what kind of session nowhere on the card,
// and the routine's own state stranded in a second card in a second vocabulary. This
// spec pins the band that replaced it — seven day cells on the profile's own week
// window, one block per logged session colored by its type, today ringed, the caption
// stating the same counts the band draws, and the routine's cadence chips composed
// into the same card.
//
// READ-ONLY against a DEDICATED fixture profile (#868) whose week is hand-pinned; see
// e2e/logins/training.ts for its shape. Every expectation below is a LITERAL — the
// spec never asks `buildWeekSpine` what it should have drawn.

interface SeededSession {
  date: string;
  type: string;
}

// The fixture's own rows, straight out of the table. This reads the FIXTURE (which
// profile-local day each seeded session landed on), never the code under test — the
// spine's job is to place those days on the band, and that placement is what is
// asserted.
function seededSessions(): SeededSession[] {
  const db = new Database(workerDbPath(), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT a.date, a.type FROM activities a
           JOIN profiles p ON p.id = a.profile_id
          WHERE p.name = ? AND a.external_id LIKE 'e2e:week-spine-%'
          ORDER BY a.date, a.id`
      )
      .all(WEEK_SPINE_PROFILE) as SeededSession[];
  } finally {
    db.close();
  }
}

test("the week spine draws seven days, blocks by type, and a caption that matches", async ({
  browser,
}) => {
  test.slow(); // local `next dev` compiles /training on first hit
  const rows = seededSessions();
  // 5 in-window sessions + the two out-of-window decoys.
  expect(rows).toHaveLength(7);
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  // Oldest first: −8 (decoy), −4, −3, −1, today, +1 (decoy).
  expect(dates).toHaveLength(6);
  const [
    beforeWindow,
    sportDay,
    mobilityDay,
    cardioDay,
    todayDay,
    afterWindow,
  ] = dates;

  const page = await loginAs(browser, {
    username: E2E_LOGIN_WEEK_SPINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    const card = page.getByTestId("training-week");
    await expect(card).toBeVisible();
    const spine = card.getByTestId("week-spine");
    await expect(spine).toBeVisible();

    // Seven cells, always — the band is a week, not a variable-length window.
    const days = spine.getByTestId("week-spine-day");
    await expect(days).toHaveCount(7);

    // The fixture is in ROLLING week mode, so the window ends on today: the last cell
    // is today (ringed), and no cell is "ahead".
    const todayCell = spine.locator(`[data-date="${todayDay}"]`);
    await expect(todayCell).toHaveAttribute("data-state", "today");
    await expect(days.nth(6)).toHaveAttribute("data-date", todayDay);
    await expect(spine.locator('[data-state="ahead"]')).toHaveCount(0);
    await expect(spine.locator('[data-state="past"]')).toHaveCount(6);

    // Today logged TWO strength sessions — two blocks, both strength.
    await expect(todayCell).toHaveAttribute("data-sessions", "2");
    const todayBlocks = todayCell.getByTestId("week-spine-block");
    await expect(todayBlocks).toHaveCount(2);
    await expect(todayBlocks.nth(0)).toHaveAttribute("data-type", "strength");
    await expect(todayBlocks.nth(1)).toHaveAttribute("data-type", "strength");

    // …and each of the three earlier days carries exactly its own one type.
    for (const [date, type] of [
      [cardioDay, "cardio"],
      [mobilityDay, "recovery"],
      [sportDay, "sport"],
    ] as const) {
      const cell = spine.locator(`[data-date="${date}"]`);
      await expect(cell).toHaveAttribute("data-sessions", "1");
      const blocks = cell.getByTestId("week-spine-block");
      await expect(blocks).toHaveCount(1);
      await expect(blocks).toHaveAttribute("data-type", type);
    }

    // The two decoys are outside the window at both ends and reach NO cell — a
    // session logged last week, and a run dated tomorrow, are not this week.
    await expect(spine.locator(`[data-date="${beforeWindow}"]`)).toHaveCount(0);
    await expect(spine.locator(`[data-date="${afterWindow}"]`)).toHaveCount(0);

    // The caption states the same week the band draws — 2 + 1 + 1 + 1 sessions across
    // four distinct days. A pinned string, not a recomputation.
    await expect(spine.getByTestId("week-spine-caption")).toHaveText(
      "5 sessions on 4 days this week"
    );

    // The legend names only the types this week actually contains, in the declared
    // ACTIVITY_TYPES order — and `recovery` is called mobility, the app's own word.
    const legend = spine.getByTestId("week-spine-legend-item");
    await expect(legend).toHaveCount(4);
    await expect(legend).toHaveText([
      "strength",
      "cardio",
      "sport",
      "mobility",
    ]);

    // Composed, not stacked: the weekly routine lives in the SAME card as the band,
    // and the two-number tile it replaced is gone.
    await expect(
      card.getByText("Weekly routine", { exact: true })
    ).toBeVisible();
    await expect(card.getByText("Sessions", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Days", { exact: true })).toHaveCount(0);
  } finally {
    await page.close();
  }
});

test("an empty day states its emptiness rather than a miss", async ({
  browser,
}) => {
  const rows = seededSessions();
  const logged = new Set(rows.map((r) => r.date));

  const page = await loginAs(browser, {
    username: E2E_LOGIN_WEEK_SPINE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=overview");
    const spine = page.getByTestId("week-spine");
    await expect(spine).toBeVisible();

    // Three of the seven days have nothing on them. Each carries an accessible name
    // that says so — "nothing logged", never a verdict — and zero blocks.
    const empty = spine.locator('[data-sessions="0"]');
    await expect(empty).toHaveCount(3);
    const emptyDates = await empty.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-date"))
    );
    for (const date of emptyDates) {
      expect(logged.has(date!)).toBe(false);
      await expect(spine.locator(`[data-date="${date}"]`)).toHaveAttribute(
        "aria-label",
        `${date} — nothing logged`
      );
    }
    await expect(empty.getByTestId("week-spine-block")).toHaveCount(0);
  } finally {
    await page.close();
  }
});
