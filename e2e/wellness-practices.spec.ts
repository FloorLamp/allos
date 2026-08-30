import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  dismissToast,
  expectNoClippedContent,
  followLink,
  hydratedClick,
  settledBoxes,
  settledClick,
  settledFill,
} from "./helpers";
import { loginAs, openCommandPalette } from "./nav";
import {
  E2E_LOGIN_PRACTICE_ZERO,
  E2E_MEMBER_PASSWORD,
  PRACTICE_ZERO_PROFILE,
} from "./fixture-logins";
import { frozenNow, workerDbPath } from "./worker-env";
import { practiceIdentity } from "@/lib/practice";

async function openPracticeCreate(page: Page) {
  await page.getByTestId("practice-create-trigger").click();
  const form = page.getByTestId("practice-create-form");
  await expect(form).toBeVisible();
  return form;
}

// Open one of these rows' ⋯ menus, then click an item in it (#2632).
//
// Both halves were missing, and each hid the other:
//
//  • The trigger is an OverflowMenu toggle whose `onClick` exists only once React
//    has hydrated the card, so a raw `.click()` inside the #500/#830 window is
//    SWALLOWED. That is decision-tree case 3's `hydratedClick` sub-case — the shape
//    every other overflow-menu spec in this suite already uses. A retry loop is not
//    available here: a second tap on a toggle closes what the first opened, which
//    is the whole reason hydratedClick exists.
//  • The item lives in a portal mounted only while the menu is OPEN, so waiting on
//    the ITEM cannot distinguish "the menu never opened" from "the item is slow" —
//    both read as one 30s `waiting for getByTestId(...)` with no actionability
//    lines after it, which is exactly what CI reported. Waiting on the menu's open
//    state first makes a swallowed toggle fail as a swallowed toggle.
async function openRowMenu(page: Page, trigger: Locator) {
  await hydratedClick(page, trigger);
  // The panel is portaled to <body>, so it is reached from the page, not the row.
  await expect(page.getByRole("menu")).toBeVisible();
}

async function choosePracticeAction(
  page: Page,
  card: Locator,
  actionTestId: string
) {
  await openRowMenu(
    page,
    card.getByTestId("wellness-practice-actions").getByRole("button")
  );
  await page.getByTestId(actionTestId).click();
}

test("a relevant Wellness profile can reach its practice home from nav (#1620)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Profile 1's seed has both a practice target and session history. Enter through
  // the actual sidebar rather than page.goto("/wellness"), so dropping the
  // relevance-gated registration cannot leave the empty/create surface stranded.
  await page.goto("/");
  // #3079 demoted Wellness from a top-level row to a child of "Plan & review", so
  // the sidebar path is now one disclosure longer. Walking that longer path is
  // exactly what this case is for: it is the claim that dropping the row did not
  // strand the practice home behind chrome nobody can open.
  const sidebar = page.locator("aside nav");
  await sidebar.getByRole("button", { name: "Plan & review" }).click();
  const wellness = sidebar.getByRole("link", {
    name: "Wellness",
    exact: true,
  });
  await expect(wellness).toBeVisible();
  await followLink(page, wellness, /\/wellness$/);
  await expect(
    page.getByRole("main").getByRole("heading", { name: "Wellness" })
  ).toBeVisible();
  const wellnessPage = page.getByTestId("wellness-page");
  const bounds = await wellnessPage.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeLessThanOrEqual(768);

  // Creation stays out of the reading flow until requested. Its modal combobox
  // must still paint above the page and modal surfaces.
  const create = await openPracticeCreate(page);
  await create.getByLabel("Practice").focus();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const listboxBounds = await listbox.boundingBox();
  expect(listboxBounds).not.toBeNull();
  const listboxIsTopmost = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest('[role="listbox"]')
        ?.getAttribute("role") === "listbox",
    {
      x: listboxBounds!.x + listboxBounds!.width / 2,
      y: listboxBounds!.y + listboxBounds!.height - 4,
    }
  );
  expect(listboxIsTopmost).toBe(true);
  // Escape dismisses the nested picker first, preserving the parent modal and
  // its typed state. A second Escape closes the modal itself.
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(create).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);

  // Long histories start compact, can expand in place, and retain an accessible
  // row action in the phone layout without a horizontal table swipe.
  const seededCard = page
    .getByTestId("wellness-practice-card")
    .filter({ hasText: "Red light therapy" });
  const practiceCards = page.getByTestId("wellness-practice-card");
  await expect(page.getByTestId("practice-heatmap")).toHaveCount(
    await practiceCards.count()
  );
  await expect(
    seededCard
      .getByTestId("practice-heatmap")
      .locator('[data-count]:not([data-count="0"])')
  ).not.toHaveCount(0);
  const history = seededCard.getByTestId("practice-session-history");
  await expect(history.locator("tbody tr")).toHaveCount(5);
  const toggle = history.getByTestId("practice-session-toggle");
  await expect(toggle).toHaveText(/View all \d+ sessions/);
  await toggle.click();
  expect(await history.locator("tbody tr").count()).toBeGreaterThan(5);
  await history.getByRole("button", { name: "Show fewer sessions" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const rowAction = history
    .locator("tbody tr")
    .first() // first-ok: asserts the responsive shape of any visible session row, not its fixture identity
    .getByRole("button", { name: "Session actions" });
  const emptyNotes = history
    .locator("tbody tr")
    .first() // first-ok: asserts the responsive shape of any visible session row, not its fixture identity
    .locator("td:not([data-card])", { hasText: "—" });
  await expect(emptyNotes).toBeHidden();
  await expect(rowAction).toBeVisible();
  const actionBounds = await rowAction.boundingBox();
  expect(actionBounds).not.toBeNull();
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(390);
});

