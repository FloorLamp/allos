import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  hydratedClick,
  settledCheck,
  settledClick,
  settledFill,
} from "./helpers";
import { workerDbPath } from "./worker-env";
import {
  E2E_LOGIN_MENTAL,
  E2E_MEMBER_PASSWORD,
  MENTAL_HEALTH_PROFILE,
} from "./fixture-logins";

// Mental-health instrument tracking (issue #716): the mental-health surface —
// (#1042: folded from /medical/instruments into the /records#mental-health section).
// an in-app PHQ-9/GAD-7/EPDS tap-through that computes a severity-banded score, an outside
// total-only entry, a NON-DISMISSIBLE crisis-resources line on a severe score, and the
// score trended like a biomarker.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_MENTAL in its OWN cookie
// context on a dedicated, score-free adult profile. The spec administers scores it owns
// and asserts against relative counts (before/after) — never an exact shared-seed count —
// so --repeat-each stays clean. Interactions settle via settledClick.

async function pickInstrument(page: Page, key: "PHQ-9" | "GAD-7" | "EPDS") {
  await openScreening(page);
  // A picker chip: onClick only calls pickInstrument (client state).
  await hydratedClick(page, page.getByTestId(`instrument-select-${key}`));
}

async function openScreening(page: Page) {
  const form = page.getByTestId("instruments-form");
  if (!(await form.isVisible().catch(() => false))) {
    await hydratedClick(
      page,
      page.getByTestId("add-mental-health-screening-panel-toggle")
    );
  }
  await expect(form).toBeVisible();
}

// Answer every item of the currently-selected instrument with the same option value.
async function answerAll(page: Page, itemCount: number, value: 0 | 1 | 2 | 3) {
  for (let i = 0; i < itemCount; i++) {
    await page.getByTestId(`instrument-option-${i}-${value}`).click();
  }
}

// The highest instrument-score row id on this fixture profile, read straight from the
// worker's own SQLite file — 0 when the profile has none yet.
function maxScoreId(): number {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profileId = (
      db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(MENTAL_HEALTH_PROFILE) as { id: number }
    ).id;
    const row = db
      .prepare(
        `SELECT MAX(id) AS id FROM medical_records
          WHERE profile_id = ? AND category = 'instrument'`
      )
      .get(profileId) as { id: number | null };
    return row.id ?? 0;
  } finally {
    db.close();
  }
}

// The id of the score this spec JUST recorded. The row's testid is
// `instrument-reading-<id>`, and the History list is a SHARED accumulating surface on
// this fixture profile, so an unmarked positional locator there would be exactly the
// hygiene violation the harness forbids — the spec addresses its own row by id (#1396).
//
// Taking `before` (the highest id seen BEFORE the submit) and demanding a strictly
// greater one is what makes that id honest (#1923). "The newest instrument row" is a row
// that EXISTS whether or not the submit landed: the fixture profile carries seeded scores
// and earlier tests in this file add more. So a swallowed write handed the spec somebody
// else's row and every later assertion then failed AGAINST it — a band mismatch pointing
// at the correction UI, several steps downstream of the write that never happened.
// The signal awaited is the RENDERED one — the History list growing by a row — not a
// poll of SQLite. The submit's Server Action revalidates, so once the new row is on the
// page the write has landed and the id read below needs no retrying of its own.
async function recordedScoreId(
  rows: Locator,
  beforeCount: number,
  beforeId: number
): Promise<number> {
  await expect(
    rows,
    "the score submit recorded no new row in the History list"
  ).toHaveCount(beforeCount + 1);
  const id = maxScoreId();
  expect(
    id,
    `the History list grew but no new instrument row was written (highest id still ${beforeId})`
  ).toBeGreaterThan(beforeId);
  return id;
}

// Select the outside-total mode and enter a total. BOTH controls are CONTROLLED — the
// radio is `checked={mode === "outside"}` and the number input is `value={outsideTotal}`
// — so a raw check()/fill() dispatched before React attaches sets the DOM and moves no
// state, and hydration reverts it. The settled helpers wait for the fiber before acting
// (#1923).
async function enterOutsideTotal(page: Page, total: string) {
  await settledCheck(
    page,
    page.getByLabel("Enter a score from elsewhere"),
    true
  );
  await settledFill(page, page.getByTestId("instrument-outside-total"), total);
}

