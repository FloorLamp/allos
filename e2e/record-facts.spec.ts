import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_VIEWONLY_READ, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { expectFactEscapeGrammar } from "./fact-escape-helpers";
import { closeRecordFact, openRecordFact } from "./record-facts-helpers";

// The clinical record family's adoption of facts-with-editors (#5302, over #3218), as
// a browser can see it. The sibling of e2e/protocol-facts.spec.ts and
// e2e/goal-facts.spec.ts, and the file slices 2–4 extend rather than copy.
//
// WHY THESE THREE AND NOT THE ROUND TRIP. What a value saves is already driven by the
// domain specs beside this one (conditions-icd10, condition-family-attributes,
// entry-vocabularies, lesion-allergy-visit-link), which now reach their fields through
// the chips. What those specs CANNOT see is the part that is only true in a browser:
// a dialog that swallows Escape, a door a read-only viewer should never have been
// offered, and a sentence that is supposed to be behind an editor rather than standing
// on the form. Each of the three is invisible when it breaks — nothing looks wrong,
// which is exactly why it gets an assertion of its own.

test.describe("record forms on the facts primitive (#5302)", () => {
  test("Escape backs out of one fact, then out of the dialog", async ({
    page,
  }) => {
    test.slow(); // next dev compiles the records route on first hit

    await page.goto("/records/problems/conditions");
    await hydratedClick(page, page.getByTestId("add-condition-panel-toggle"));
    const form = page.getByTestId("condition-form");
    await expect(form).toBeVisible();

    // The pair travels together by contract: the first Escape returns to the chips and
    // the dialog STAYS; the second dismisses the dialog. Asserting only the first is
    // how #3409 shipped four times.
    await expectFactEscapeGrammar(page, {
      form,
      row: form.getByTestId("condition-fact-row"),
      openFact: () => openRecordFact(form, "condition", "status"),
    });
  });

  test("the allergy form's meaning sentence lives inside its editor, not on the form", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/problems/allergies");
    await hydratedClick(page, page.getByTestId("add-allergy-panel-toggle"));
    const form = page.getByTestId("allergy-form");
    await expect(form).toBeVisible();

    // #5300 rule 4: the closed form carries no standing prose. Asked as an absence
    // AFTER reaching the state where the sentence could appear — the form is open and
    // its chip row is on screen — so an inert harness cannot pass this by rendering
    // nothing at all.
    await expect(form.getByTestId("allergy-fact-row")).toBeVisible();
    const meaning = form.getByText("A refuted allergy stays on record");
    await expect(meaning).toHaveCount(0);

    // And the positive half: it is where someone choosing the value is looking.
    await openRecordFact(form, "allergy", "verification");
    await expect(meaning).toBeVisible();
    await closeRecordFact(form, "allergy");
    await expect(meaning).toHaveCount(0);
  });

  test("a read-only viewer is offered no add door on either records pane", async ({
    browser,
  }) => {
    // #4694, which rides this adoption: the door used to render for everyone, and a
    // read-only member who filled it in was redirected to the app root by
    // requireWriteAccess() with their typing gone. Server-side security was never the
    // problem — the false affordance was.
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_VIEWONLY_READ,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      for (const [route, door, section] of [
        [
          "/records/problems/conditions",
          "add-condition-panel-toggle",
          "records-conditions",
        ],
        [
          "/records/problems/allergies",
          "add-allergy-panel-toggle",
          "records-allergies",
        ],
      ] as const) {
        await member.goto(route);
        // THE POSITIVE CONTROL, and this test is worth little without it: the pane
        // itself renders for a read-only viewer — reads are allowed — so the missing
        // door below is the gate and not a page that failed to load.
        await expect(member.getByTestId(section)).toBeVisible();
        await expect(member.getByTestId("read-only-badge")).toBeVisible();
        await expect(member.getByTestId(door)).toHaveCount(0);
      }
    } finally {
      await member.context().close();
    }
  });
});
