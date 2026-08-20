import { test, expect } from "./fixtures";
import { awaitHydrated, hydratedClick, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";
import {
  closeProtocolFact,
  openProtocolFact,
  withProtocolFact,
} from "./protocol-form-helpers";

// The protocol form's adoption of facts-with-editors (#3219, over #3218).
//
// WHY THIS FILE EXISTS SEPARATELY FROM e2e/protocols.spec.ts. Those specs drive the
// form to test PROTOCOLS; these drive it to test the FORM, and specifically the two
// ways a summary-first conversion silently loses somebody's typing. Both are invisible
// on screen when they break — nothing looks wrong, a value is simply gone — so they get
// assertions of their own rather than riding along on a create flow that would still
// pass with either bug present.
//
// THE HAZARD, stated once. This form is DOM-COLLECTED: `<form action={handle}>` hands
// the action whatever FormData the browser gathers from the inputs MOUNTED at submit.
// The two consumers that adopted the primitive before it (the intake form, the sleep
// dialog) build their FormData from state by hand, so unmounting a closed editor costs
// them nothing. Here it would cost everything twice over: a field the form omits is a
// field it CLEARS (#2359), and an unmounted field is invisible to the dirty-form
// registry, which skips anything where `!field.isConnected` — so dismissing the dialog
// would throw the entry away with no "Discard your changes?" to stop it.

/** Tap the scrim where the centred dialog panel does not cover it. */
async function tapScrimCorner(page: import("@playwright/test").Page) {
  const backdrop = page.getByTestId("modal-shell-backdrop");
  await awaitHydrated(backdrop);
  await backdrop.click({ position: { x: 4, y: 4 } });
}

async function openNewProtocol(page: import("@playwright/test").Page) {
  await page.goto("/longevity#protocols");
  const main = page.getByRole("main");
  await hydratedClick(page, main.getByTestId("new-protocol-toggle"));
  const form = page.getByTestId("protocol-form");
  await expect(form).toBeVisible();
  return form;
}

test.describe("protocol facts-with-editors (#3219)", () => {
  test("a fact typed behind a closed panel still reaches the action", async ({
    page,
  }) => {
    test.slow(); // next dev compiles the longevity + protocol routes on first hit

    const uniqueName = `E2E Fact Carry ${frozenNow().getTime()}`;
    const noteText = "five grams with breakfast";
    const start = new Date(frozenNow().getTime() - 14 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const form = await openNewProtocol(page);
    await form.getByLabel("Name").fill(uniqueName);

    // Three facts, each typed into its own editor and each editor CLOSED again
    // before the next is opened. By the time Save runs, every one of these panels
    // has been shut — which is precisely the state that used to submit blanks.
    await withProtocolFact(form, "notes", async () => {
      await form.getByLabel("Notes").fill(noteText);
    });
    await withProtocolFact(form, "window", async () => {
      await form.locator("#pr-start-new").fill(start);
      // Filling a date opens its DateField popover; it floats over the panel and
      // would swallow the Done click behind it.
      await page.keyboard.press("Escape");
    });
    await withProtocolFact(form, "practice", async () => {
      await form.getByTestId("protocol-practice-type").selectOption("cardio");
    });
    await withProtocolFact(form, "cadence", async () => {
      await form.getByTestId("protocol-practice-per-week").fill("3");
    });

    // The row states them back before Save, which is the whole promise of the
    // pattern: what you see is what will be written.
    await expect(form.getByTestId("protocol-fact-notes")).toBeVisible();
    await expect(form.getByTestId("protocol-fact-cadence")).toContainText(
      "3×/week"
    );

    await form.getByRole("button", { name: "Create protocol" }).click();
    await page.waitForURL(/\/protocols\/\d+/);
    const detailMain = page.getByRole("main");
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      uniqueName
    );

    // THE ASSERTION THAT CATCHES THE BUG. The note was typed behind a panel that
    // was closed for the whole of the submit; if the panel had unmounted, the
    // action would have received no `notes` at all and written a blank.
    await expect(detailMain).toContainText(noteText);
    // And the practice/cadence pair, which reached the action from a second closed
    // panel and is what turns on the weekly progress card at all.
    await expect(
      detailMain.getByTestId("protocol-practice-card")
    ).toBeVisible();

    // Self-clean: delete it through the app confirmation.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Delete protocol" })
    );
    await page.waitForURL(/\/longevity(?:#|$)/);
    await expect(page.getByRole("main")).not.toContainText(uniqueName);
  });

  test("the dirty registry still sees a value typed in a panel that is now closed", async ({
    page,
  }) => {
    test.slow();

    const form = await openNewProtocol(page);

    // Type into a fact and CLOSE its editor. Nothing else on this form is touched,
    // so the notes textarea behind that closed panel is the only unsaved input
    // there is — which makes the confirm below unambiguous about what it saw.
    await withProtocolFact(form, "notes", async () => {
      await form.getByLabel("Notes").fill("something worth keeping");
    });

    // WHY THIS FIELD IS NOT CONTROLLED, asserted rather than commented, because the
    // failure it prevents is silent and this assertion is what makes the next one
    // self-describing.
    //
    // The registry ends its decision at `current !== serverValue`, and `serverValue`
    // is the DOM `defaultValue` — which React KEEPS IN SYNC with `value` on a
    // controlled field. So a controlled input reports current === serverValue
    // forever and can never be dirty, however mounted it is. Without this line, that
    // regression shows up as "the confirm below didn't appear", which reads as a
    // broken scrim or a broken guard and sends the reader anywhere but here.
    const notesOwnership = await page.evaluate(() => {
      const ta = document.querySelector(
        'textarea[name="notes"]'
      ) as HTMLTextAreaElement | null;
      return (
        ta && { value: ta.value, def: ta.defaultValue, live: ta.isConnected }
      );
    });
    expect(
      notesOwnership,
      "the notes field must still be in the document with its panel closed"
    ).toMatchObject({ live: true, value: "something worth keeping" });
    expect(
      notesOwnership?.def,
      "the notes field must stay DOM-owned: React syncs defaultValue onto a controlled field, and the dirty registry reads defaultValue as the saved value"
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
    await openProtocolFact(form, "notes");
    await expect(form.getByLabel("Notes")).toHaveValue(
      "something worth keeping"
    );
    await closeProtocolFact(form);

    await tapScrimCorner(page);
    // Discard is a pure CLIENT action — it closes the dialog and posts nothing — so
    // `hydratedClick`, not `settledClick`.
    await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
    await expect(form).toHaveCount(0);
  });

  test("edit mode's chips read back the stored protocol", async ({ page }) => {
    test.slow();

    // A create whose facts are all stated, so the edit that follows has something to
    // read back in every chip rather than a row of prompts.
    const uniqueName = `E2E Fact Readback ${frozenNow().getTime()}`;
    const start = new Date(frozenNow().getTime() - 21 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const end = new Date(frozenNow().getTime() + 21 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const form = await openNewProtocol(page);
    await form.getByLabel("Name").fill(uniqueName);
    await withProtocolFact(form, "window", async () => {
      await form.locator("#pr-start-new").fill(start);
      await page.keyboard.press("Escape");
      await form.locator("#pr-end-new").fill(end);
      await page.keyboard.press("Escape");
    });
    // A WELLNESS practice, deliberately, because the weekly RANGE is a wellness
    // concept: `parseScopedPractice` honours `per_week_max` only for that scope and
    // drops it for an activity type or a food group. Picking "sport" here would
    // store no ceiling at all, and the chip would be right to say "2×/week" — the
    // assertion below would then be testing the fixture rather than the read-back.
    await withProtocolFact(form, "practice", async () => {
      await form
        .getByTestId("protocol-practice-type")
        .selectOption({ label: "Sauna" });
    });
    await withProtocolFact(form, "cadence", async () => {
      await form.getByTestId("protocol-practice-per-week").fill("2");
      await form.getByTestId("protocol-practice-per-week-max").fill("4");
    });

    // The window is exactly six weeks, which the chip states as a LENGTH rather
    // than as its two endpoints.
    await expect(form.getByTestId("protocol-fact-window")).toContainText(
      "6 weeks"
    );
    await form.getByRole("button", { name: "Create protocol" }).click();
    await page.waitForURL(/\/protocols\/\d+/);
    const detailMain = page.getByRole("main");
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      uniqueName
    );

    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const editDialog = page.getByRole("dialog", { name: "Edit protocol" });
    const editForm = editDialog.getByTestId("protocol-form");
    await expect(editForm).toBeVisible();

    // THE READ-BACK. Each chip states the stored value, so the edit opens on the
    // sentence the protocol already is.
    await expect(editForm.getByLabel("Name")).toHaveValue(uniqueName);
    await expect(editForm.getByTestId("protocol-fact-practice")).toContainText(
      "Sauna"
    );
    // The range, not just the floor: `perWeekMax` is a stored fact and a chip that
    // dropped it would read as a narrower protocol than the one on disk.
    await expect(editForm.getByTestId("protocol-fact-cadence")).toContainText(
      "2–4×/week"
    );
    await expect(editForm.getByTestId("protocol-fact-window")).toContainText(
      "6 weeks"
    );

    await editDialog.getByRole("button", { name: "Cancel" }).click();

    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "Delete protocol" })
    );
    await page.waitForURL(/\/longevity(?:#|$)/);
    await expect(page.getByRole("main")).not.toContainText(uniqueName);
  });
});
