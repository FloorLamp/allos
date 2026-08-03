import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { followLink, hydratedClick, settledClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_LOAD_CONTEXT,
  LOAD_CONTEXT_LIFT,
  LOAD_CONTEXT_HOME,
  LOAD_CONTEXT_HOTEL,
} from "./fixture-logins";

// #1610 — the RENDERED half of strength load contexts.
//
// #1628 landed the identity layer but left `getExerciseE1rmSeries`'s load-context
// grouping opt-in and `getExerciseComparison` name-only, because flipping them
// without a surface that can NAME the implement would have rendered duplicate
// unlabeled rows — which the issue explicitly forbids. This spec is the proof the
// surfaces now name them.
//
// Fixture (#868): a dedicated member profile that logged ONE exercise name on TWO
// registry machines at non-comparable loads — a home chest press climbing 80 → 86 kg
// and a hotel machine flat around 50. Averaged, that reads as one lift bouncing
// between 50 and 86; separated, it is one lift progressing and one lift maintained.
// READ-ONLY: every assertion here is about what renders. The stored shape of a
// machine-scoped goal and the progress rule it implies are pinned at the action and
// DB tiers, where they can be observed directly.

async function signIn(browser: Parameters<typeof loginAs>[0]): Promise<Page> {
  return loginAs(browser, {
    username: E2E_LOGIN_LOAD_CONTEXT,
    password: E2E_MEMBER_PASSWORD,
  });
}