// THE ZERO STATE (#3066). Every other test in this file runs on a profile that
// already tracks practices — which is exactly how the defect survived: the #1620 nav
// gate hides /wellness until practice state exists (right, for an empty ledger), and
// the ONE creation path was on the hidden page, so a profile in this state could
// reach practices only by typing the URL.
//
// Dedicated fixture (#868) whose whole content is an absence, and the test removes
// the practice it creates, so --repeat-each stays clean.
test("with nothing tracked, the always-visible quick-log row offers the first practice (#3066)", async ({
  browser,
}) => {
  test.slow(); // a sign-in, two palette opens and a Server-Action create
  const practiceName = `E2E First Practice ${frozenNow().getTime()}`;
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRACTICE_ZERO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // The gate, observed rather than assumed. EXPAND THE GROUP FIRST (#3079):
    // Wellness is a child of "Plan & review", collapsed on "/", so this absence
    // would read as a pass whether the gate worked or not — the ungated Timeline
    // sibling proves the expansion actually happened.
    await page.goto("/");
    const sidebarNav = page.locator("aside nav");
    await sidebarNav.getByRole("button", { name: "Plan & review" }).click();
    await expect(
      sidebarNav.getByRole("link", { name: "History" })
    ).toBeVisible();
    await expect(
      sidebarNav.getByRole("link", { name: "Wellness", exact: true })
    ).toHaveCount(0);

    // The door, at PHONE width — the width the quick-log sheet is designed for and
    // the one a first-capture offer has to survive.
    await page.setViewportSize({ width: 390, height: 844 });
    const input = await openCommandPalette(page);
    await input.fill("practice");
    await page.getByTestId("palette-action-wellness-practices").click();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "practice"
    );
    const offer = page.getByTestId("quick-entry-practice-empty");
    await expect(offer).toBeVisible();
    const create = offer.getByTestId("practice-create-form");
    await expect(create).toBeVisible();
    await expectNoClippedContent(page);

    await settledFill(page, create.getByLabel("Practice"), practiceName);
    await settledClick(page, create.getByRole("button", { name: "Save" }));
    // Declaring a practice is a transaction with an end, so the sheet closes.
    await expect(page.getByTestId("quick-entry-sheet")).toBeHidden();
    await dismissToast(page, "Practice added");

    // The gate's own rule, unchanged, now answers the other way — and the sheet row
    // has become the log list it always promised.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await sidebarNav.getByRole("button", { name: "Plan & review" }).click();
    await expect(
      sidebarNav.getByRole("link", { name: "Wellness", exact: true })
    ).toBeVisible();
    const reopened = await openCommandPalette(page);
    await reopened.fill("practice");
    await page.getByTestId("palette-action-wellness-practices").click();
    await expect(page.getByTestId("quick-entry-practice-list")).toBeVisible();
    await expect(page.getByTestId("quick-entry-practice-empty")).toHaveCount(0);
  } finally {
    const handle = new Database(workerDbPath());
    handle.pragma("busy_timeout = 5000");
    try {
      handle
        .prepare(
          `DELETE FROM frequency_targets
            WHERE scope_kind = 'practice'
              AND profile_id IN (SELECT id FROM profiles WHERE name = ?)`
        )
        .run(PRACTICE_ZERO_PROFILE);
    } finally {
      handle.close();
    }
    await page.context().close();
  }
});

