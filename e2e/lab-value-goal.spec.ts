import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openCombobox, settledClick, settledFill } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_LAB_GOAL,
  E2E_MEMBER_PASSWORD,
  LAB_GOAL_TRACKED,
  LAB_GOAL_OVERDUE,
  LAB_GOAL_IN_RANGE,
  LAB_GOAL_TARGET,
} from "./fixture-logins";

// Goals that target a lab value (#1853). Before this, "LDL under 100 by June" could
// only be typed as freeform text next to the biomarker series, reference ranges and
// retest cadence that describe exactly that number.
//
// Two halves, because the issue makes two separate claims:
//   1. the TARGET PICKER rides the ranked biomarker combobox (#1675), not a new
//      alphabetical list;
//   2. the goal then RENDERS its progress against the real series, and paces on
//      results rather than on the calendar.
//
// The fixture (e2e/seed/training.ts, seedLabValueGoal) seeds the goal for half 2
// DIRECTLY in the worker DB, so those assertions don't depend on the create form.
// Half 1 drives the form on the OTHER analyte and deletes what it creates, so
// --repeat-each stays clean.

const RELEVANT_GROUP = "Due or flagged";
const YOUR_GROUP = "Your markers";
const ALL_GROUP = "All biomarkers";

function groups(listbox: Locator): Locator {
  return listbox.getByTestId("combobox-group");
}

function options(listbox: Locator): Locator {
  return listbox.getByTestId("combobox-option");
}

test.describe("goals can target a lab value (#1853)", () => {
  test("a seeded lab goal renders its target, its latest result and its check-in rhythm", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_LAB_GOAL,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/training?tab=goals");

      const card = page
        .getByTestId("goal-biomarker-target")
        .filter({ hasText: LAB_GOAL_TRACKED });
      await expect(card).toHaveCount(1);
      // The target reads as the user declared it — analyte, direction word, unit.
      await expect(card).toHaveText(
        `${LAB_GOAL_TRACKED} under ${LAB_GOAL_TARGET} mg/dL`
      );

      // Progress is the LATEST result of the analyte's own charted series, in the
      // unit that series is labelled with — 160 at baseline, 130 most recently,
      // against a target of 100, so exactly halfway.
      const goalCard = page
        .getByTestId("goal-card")
        .filter({ hasText: LAB_GOAL_TRACKED });
      await expect(goalCard.getByText("130 mg/dL now")).toBeVisible();
      await expect(goalCard.getByText("50%")).toBeVisible();

      // The check-in line: a lab goal's rhythm is the analyte's own retest cadence,
      // so between draws it says when the next result is expected rather than
      // recomputing a verdict about a day nothing was measured.
      await expect(goalCard.getByTestId("goal-check-in")).toContainText(
        /Next result due/
      );

      // The bar's pace verdict is frozen at the last RESULT (40 days ago), not at
      // today — a lab goal cannot fall behind on a day no lab was drawn.
      await expect(goalCard.getByTestId("goal-bar")).toHaveAttribute(
        "data-tone",
        "on-pace"
      );
    } finally {
      await page.context().close();
    }
  });

  test("the same goal appears on the biomarker page it describes", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_LAB_GOAL,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto(
        `/biomarkers/view?name=${encodeURIComponent(LAB_GOAL_TRACKED)}`
      );
      const goal = page.getByTestId("biomarker-goal");
      await expect(goal).toHaveCount(1);
      // The join the issue is about: the target sits beside the series, showing the
      // SAME latest value the Training card shows.
      await expect(goal).toContainText(`under ${LAB_GOAL_TARGET} mg/dL`);
      await expect(goal).toContainText("130 mg/dL now");
    } finally {
      await page.context().close();
    }
  });

  test("the target picker is the ranked biomarker combobox, and creates a real goal", async ({
    browser,
  }) => {
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_LAB_GOAL,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto("/training?tab=goals");
      await settledClick(page, page.getByRole("button", { name: "New goal" }));
      await settledClick(page, page.getByTestId("goal-kind-biomarker"));

      const field = page.locator(
        'input[role="combobox"][aria-label="Lab or vital"]'
      );
      const listbox = await openCombobox(page, field);

      // The relevance view, not an A–Z list. "Albumin" is alphabetically first of
      // the profile's three analytes and is exactly what an A–Z picker led with;
      // here it is LAST of the three, behind the overdue draw and the flagged one,
      // under a header that says why. Same groups, same order as every other
      // biomarker picker (#1675).
      await expect(options(listbox).nth(0)).toHaveText(LAB_GOAL_OVERDUE);
      await expect(options(listbox).nth(1)).toHaveText(LAB_GOAL_TRACKED);
      await expect(options(listbox).nth(2)).toHaveText(LAB_GOAL_IN_RANGE);
      await expect(groups(listbox)).toHaveText([
        RELEVANT_GROUP,
        YOUR_GROUP,
        ALL_GROUP,
      ]);

      // Typing is the app-wide fuzzy search, flat — a header over one match is noise.
      await settledFill(page, field, "a1c");
      await expect(options(listbox)).toHaveText([LAB_GOAL_OVERDUE]);
      await expect(groups(listbox)).toHaveCount(0);

      await listbox
        .getByRole("button", { name: LAB_GOAL_OVERDUE, exact: true })
        .click();
      await expect(field).toHaveValue(LAB_GOAL_OVERDUE);

      // The unit label and the reference hint follow the picked analyte, so the
      // number is typed beside the thresholds the app already holds rather than
      // blind next to them.
      await expect(page.getByTestId("goal-biomarker-reference")).toContainText(
        /Reference/
      );

      await settledClick(page, page.getByTestId("goal-direction-below"));
      await settledFill(page, page.getByLabel(/Target value/), "6.5");
      await settledClick(
        page,
        page.getByRole("button", { name: "Create goal" })
      );

      const created = page
        .getByTestId("goal-biomarker-target")
        .filter({ hasText: LAB_GOAL_OVERDUE });
      await expect(created).toHaveCount(1);
      await expect(created).toHaveText(`${LAB_GOAL_OVERDUE} under 6.5 %`);

      // Restore the fixture so --repeat-each stays clean: this spec owns the goal it
      // created, and leaving it would accumulate a card per run.
      const createdCard = page
        .getByTestId("goal-card")
        .filter({ hasText: LAB_GOAL_OVERDUE });
      await settledClick(
        page,
        createdCard.getByTestId("overflow-menu-trigger")
      );
      // The menu and the confirm dialog are PORTALLED to the body, so both are
      // addressed on the page rather than inside the card. Only one menu can be open
      // at a time, so this is unambiguous.
      await page.getByRole("menuitem", { name: "Delete" }).click();
      const dialog = page.getByTestId("confirm-dialog");
      await settledClick(page, dialog.getByRole("button", { name: "Delete" }));
      await expect(created).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