test.describe("strength load contexts render as labeled lanes (#1610)", () => {
  test("Analyze offers the lift's machines as labeled choices and compares one at a time", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto(
      `/training?tab=analyze&kind=strength&item=${encodeURIComponent(
        LOAD_CONTEXT_LIFT
      )}`
    );
    await expect(page.getByTestId("analyze-section")).toBeVisible();

    // ONE top-level movement in the picker; its implements are labeled CHILDREN.
    const contexts = page.getByTestId("analyze-load-contexts");
    await expect(contexts).toBeVisible();
    await expect(contexts).toContainText(LOAD_CONTEXT_HOME);
    await expect(contexts).toContainText(LOAD_CONTEXT_HOTEL);

    // The chips name the IMPLEMENT, not the exercise — two machines share the
    // exercise name, so repeating it would render exactly the duplicate unlabeled
    // rows #1610 forbids.
    const chips = contexts.getByRole("link");
    await expect(chips).toHaveCount(2);

    // Defaults to the MOST RECENTLY USED context — the hotel machine carries the
    // newest session — and the panel heading names it.
    const heading = page.getByRole("heading", {
      name: `${LOAD_CONTEXT_LIFT} (${LOAD_CONTEXT_HOTEL})`,
    });
    await expect(heading).toBeVisible();

    // Four sessions on that machine, not the eight of both machines together.
    const sessions = page.getByTestId("analyze-sessions");
    await expect(sessions.locator("tbody tr")).toHaveCount(4);
    // …and its own loads: the home machine's 80–86 kg never appears in this lane.
    await expect(sessions).not.toContainText("86");

    // Switching the chip switches the whole comparison to the other machine.
    await followLink(
      page,
      // hasText, not a name regex: the fixture's implement names carry literal
      // parentheses, and the chip's accessible name also folds in its session count.
      contexts.getByRole("link").filter({ hasText: LOAD_CONTEXT_HOME }),
      /lane=/
    );
    await expect(
      page.getByRole("heading", {
        name: `${LOAD_CONTEXT_LIFT} (${LOAD_CONTEXT_HOME})`,
      })
    ).toBeVisible();
    const homeSessions = page.getByTestId("analyze-sessions");
    await expect(homeSessions.locator("tbody tr")).toHaveCount(4);
    await expect(homeSessions).toContainText("86");

    // The chosen machine survives a metric change — a control link must not throw
    // the reader back onto the other stack.
    await followLink(
      page,
      page.getByRole("link", { name: "Est. 1RM", exact: true }),
      /metric=e1rm/
    );
    await expect(page).toHaveURL(/lane=/);
    await expect(
      page.getByRole("heading", {
        name: `${LOAD_CONTEXT_LIFT} (${LOAD_CONTEXT_HOME})`,
      })
    ).toBeVisible();

    await page.close();
  });

  test("Trends → Fitness names the implement on the progression chart and movers", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto("/trends?tab=fitness");
    await expandTrendsContext(page);

    const strength = page.getByTestId("fitness-strength");
    await expect(strength).toBeVisible();

    // The est-1RM lead is ONE machine's progression, titled with that machine.
    const trend = page.getByTestId("fitness-e1rm-trend");
    await expect(trend).toContainText(LOAD_CONTEXT_LIFT);
    await expect(trend).toContainText(LOAD_CONTEXT_HOME);

    // Both lanes reach the movers list, each labeled — the flip's whole precondition.
    const movers = page.getByTestId("fitness-strength-movers");
    await expect(movers).toBeVisible();
    await expect(
      movers.getByRole("listitem").filter({ hasText: LOAD_CONTEXT_HOME })
    ).toHaveCount(1);
    await expect(
      movers.getByRole("listitem").filter({ hasText: LOAD_CONTEXT_HOTEL })
    ).toHaveCount(1);

    // No row names the bare movement alone: an unlabeled lane would be one of two
    // identical-looking "Machine Chest Press" rows.
    await expect(
      movers.getByRole("listitem").filter({ hasText: LOAD_CONTEXT_LIFT })
    ).toHaveCount(2);

    await page.close();
  });

  test("a weight goal on a two-machine lift must name the machine", async ({
    browser,
  }) => {
    const page = await signIn(browser);
    await page.goto("/training?tab=goals");

    // Opens the goal modal in client state; the dialog is the signal.
    await hydratedClick(page, page.getByRole("button", { name: "New goal" }));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // No exercise chosen yet → nothing to disambiguate, so no picker at all. The
    // door only appears where a goal is exercise-scoped AND the lift has more than
    // one registry implement behind it.
    await expect(page.getByTestId("goal-load-context")).toHaveCount(0);

    // Typing IS the selection here: the combobox's onChange feeds the form's
    // `exercise` state directly, so the picker reacts to the exact logged name
    // without depending on the dropdown's internals.
    await dialog
      .getByRole("combobox", { name: "Activity" })
      .fill(LOAD_CONTEXT_LIFT);

    // The lift has been logged on two machines whose loads aren't comparable, so a
    // WEIGHT target has to say which one — the alternative is silently taking the
    // maximum across them, which is the bug.
    const picker = page.getByTestId("goal-load-context");
    await expect(picker).toBeVisible();
    const select = page.locator("#goal-equipment");
    await expect(select).toHaveValue("");
    await expect(select).toHaveJSProperty("required", true);
    await expect(picker).toContainText(LOAD_CONTEXT_HOME);
    await expect(picker).toContainText(LOAD_CONTEXT_HOTEL);
    // "Any machine" stays available as a DELIBERATE answer — required means a
    // conscious choice, not a ban on movement-wide goals.
    await expect(
      select.getByRole("option", { name: "Any machine" })
    ).toHaveCount(1);

    // A rep target is not load-sensitive in the same way, so it keeps the
    // movement-wide default rather than forcing a machine.
    // A metric pill (setMetric) — the required/value assertions below are the signal.
    await hydratedClick(
      page,
      dialog.getByRole("button", { name: "Reps", exact: true })
    );
    await expect(select).toHaveJSProperty("required", false);
    await expect(select).toHaveValue("any");

    // Read-only spec: nothing is submitted, so --repeat-each stays clean. The stored
    // shape and the progress rule live in the action and DB tiers.
    await page.close();
  });
});