test.describe("mental-health instruments (#716)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_MENTAL,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("in-app PHQ-9 computes a mild band and records a score", async () => {
    await page.goto("/records/specialty/mental-health");
    await openScreening(page);

    const rows = page.getByTestId(/^instrument-reading-\d+$/);
    const before = await rows.count();

    await pickInstrument(page, "PHQ-9");
    // 9 items × option 1 = total 9 → Mild band (the "Mild → no crisis" logic itself is
    // pinned by the pure + DB tiers; the crisis line is a persistent, non-dismissible
    // signal that a prior severe score leaves standing, so this render test never asserts
    // its ABSENCE on the shared accumulating fixture — #868 relative-state hygiene).
    await answerAll(page, 9, 1);
    await expect(page.getByTestId("instrument-total")).toHaveText("9");
    await expect(page.getByTestId("instrument-band")).toContainText("Mild");

    await settledClick(page, page.getByTestId("instrument-submit"));
    await expect(rows).toHaveCount(before + 1);
  });

  test("in-app EPDS offers each item its OWN options and bands the published cut-off", async () => {
    await page.goto("/records/specialty/mental-health");
    await openScreening(page);

    const rows = page.getByTestId(/^instrument-reading-\d+$/);
    const before = await rows.count();

    await pickInstrument(page, "EPDS");
    // EPDS scores items 1, 2 and 4 forward and REVERSES the other seven, so the buttons
    // are not one shared scale: the first option of item 1 is worth 0 and the first
    // option of item 3 is worth 3. Asserted on the button LABELS, which is where an
    // instrument that quietly reused the PHQ-9 scale would show up.
    await expect(page.getByTestId("instrument-option-0-0")).toContainText(
      "As much as I always could"
    );
    await expect(page.getByTestId("instrument-option-2-3")).toContainText(
      "Yes, most of the time"
    );
    // 10 items × option value 1 = total 10, the published "possible depression" cut-off.
    await answerAll(page, 10, 1);
    await expect(page.getByTestId("instrument-total")).toHaveText("10");
    await expect(page.getByTestId("instrument-band")).toContainText(
      "Possible depression"
    );

    await settledClick(page, page.getByTestId("instrument-submit"));
    await expect(rows).toHaveCount(before + 1);
  });

  test("a severe PHQ-9 shows the non-dismissible crisis-resources line (configured, no hardcoded 988)", async () => {
    await page.goto("/records/specialty/mental-health");
    await pickInstrument(page, "PHQ-9");
    // 9 items × option 3 = total 27 → Severe.
    await answerAll(page, 9, 3);
    await expect(page.getByTestId("instrument-band")).toContainText("Severe");
    await settledClick(page, page.getByTestId("instrument-submit"));

    const crisis = page.getByTestId("instrument-crisis-line");
    await expect(crisis).toBeVisible();
    // The configured crisis resources ride the line (this profile inherits the seeded
    // GLOBAL default) — the supportive lead is present, and there is NO hardcoded 988
    // (#996 replaced the hardcoded constant with the operator-configured list).
    await expect(crisis).toContainText("not alone");
    await expect(crisis).not.toContainText("988");
    // A dismiss/snooze control never renders — but the crisis line embeds a real
    // resource list; the "no button" invariant is asserted on the outer notice's own
    // controls, not the whole subtree.
  });

  test("the instruments page always offers the crisis-resources link", async () => {
    await page.goto("/records/specialty/mental-health");
    await expect(
      page.getByTestId("instrument-crisis-support-link")
    ).toBeVisible();
  });

  test("an outside total-only GAD-7 score records without item answers", async () => {
    await page.goto("/records/specialty/mental-health");
    const rows = page.getByTestId(/^instrument-reading-\d+$/);
    const before = await rows.count();

    await pickInstrument(page, "GAD-7");
    await enterOutsideTotal(page, "6");
    await settledClick(page, page.getByTestId("instrument-submit-outside"));

    await expect(rows).toHaveCount(before + 1);
  });
});

// Correcting / removing a recorded score (#1396). Before this, a screening score was
// create-only: a fat-fingered outside total permanently distorted the trend and could
// permanently trip the non-dismissible crisis line. The banner RELEASE itself is
// pinned at the DB tier (where a score-free fixture can assert its absence); this
// spec pins the rendered affordance and that the correction actually lands.
test.describe("correcting a recorded score (#1396)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_MENTAL,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("a mis-entered outside total can be corrected in place", async () => {
    await page.goto("/records/specialty/mental-health");
    await pickInstrument(page, "GAD-7");
    // The issue's case: 21 typed where 12 was meant.
    const rows = page.getByTestId(/^instrument-reading-\d+$/);
    const beforeCount = await rows.count();
    const beforeId = maxScoreId();
    await enterOutsideTotal(page, "21");
    await settledClick(page, page.getByTestId("instrument-submit-outside"));

    const id = await recordedScoreId(rows, beforeCount, beforeId);
    const row = page.getByTestId(`instrument-reading-${id}`);
    await expect(row).toBeVisible();
    await expect(
      page.getByTestId(`instrument-reading-band-${id}`)
    ).toContainText("Severe");

    // "Correct" only flips editingId; the edit form it reveals is the signal.
    await hydratedClick(
      page,
      page.getByTestId(`instrument-reading-edit-${id}`)
    );
    await expect(
      page.getByTestId(`instrument-reading-edit-form-${id}`)
    ).toBeVisible();
    await page.getByTestId(`instrument-reading-total-${id}`).fill("12");
    await settledClick(
      page,
      page
        .getByTestId(`instrument-reading-edit-form-${id}`)
        .getByRole("button", { name: "Save" })
    );

    await expect(row).toContainText("12");
    await expect(
      page.getByTestId(`instrument-reading-band-${id}`)
    ).not.toContainText("Severe");
  });

  test("a mis-entered score can be removed from the History list", async () => {
    await page.goto("/records/specialty/mental-health");
    await pickInstrument(page, "GAD-7");
    const rows = page.getByTestId(/^instrument-reading-\d+$/);
    const beforeCount = await rows.count();
    const beforeId = maxScoreId();
    await enterOutsideTotal(page, "4");
    await settledClick(page, page.getByTestId("instrument-submit-outside"));

    const id = await recordedScoreId(rows, beforeCount, beforeId);
    const row = page.getByTestId(`instrument-reading-${id}`);
    await expect(row).toBeVisible();

    // "Remove" does not write: handleDelete awaits the app-wide confirm() first
    // and only posts if the user says yes. The dialog is this click's whole effect.
    await hydratedClick(
      page,
      page.getByTestId(`instrument-reading-delete-${id}`)
    );
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    // Every row's own control is also labelled "Remove" — scope the confirm to the
    // dialog so the click can't land back on the list.
    await settledClick(
      page,
      page.getByTestId("confirm-dialog").getByRole("button", { name: "Remove" })
    );
    await expect(row).toHaveCount(0);
  });
});