test("the command palette opens the practice overlay in place; the deep link keeps the first-practice path (#1620/#2184)", async ({
  page,
}) => {
  await page.goto("/");
  const dashboardUrl = page.url();
  const input = await openCommandPalette(page);
  // Findable by the domain word even though the label is now the sheet row's
  // ("Log practice") — the #2184 drift fix must not cost #1620's findability.
  await input.fill("wellness");
  const action = page.getByTestId("palette-action-wellness-practices");
  await expect(action).toBeVisible();
  await expect(action).toContainText("Log practice");
  await action.click();
  // The SAME overlay the quick-log sheet's row opens, IN PLACE: same form key,
  // same practice list, URL untouched — no more hard navigation mid-whatever.
  await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
  await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
    "data-form",
    "practice"
  );
  await expect(page.getByTestId("quick-entry-practice-list")).toBeVisible();
  expect(page.url()).toBe(dashboardUrl);
  await page.keyboard.press("Escape");

  // The /wellness?new=1 deep link is untouched (#2184 removes nothing): it still
  // lands on the page with the create form focused — the first-practice creation
  // path for a profile with nothing tracked yet.
  await page.goto("/wellness?new=1");
  await expect(
    page.getByTestId("practice-create-form").getByLabel("Practice")
  ).toBeFocused();
});

test("practice edits reject invalid cadence and logs-only name collisions (#1618/#1619)", async ({
  page,
}) => {
  // This test is about EDITS. Its two subjects — a tracked practice with a min/max
  // cadence and a logs-only practice to collide with — are seeded straight into the
  // worker DB (#868 spec-owned fixtures), not built through the UI.
  //
  // It used to drive two full create round-trips plus a page reload plus an untrack
  // as setup, and that setup is what kept failing: a 5s post-create ceiling became
  // 20s, then 45s, then needed test.slow() to make the 45s reachable at all, and
  // still exhausted it on shard 4 against diffs that cannot touch wellness (#1901).
  // Seeding makes the setup deterministic and free. Nothing is lost: the create path
  // is covered by the palette test above, and untrack/delete by the lifecycle test
  // below.
  const suffix = frozenNow().getTime();
  const trackedName = `E2E Cadence ${suffix}`;
  const historyName = `E2E History ${suffix}`;
  const today = frozenNow().toISOString().slice(0, 10);

  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  let trackedTargetId = 0;
  try {
    trackedTargetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max)
           VALUES (1, 'practice', ?, ?, 3, 5)`
        )
        .run(trackedName, practiceIdentity(trackedName)).lastInsertRowid
    );
    const logSession = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date) VALUES (1, ?, ?)`
    );
    // One session today for the tracked practice ("1 day this week", "1 session");
    // two for the logs-only one ("2 sessions"). Today is in the current week under
    // any week mode, so neither count depends on the week boundary. A logs-only
    // practice is exactly sessions with no frequency_targets row — the collision
    // check reads the union of both stores.
    logSession.run(trackedName, today);
    logSession.run(historyName, today);
    logSession.run(historyName, today);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/wellness");
    const main = page.getByRole("main");
    const trackedCard = main
      .getByTestId("wellness-practice-card")
      .filter({ hasText: trackedName });
    const historyCard = main
      .getByTestId("wellness-practice-card")
      .filter({ hasText: historyName });
    await expect(trackedCard).toBeVisible();
    await expect(historyCard).toContainText("Session history only");

    await choosePracticeAction(page, trackedCard, "wellness-practice-edit");
    const edit = trackedCard.getByTestId("practice-edit-form");
    await settledFill(page, edit.getByLabel("Minimum days"), "5");
    await settledFill(page, edit.getByLabel("Maximum days (optional)"), "3");
    await settledClick(
      page,
      edit.getByRole("button", { name: "Save changes" })
    );
    await expect(edit.getByTestId("practice-save-error")).toHaveText(
      "The weekly maximum must be greater than the minimum."
    );
    await expect(trackedCard).toContainText(
      "1 day this week · Target 3–5×/week"
    );

    // The Practice field is a Combobox, and typing into it opens a listbox that now
    // carries a measurement pass (#3271) — one more render that can revert a raw
    // fill before React owns the value. settledFill asserts the value STUCK, so a
    // swallowed name cannot quietly re-save the old one and report no collision.
    await settledFill(page, edit.getByLabel("Practice"), historyName);
    await settledFill(page, edit.getByLabel("Minimum days"), "3");
    await settledFill(page, edit.getByLabel("Maximum days (optional)"), "5");
    await settledClick(
      page,
      edit.getByRole("button", { name: "Save changes" })
    );
    await expect(edit.getByTestId("practice-save-error")).toHaveText(
      "A practice with that name already exists."
    );
    await expect(
      trackedCard.getByTestId("wellness-practice-usage")
    ).toContainText("1 session");
    await expect(
      historyCard.getByTestId("wellness-practice-usage")
    ).toContainText("2 sessions");
    // A refused edit leaves BOTH definitions alone — the rejection is not a partial
    // write that renamed one of them on the way to failing.
    await expect(trackedCard).toContainText(trackedName);
    await expect(historyCard).toContainText(historyName);
  } finally {
    db.prepare("DELETE FROM practice_logs WHERE practice IN (?, ?)").run(
      trackedName,
      historyName
    );
    if (trackedTargetId) {
      db.prepare("DELETE FROM frequency_targets WHERE id = ?").run(
        trackedTargetId
      );
    }
    db.close();
  }
});

