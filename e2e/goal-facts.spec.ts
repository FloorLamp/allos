import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { awaitHydrated, hydratedClick, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";
import { closeGoalFact, openGoalFact, withGoalFact } from "./goal-form-helpers";

// The training-goal form's adoption of facts-with-editors (#3220, over #3218).
//
// WHY THIS FILE EXISTS SEPARATELY from the specs that drive this form to test GOALS
// (goal-metric-switch, lab-value-goal, strength-load-context). Those drive the form to
// test the feature; these drive it to test the FORM, and specifically the two ways a
// summary-first conversion silently loses somebody's typing. Both are invisible on
// screen when they break — nothing looks wrong, a value is simply gone — so they get
// assertions of their own rather than riding along on a create flow that would still
// pass with either bug present.
//
// THE HAZARD, stated once and inherited from #3219. This form is DOM-COLLECTED:
// `<form action={submit}>` hands the action whatever FormData the browser gathers from
// the inputs MOUNTED at submit, across 30 named controls — the largest such surface in
// the tree. A field that unmounts when its panel closes is a field the form CLEARS
// (#2359), and it is invisible to the dirty-form registry as well, so dismissing the
// dialog would throw the entry away with no "Discard your changes?" to stop it.

/** Low-entropy on purpose (words and digits, never a token). */
const GOAL_CATEGORY = "habit";
const GOAL_UNIT = "steps";
const GOAL_TARGET = "10000";
const GOAL_START = "4000";
const GOAL_KEPT_TITLE = "something worth keeping";

/** Tap the scrim where the centred dialog panel does not cover it. */
async function tapScrimCorner(page: Page) {
  const backdrop = page.getByTestId("modal-shell-backdrop");
  await awaitHydrated(backdrop);
  await backdrop.click({ position: { x: 4, y: 4 } });
}

async function openNewGoal(page: Page) {
  await page.goto("/training?tab=goals");
  await hydratedClick(page, page.getByRole("button", { name: "New goal" }));
  const form = page.getByTestId("goal-form");
  await expect(form).toBeVisible();
  return form;
}

/**
 * A freeform goal, which is the kind whose facts are ALL DOM-owned named inputs —
 * title, category, description, target value, unit, current value. That is what makes
 * it the right fixture for both hazards: every value below rides a field the registry
 * can see and the browser will collect.
 */
async function chooseFreeform(page: Page, form: ReturnType<Page["getByTestId"]>) {
  await expect(form.getByTestId("goal-editor")).toHaveAttribute(
    "data-panel",
    "subject"
  );
  await hydratedClick(page, form.getByTestId("goal-kind-freeform"));
}

test.describe("goal facts-with-editors (#3220)", () => {
  test("a fact typed behind a closed panel still reaches the action, and edit mode reads it back", async ({
    page,
  }) => {
    test.slow(); // next dev compiles the training route on first hit

    const title = `E2E Goal Fact Carry ${frozenNow().getTime()}`;
    const deadline = new Date(frozenNow().getTime() + 60 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const form = await openNewGoal(page);
    // A CREATE LANDS ON THE SUBJECT PICK, because there is nothing else a new goal
    // could be about — the one tap the pattern would otherwise have added.
    await chooseFreeform(page, form);
    await form.getByLabel("Title").fill(title);
    await closeGoalFact(form);

    // Four more facts, each typed into its own editor and each editor CLOSED again
    // before the next is opened. By the time Save runs, every one of these panels has
    // been shut — which is precisely the state that used to submit blanks.
    await withGoalFact(form, "target", async () => {
      await form.getByLabel("Target value").fill(GOAL_TARGET);
      await form.getByLabel("Unit").fill(GOAL_UNIT);
    });
    await withGoalFact(form, "category", async () => {
      await form.getByLabel("Category").fill(GOAL_CATEGORY);
    });
    await withGoalFact(form, "startingFrom", async () => {
      await form.getByLabel("Current value").fill(GOAL_START);
    });
    await withGoalFact(form, "deadline", async () => {
      await form.getByLabel("Target date (optional)").fill(deadline);
      // Filling a date opens its DateField popover; it floats over the panel and
      // would swallow the Done click behind it.
      await page.keyboard.press("Escape");
    });

    // The row states them back before Save, which is the whole promise of the
    // pattern: what you see is what will be written.
    await expect(form.getByTestId("goal-fact-target")).toHaveText(
      `${GOAL_TARGET} ${GOAL_UNIT}`
    );
    await expect(form.getByTestId("goal-fact-category")).toHaveText(
      GOAL_CATEGORY
    );
    await expect(form.getByTestId("goal-fact-startingFrom")).toHaveText(
      `from ${GOAL_START} ${GOAL_UNIT}`
    );
    // Typed, not borrowed: a freeform goal has no series behind it, so its starting
    // point is a stated fact and must not carry the suggestion marking (#846).
    await expect(form.getByTestId("goal-fact-startingFrom")).toHaveAttribute(
      "data-suggested",
      "0"
    );

    await settledClick(page, form.getByRole("button", { name: "Create goal" }));

    const card = page.getByTestId("goal-card").filter({ hasText: title });
    await expect(card).toHaveCount(1);

    // THE ASSERTION THAT CATCHES THE BUG, and it is asked through the EDIT read-back
    // rather than through the card: the card renders a progress bar, and a bar can be
    // right while `category` and `unit` are null. Re-opening the stored row states
    // every value the write actually persisted.
    await hydratedClick(page, card.getByRole("button", { name: "Goal actions" }));
    await page.getByRole("menu").getByRole("menuitem", { name: "Edit" }).click();
    const editForm = page.getByTestId("goal-form");
    await expect(editForm).toBeVisible();
    await expect(editForm.getByTestId("goal-fact-subject")).toHaveText(title);
    await expect(editForm.getByTestId("goal-fact-target")).toHaveText(
      `${GOAL_TARGET} ${GOAL_UNIT}`
    );
    // Typed behind a panel that was closed for the whole of the submit. If the panel
    // had unmounted, the action would have received no `category` at all.
    await expect(editForm.getByTestId("goal-fact-category")).toHaveText(
      GOAL_CATEGORY
    );
    await expect(editForm.getByTestId("goal-fact-startingFrom")).toHaveText(
      `from ${GOAL_START} ${GOAL_UNIT}`
    );
    // An edit reads back onto the CHIPS, not onto an open editor: nothing is
    // expanded until the person asks for it.
    await expect(editForm.getByTestId("goal-editor")).toBeHidden();

    // Dismissed through the Close control rather than Escape, and the reason is a
    // finding rather than a preference: `useFocusTrap` yields Escape to the panel
    // whenever it CONTAINS a `[data-escape-layer="true"]`, and this form's
    // FactEditorHost is mounted at all times (hidden when nothing is open) so that
    // its named inputs still post. So the marker is always present and the dialog
    // never answers Escape at all. Every hidden-not-unmounted consumer of the
    // primitive has that shape; filed rather than fixed here.
    await hydratedClick(
      page,
      page.getByRole("dialog").getByRole("button", { name: "Close" })
    );
    await expect(editForm).toHaveCount(0);

    // Self-clean, so --repeat-each stays clean: this spec owns the goal it created.
    await hydratedClick(page, card.getByRole("button", { name: "Goal actions" }));
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Delete" })
      .click();
    await settledClick(
      page,
      page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete" })
    );
    await expect(page.getByTestId("goal-card").filter({ hasText: title })).toHaveCount(
      0
    );
  });

  test("history pre-answers the starting point, and the chip says it was borrowed", async ({
    page,
  }) => {
    test.slow();

    // #3220's seeding criterion, at runtime. A body goal's baseline is captured
    // server-side from the latest Body metrics entry (`createGoal`), so before this
    // the form collected a target with no way to say what it was a target FROM. The
    // chip states it, and states that it was supplied rather than typed (#846).
    const form = await openNewGoal(page);
    await expect(form.getByTestId("goal-editor")).toHaveAttribute(
      "data-panel",
      "subject"
    );
    await hydratedClick(page, form.getByTestId("goal-body-metric-weight"));
    await closeGoalFact(form);

    await expect(form.getByTestId("goal-fact-subject")).toHaveText("Bodyweight");
    // DERIVED: using the body-metric picker is what made this a body goal.
    await expect(form.getByTestId("goal-fact-kind")).toHaveAttribute(
      "data-suggested",
      "1"
    );

    const start = form.getByTestId("goal-fact-startingFrom");
    // THE SHAPE, NOT THE NUMBER. The value is the seed's latest weigh-in, which is a
    // property of a SHARED fixture rather than of this feature — pinning it would be
    // an exact-value assertion over someone else's seed (#2353). What this spec owns
    // is that history reached the form at all, in a unit, marked as borrowed.
    await expect(start).toHaveText(/^from [\d.]+ (kg|lb)$/);
    await expect(start).toHaveAttribute("data-suggested", "1");

    // Nothing was typed, so the form still dismisses in one gesture — a borrowed
    // value is not unsaved input.
    await tapScrimCorner(page);
    await expect(form).toHaveCount(0);
  });

  test("the dirty registry still sees a value typed in a panel that is now closed", async ({
    page,
  }) => {
    test.slow();

    const form = await openNewGoal(page);
    await chooseFreeform(page, form);

    // Type into ONE fact and close its editor. Nothing else on this form is a named
    // control the registry can see — the subject picker carries no `name` and every
    // kind carrier is `type="hidden"` — so the title input behind that closed panel
    // is the only unsaved input there is, which makes the confirm below unambiguous
    // about what it saw.
    await form.getByLabel("Title").fill(GOAL_KEPT_TITLE);
    await closeGoalFact(form);

    // WHY THIS FIELD IS NOT CONTROLLED, asserted rather than commented, because the
    // failure it prevents is silent and this assertion is what makes the next one
    // self-describing.
    //
    // The registry ends its decision at `current !== serverValue`, and `serverValue`
    // was the DOM `defaultValue` — which React KEEPS IN SYNC with `value` on a
    // controlled field. #3352 closed that hole in the registry itself, so a
    // controlled field CAN now be dirty; this form still keeps its previously-
    // uncontrolled fields DOM-owned because that is the cheaper shape, and this line
    // is what would say so if a later tidy-up converted them.
    const ownership = await page.evaluate(() => {
      const input = document.querySelector(
        'input[name="title"]'
      ) as HTMLInputElement | null;
      return (
        input && {
          value: input.value,
          def: input.defaultValue,
          live: input.isConnected,
        }
      );
    });
    expect(
      ownership,
      "the title field must still be in the document with its panel closed"
    ).toMatchObject({ live: true, value: GOAL_KEPT_TITLE });
    expect(
      ownership?.def,
      "the title field is DOM-owned: `defaultValue` seeds it and an onChange mirrors it into the chips, so the registry still has a server value to compare against"
    ).toBe("");

    // A scrim tap is a GESTURE dismissal, which is the one ModalShell guards
    // (#2774): it asks before throwing a dirty form away. Escape and the Close
    // button are deliberately unguarded, so neither would test this.
    //
    // AIMED AT A CORNER, not at the backdrop's centre. The scrim is `fixed inset-0`,
    // so its centre is underneath the centred dialog panel and a default click
    // resolves to "subtree intercepts pointer events" — which reads as a broken
    // scrim rather than as a mis-aimed tap.
    await tapScrimCorner(page);

    const confirm = page.getByTestId("confirm-dialog");
    // A PRESENCE assertion, and the generous default ceiling is honest on one: no
    // amount of waiting can make this confirm appear if the registry cannot see the
    // typing, because the registry is asked synchronously on the tap.
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Discard your changes?");

    // Keep editing, and the value is still there — the confirm is a question, not a
    // commit point.
    await hydratedClick(
      page,
      confirm.getByRole("button", { name: "Keep editing" })
    );
    await openGoalFact(form, "subject");
    await expect(form.getByLabel("Title")).toHaveValue(GOAL_KEPT_TITLE);
    await closeGoalFact(form);

    await tapScrimCorner(page);
    // Discard is a pure CLIENT action — it closes the dialog and posts nothing — so
    // `hydratedClick`, not `settledClick`.
    await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
    await expect(form).toHaveCount(0);
  });

  test("a goal form nobody typed into dismisses in one gesture", async ({
    page,
  }) => {
    test.slow();

    // THE NEGATIVE CONTROL for the test above, and it is what stops that one being
    // green for the wrong reason. "The confirm appeared" only means the registry saw
    // the typing if the confirm does NOT appear when there is nothing to see —
    // otherwise a guard that asked on every gesture would satisfy it just as well.
    const form = await openNewGoal(page);
    await chooseFreeform(page, form);

    // ESCAPE RETURNS TO THE CHIPS (#3222). The open panel declares itself an escape
    // layer, so the shared focus trap yields the key to it; without that the first
    // Escape would throw the whole form away, which is the opposite of "returns to
    // the chips".
    //
    // AND ONLY THAT HALF IS ASSERTED. The sleep dialog's contract continues "the
    // SECOND Escape still closes the dialog", and on this form it does not: the
    // FactEditorHost stays mounted so its named inputs keep posting, so the panel
    // permanently contains a `[data-escape-layer="true"]` and `useFocusTrap` yields
    // every Escape to it. That is a property of the hidden-not-unmounted shape, not
    // of this form, and is filed rather than pinned here — a spec that asserted the
    // current behaviour would freeze it.
    await page.keyboard.press("Escape");
    await expect(form.getByTestId("goal-fact-row")).toBeVisible();
    await expect(form).toBeVisible();

    // A disclosure is opened and closed WITHOUT editing anything, so the chips have
    // been driven exactly as in the test above and the only difference is that no
    // value changed. A control that skipped this would be testing "an untouched
    // form" rather than "an untouched form somebody browsed".
    await openGoalFact(form, "subject");
    await closeGoalFact(form);

    await tapScrimCorner(page);

    // Asserted as the DISMISSAL, never as "no confirm is visible". A retrying
    // absence assertion is the shape to distrust: it passes the moment the confirm
    // has not rendered YET. This one cannot pass early — if a confirm had
    // intercepted the gesture the dialog would still be standing, and no amount of
    // waiting makes a blocked dialog disappear.
    await expect(form).toHaveCount(0);
  });
});