test("one-tap practice logging: a double-tap logs once, the label states today, and a deliberate repeat asks (#2007)", async ({
  page,
}) => {
  test.slow();
  const unique = `E2E Cadence ${frozenNow().getTime()}`;
  await page.goto("/wellness");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Wellness" })).toBeVisible();

  const create = await openPracticeCreate(page);
  await create.getByLabel("Practice").fill(unique);
  await create.getByLabel("Minimum days").fill("3");
  await settledClick(
    page,
    create.getByRole("button", { name: "Save", exact: true })
  );

  const card = main
    .getByTestId("wellness-practice-card")
    .filter({ hasText: unique });
  await expect(card).toBeVisible();
  const button = card.getByTestId("practice-log-button");
  const todayLine = card.getByTestId("practice-today-count");

  // Nothing logged yet: the first tap is offered as a first tap.
  await expect(todayLine).toContainText("No sessions yet");
  await expect(button).toHaveText("Log now");
  await expect(button).toHaveAccessibleName(/^Log now — /);

  // #2204, owner ruling: the CARD carries the inline stepper too, alongside the
  // expanded form rather than instead of it. "The modal is one tap away" answered
  // where the duration field lives; it never answered what the one-tap button wrote,
  // which was nothing. A brand-new practice has no history and no declared default,
  // so the stepper starts blank — the app does not invent a duration.
  const cardDuration = card.getByTestId("practice-duration-input");
  await expect(cardDuration).toHaveValue("");
  await expect(card.getByTestId("practice-log-details-trigger")).toBeVisible();
  for (let i = 0; i < 4; i++)
    await hydratedClick(page, card.getByTestId("practice-duration-up"));
  await expect(cardDuration).toHaveValue("20");

  // Layer 1 — the fat-finger double. The second tap lands inside the post-success
  // cooldown and is absorbed: no dialog, and no second session.
  await button.click();
  await button.click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(todayLine).toContainText("1 session logged");
  await expect(button).toHaveAccessibleName(/^Log another /);

  // Layer 2 — the affordance now renders today's state, so the next tap is visibly
  // a SECOND one before it is taken.
  await expect(button).toHaveText("Log another");
  await expect(button).toHaveAccessibleName(/1 already logged today/);

  // The pin: exactly one session reached the store. The reload also clears the
  // client-side cooldown, which is why the next tap below is accepted at all.
  await page.reload();
  const reloaded = main
    .getByTestId("wellness-practice-card")
    .filter({ hasText: unique });
  await expect(
    reloaded.getByTestId("practice-session-history").locator("tbody tr")
  ).toHaveCount(1);

  // ...carrying the duration the stepper was showing when it was tapped, and the
  // stepper now starts from that LOGGED value, so accepting it again costs no taps.
  await expect(reloaded.getByTestId("practice-session-history")).toContainText(
    "20 min"
  );
  await expect(reloaded.getByTestId("practice-duration-input")).toHaveValue(
    "20"
  );

  // Layer 3 — a deliberate second session of the same day ASKS, naming the practice.
  // Cancelling writes nothing: the confirm is a question, not a gate on the write.
  //
  // hydratedClick, not a bare click: the `page.reload()` above put this button back
  // inside the #500/#830 pre-hydration window, and NOTHING between the reload and
  // here proves React has attached its `onClick`. Every assertion in between — the
  // history row count, the "20 min" cell, the stepper's value — is satisfied by the
  // SERVER-rendered markup, so all three pass against a page that is not yet
  // interactive. A tap lost there is lost for good: the handler never runs, the
  // dialog never mounts, and the 5 s expect below fails as `element(s) not found`.
  // That is decision-tree case 3's hydratedClick sub-case, and it is the same lesson
  // `openRowMenu` above already carries for this spec's ⋯ menus (#2632).
  //
  // A retry loop is the wrong repair rather than a heavier one: `useConfirm` settles
  // the in-flight confirm as CANCELLED when a second request replaces it, so
  // re-clicking can cancel the very dialog it is waiting for (#2729). hydratedClick
  // polls for the hydration marker and then clicks exactly ONCE.
  await hydratedClick(page, reloaded.getByTestId("practice-log-button"));
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`You logged ${unique} today`);
  await hydratedClick(page, dialog.getByRole("button", { name: "Cancel" }));
  await expect(dialog).toHaveCount(0);
  await expect(
    reloaded.getByTestId("practice-session-history").locator("tbody tr")
  ).toHaveCount(1);

  // …and confirming logs the genuine second session (#798: informational, never
  // permissive — a second sauna is legitimate).
  // Hydration is already proven by the tap above, but this tap opens the same
  // non-idempotent confirm and sits one edit away from a reload being introduced
  // between them — the two taps stay the same shape so neither has to be rediscovered.
  await hydratedClick(page, reloaded.getByTestId("practice-log-button"));
  await expect(page.getByTestId("confirm-dialog")).toBeVisible();
  await settledClick(
    page,
    page.getByTestId("confirm-dialog").getByRole("button", {
      name: "Log session",
    })
  );
  await expect(reloaded.getByTestId("practice-today-count")).toContainText(
    "2 sessions logged"
  );

  // Clean up this run's practice and its history.
  await choosePracticeAction(page, reloaded, "wellness-practice-delete");
  await settledClick(
    page,
    page.getByTestId("confirm-dialog").getByRole("button", {
      name: "Delete practice",
    })
  );
  await expect(reloaded).toHaveCount(0);
});

test("the cross-practice day-history renders a row per practice, on one day axis", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Spec-owned logs (#868): two uniquely named practices with sessions inside
  // the trailing-quarter window, deleted in finally. The section may also carry
  // seed practices — assert about OUR rows, never exact counts.
  const A = "History Sauna (e2e)";
  const B = "History Breathwork (e2e)";
  const keyA = practiceIdentity(A)!;
  const keyB = practiceIdentity(B)!;
  const day = (back: number) => {
    const d = frozenNow();
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
  };
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    const insert = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, duration_min)
       VALUES (1, ?, ?, ?)`
    );
    insert.run(A, day(2), 20);
    insert.run(A, day(9), 25);
    insert.run(B, day(3), null);

    await page.goto("/wellness");
    const history = page.getByTestId("practice-history");
    await expect(history).toBeVisible();
    const rowA = history.locator(
      `[data-testid="day-history-row"][data-group="${keyA}"]`
    );
    const rowB = history.locator(
      `[data-testid="day-history-row"][data-group="${keyB}"]`
    );
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);
    // Rows share ONE day axis: the calendar half renders beside them.
    await expect(history.getByTestId("day-history-calendar")).toBeVisible();
    await expect(history).toContainText(
      "Calendar: days you practiced. Matrix: each day by practice."
    );
    // Same shape as trends-nutrition's row panel, and the same hazard: a client
    // toggle whose effect is only awaited by a non-retrying `boundingBox()`.
    await hydratedClick(
      page,
      rowA.getByRole("button", { name: /View occurrences for/ })
    );
    const [calendarBox, rowBox] = await settledBoxes([
      history.getByTestId("day-history-calendar-panel"),
      history.getByTestId("day-history-rowpanel"),
    ]);
    expect(rowBox.y).toBeGreaterThanOrEqual(calendarBox.y + calendarBox.height);
    await expectNoClippedContent(page);
  } finally {
    db.prepare(
      `DELETE FROM practice_logs WHERE profile_id = 1 AND practice IN (?, ?)`
    ).run(A, B);
    db.close();
  }
});

// A STATED WINDOW REACHES THE DAY'S CHART (#3142). The columns and their consumer
// ship together (the #2204 "no column without a reader" gate), so the thing worth
// driving end-to-end is the whole path: the expanded form's Start and End, through
// the renamed `start_time` / new `end_time`, out onto the day view's intraday panel
// as a BLOCK — the shape a session with no stated end cannot draw.
//
// Spec-owned zero-state profile (#3066), and the test removes both the practice it
// declares and the session it logs, so --repeat-each stays clean.
test("a practice logged with Start and End draws a block on the day chart (#3142)", async ({
  browser,
}) => {
  test.slow(); // a sign-in, a create, a detailed log and two page loads
  const practiceName = `E2E Interval Sauna ${frozenNow().getTime()}`;
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PRACTICE_ZERO,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/wellness");
    const create = await openPracticeCreate(page);
    await settledFill(page, create.getByLabel("Practice"), practiceName);
    await settledClick(page, create.getByRole("button", { name: "Save" }));
    await dismissToast(page, "Practice added");

    const card = page
      .getByTestId("wellness-practice-card")
      .filter({ hasText: practiceName });
    // hydratedClick, not settledClick: the trigger opens a MODAL and posts
    // nothing, so a POST-correlated wait would time out on a control that behaved
    // correctly. The modal it reveals is the assertion.
    await hydratedClick(page, card.getByTestId("practice-log-details-trigger"));
    const form = page.getByTestId("practice-log-details");
    await expect(form).toBeVisible();

    // THE PROFILE'S OWN TODAY, read off the form rather than recomputed here: the
    // run pins a ROTATING instance timezone (e2e/pinned-timezone.ts), so a date
    // derived from the host clock is the wrong day for most of the day.
    const day = await form.locator('input[name="date"]').inputValue();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The pair the owner decision put here in place of one "Time". Both are
    // PROFILE-LOCAL wall clocks, so they need no zone conversion — which is exactly
    // why the block's minutes below can be asserted as literals.
    await settledFill(page, form.locator('input[name="start_time"]'), "19:00");
    await settledFill(page, form.locator('input[name="end_time"]'), "19:25");
    await settledClick(page, page.getByTestId("practice-log-detailed-submit"));
    await dismissToast(page, "Logged today's session");

    await page.goto(`/history?day=${day}`);
    const panel = page.getByTestId("intraday-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-intraday-date", day);
    // One variant is displayed at a time; scope to the one this project's viewport
    // shows rather than letting a locator reach into the hidden twin.
    const chart = panel.locator('[data-variant="wide"]');
    const block = chart.getByTestId("intraday-block");
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute("data-title", practiceName);
    // A BLOCK AND NOT A TICK is the assertion: a session with a start alone still
    // renders, as a tick, so "the session is on the chart" would pass without the
    // end ever having been stored. The rail is empty here.
    await expect(chart.getByTestId("intraday-tick")).toHaveCount(0);
  } finally {
    const handle = new Database(workerDbPath());
    handle.pragma("busy_timeout = 5000");
    try {
      const ids = `SELECT id FROM profiles WHERE name = ?`;
      handle
        .prepare(`DELETE FROM practice_logs WHERE profile_id IN (${ids})`)
        .run(PRACTICE_ZERO_PROFILE);
      handle
        .prepare(
          `DELETE FROM frequency_targets
            WHERE scope_kind = 'practice' AND profile_id IN (${ids})`
        )
        .run(PRACTICE_ZERO_PROFILE);
    } finally {
      handle.close();
    }
    await page.context().close();
  }
});
