import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { switchToProfile } from "./family-helpers";
import {
  hydratedClick,
  settledClick,
  settledFill,
  followLink,
} from "./helpers";
import { medicationsToday, scheduledTodayItem } from "./med-card-helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SUPPLY,
  SUPPLY_PARENT_PROFILE,
  SUPPLY_CHILD_PROFILE,
  SUPPLY_SHARED_BOTTLE,
  SUPPLY_PARENT_MED,
  SUPPLY_CHILD_MED,
  SUPPLY_LOW_BOTTLE,
  SUPPLY_EDIT_BOTTLE,
} from "./fixture-logins";

// Shared medication/supplement supply pools — the household medicine cabinet (#1374).
//
// Spec-owned fixtures throughout (#868): a DEDICATED caregiver login granted two
// DEDICATED profiles, each with its own medication linked to one of THREE spec-owned
// bottles (a stocked one for the decrement case, a low one for the alert case, an
// edit-only one so a rewritten count can't perturb the arithmetic elsewhere). No other
// spec reads these rows.
//
// REPEAT-SAFETY: a scheduled dose confirm is idempotent per (dose, day), so a naive
// "confirm and watch the count fall" assertion passes once and then cannot repeat under
// `--repeat-each`. Each case therefore drives the dose to a KNOWN state first
// (aria-pressed on the tri-state control) and RESTORES it afterwards — untoggling a
// confirm is the exact inverse of the decrement, so the bottle returns to where it
// started and the next repeat sees the same world.
//
// The two claims the feature exists to make:
//   1. Both members' dose confirms decrement ONE count.
//   2. A low bottle raises ONE alert for the household, not one per linked member.

const CABINET = "/supplies";

// The cabinet card for one bottle, addressed by its name (spec-owned, so unique).
function bottleCard(page: Page, name: string) {
  return page
    .getByTestId("shared-supply-card")
    .filter({ has: page.getByTestId("shared-supply-name").getByText(name) });
}

// The count the cabinet currently shows for a bottle, as a number.
async function onHand(page: Page, name: string): Promise<number> {
  const text = await bottleCard(page, name)
    .getByTestId("shared-supply-quantity")
    .innerText();
  return Number(text.replace(/[^\d.]/g, ""));
}

// Drive the named medication's Today-panel dose to `taken` (or back to clear) — the
// SAME tri-state control every other medications spec drives, so this exercises the
// real confirm path. A no-op when it already holds that state, which is what makes the
// case repeatable.
async function setDoseTaken(
  page: Page,
  medName: string,
  taken: boolean
): Promise<void> {
  await page.goto("/medications");
  const row = scheduledTodayItem(medicationsToday(page), medName);
  await expect(row).toBeVisible();
  const take = row.getByTestId("dose-take");
  if ((await take.getAttribute("aria-pressed")) === String(taken)) return;
  await settledClick(page, take);
  await expect(take).toHaveAttribute("aria-pressed", String(taken));
}

test.describe("shared supply pools", () => {
  test("two members' confirms decrement ONE shared bottle", async ({
    browser,
  }) => {
    // The longest case in this file by a wide margin, and what is left is the claim
    // itself: four profile switches (each a Server Action plus a layout revalidate)
    // around five /medications loads and four cabinet loads is what "two members draw
    // from one bottle" costs through the real UI. #2525 measured it at 22–25s against
    // the 30s default and watched identical work spread 5× with box load. Two things
    // answer that, in order of preference:
    //
    //   • less work — the chip claim now asserts on the page the confirm already left
    //     us on, and the switch-and-open claim moved to the deep-link case below,
    //     which was half this one's length and owed nothing to the pooled arithmetic.
    //     Measured on a 4-core container at --workers=4 --repeat-each=3: 26.1–28.3s
    //     before, 22.3–22.9s after (and 8.5–9.0s at one worker on an idle box);
    //   • a DECLARED budget for the rest. 22s of 30s is not a margin on a runner that
    //     varies 5×, and at retries: 0 test.slow() masks nothing — a pool that stops
    //     pooling still fails, it just stops failing because the box was busy.
    test.slow();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Start from a known, unconfirmed state for BOTH members.
      await setDoseTaken(page, SUPPLY_PARENT_MED, false);
      await switchToProfile(page, SUPPLY_CHILD_PROFILE);
      await setDoseTaken(page, SUPPLY_CHILD_MED, false);
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);

      // The cabinet lists the household's bottles with a POOLED projection.
      await page.goto(CABINET);
      await expect(page.getByTestId("supplies-page")).toBeVisible();
      const shared = bottleCard(page, SUPPLY_SHARED_BOTTLE);
      await expect(shared).toBeVisible();
      // Both linked members are named — this login writes both profiles.
      const members = shared.getByTestId("shared-supply-members");
      await expect(members).toContainText(SUPPLY_PARENT_MED);
      await expect(members).toContainText(SUPPLY_CHILD_MED);
      const parentItemLink = members.getByRole("link", {
        name: `Open ${SUPPLY_PARENT_MED} for ${SUPPLY_PARENT_PROFILE}`,
      });
      await expect(parentItemLink).toHaveAttribute(
        "href",
        /^\/medications\/\d+$/
      );
      const childItemLink = members.getByRole("button", {
        name: `Switch to ${SUPPLY_CHILD_PROFILE} and open ${SUPPLY_CHILD_MED}`,
      });
      await expect(childItemLink).toBeVisible();
      // Days-left says "across everyone" — the whole point of pooling.
      await expect(shared.getByTestId("shared-supply-days")).toContainText(
        "across everyone"
      );

      const before = await onHand(page, SUPPLY_SHARED_BOTTLE);

      // The parent (the acting profile) confirms their dose.
      await setDoseTaken(page, SUPPLY_PARENT_MED, true);

      // The member's own medication row shows the SHARED chip, not a private badge.
      // Asserted HERE, on the page setDoseTaken already left us on, rather than after
      // a second /medications load — the chip is a static rendering fact and owes
      // nothing to the confirm's ordering.
      const ownChip = page.getByTestId("shared-supply-chip").first(); // first-ok: spec-owned profile whose only tracked meds are this fixture's linked set
      await expect(ownChip).toContainText("Shared");

      await page.goto(CABINET);
      expect(await onHand(page, SUPPLY_SHARED_BOTTLE)).toBe(before - 1);

      // Switch to the CHILD and confirm theirs — the SAME bottle falls again.
      await switchToProfile(page, SUPPLY_CHILD_PROFILE);
      await setDoseTaken(page, SUPPLY_CHILD_MED, true);
      await page.goto(CABINET);
      expect(await onHand(page, SUPPLY_SHARED_BOTTLE)).toBe(before - 2);

      // Untoggling is the exact inverse — the bottle returns to where it started,
      // which is also what makes this case repeatable.
      await setDoseTaken(page, SUPPLY_CHILD_MED, false);
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);
      await setDoseTaken(page, SUPPLY_PARENT_MED, false);
      await page.goto(CABINET);
      expect(await onHand(page, SUPPLY_SHARED_BOTTLE)).toBe(before);
    } finally {
      // Leave the login acting as the profile it started on.
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);
      await page.context().close();
    }
  });

  // #3270 — WHICH BOTTLES A KIND-LOCKED DOOR OFFERS.
  //
  // The claim is the PAIRING, not either half. One bottle, one query, two doors,
  // opposite answers: the medications door offers the household's shared ibuprofen and
  // the Add supplement door does not. Asserting only the absence would pass on a door
  // that never opened its listbox or on a filter that emptied it, and asserting only
  // the presence would pass under the bug — the bug WAS a list that rendered plausibly.
  //
  // Read-only: it types into a name field and never submits, so it repeats cleanly and
  // perturbs no count this file's other cases depend on.
  test("a kind-locked door offers only bottles of its own kind (#3270)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Both members' items on this bottle are MEDICATIONS, so the bottle lends the
      // medication kind (#1374 — a bottle has none of its own).
      await page.goto("/medications");
      await hydratedClick(page, page.getByTestId("medication-add-toggle"));
      const panel = page.getByTestId("medication-add-panel");
      await expect(panel).toBeVisible();
      await settledFill(
        page,
        panel.getByRole("combobox", { name: "Name" }),
        SUPPLY_SHARED_BOTTLE
      );
      // The listbox is PORTALED to <body> (#3271), so the rows are not inside the
      // panel that owns the field. One list is open at a time, so asking the page
      // is not ambiguous — and the bottle name is spec-owned, so nothing else on
      // the page can match it.
      await expect(
        page
          .getByTestId("combobox-option")
          .filter({ hasText: SUPPLY_SHARED_BOTTLE })
      ).toHaveCount(1);

      // The SAME bottle, the same query, at the door that has already answered
      // "supplement" and cannot be corrected. Picking it here would have written a
      // supplement named Ibuprofen, silently.
      await page.goto("/nutrition?tab=supplements");
      await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
      const dialog = page.getByRole("dialog", { name: "Add supplement" });
      await expect(dialog).toBeVisible();
      const name = dialog.getByRole("combobox", { name: "Name" });
      // The assertion below is an ABSENCE, so the typed value must be known to have
      // landed — otherwise an empty field would satisfy it for the wrong reason.
      await settledFill(page, name, SUPPLY_SHARED_BOTTLE);
      // The listbox is genuinely open — otherwise the absence below is vacuous.
      await expect(name).toHaveAttribute("aria-expanded", "true");
      await expect(
        page
          .getByTestId("combobox-option")
          .filter({ hasText: SUPPLY_SHARED_BOTTLE })
      ).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("a low shared bottle raises ONE alert, not one per linked member", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await page.goto(CABINET);
      const low = bottleCard(page, SUPPLY_LOW_BOTTLE);
      await expect(low.getByTestId("shared-supply-low")).toBeVisible();

      // Upcoming carries exactly ONE pooled low-supply row for this bottle, even
      // though TWO of the household's medications draw from it.
      await page.goto("/upcoming");
      await expect(
        page.getByText(SUPPLY_LOW_BOTTLE, { exact: false })
      ).toHaveCount(1);

      // …and the same holds acting as the OTHER linked member: one bottle, one row
      // on their surfaces too — never N rows for one bottle.
      await switchToProfile(page, SUPPLY_CHILD_PROFILE);
      await page.goto("/upcoming");
      await expect(
        page.getByText(SUPPLY_LOW_BOTTLE, { exact: false })
      ).toHaveCount(1);
    } finally {
      await switchToProfile(page, SUPPLY_PARENT_PROFILE);
      await page.context().close();
    }
  });

  // The cabinet lost its nav row in #1522 (physical registries are reached from
  // their consumers, the /equipment pattern). These are the doors that replaced it —
  // if they regress, the surface becomes unreachable except by typing the URL.
  test("the cabinet is reached from its consumer surfaces, counted (#1522)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Medications: the door sits in the Current medications card since #3479 — it
      // used to be in the page header beside "Add medication", where at 390px it and
      // the dose-ledger door wrapped onto their own right-aligned row above the
      // primary. It is inside the card it serves now, and that containment is part of
      // the assertion, not incidental.
      await page.goto("/medications");
      const medDoor = page.getByTestId("shared-supplies-link");
      // WAIT FOR BOTH SIDES OF THE QUESTION TO BE ON SCREEN before asking it. A
      // containment read taken between "the node exists" and "the node is in its
      // place" answers FALSE about correct markup: this page streams, and a node the
      // runtime has not yet relocated is attached — so `getByTestId` resolves it —
      // while its eventual parent does not contain it yet. Measured on this exact
      // assertion, 2026-08-23: 5/5 red with no wait, green once both are visible.
      // Visibility is the right gate rather than a timeout, because a staged node is
      // not visible.
      await expect(medDoor).toBeVisible();
      await expect(page.getByTestId("medication-list")).toBeVisible();
      // AND THE CONTAINMENT ITSELF RETRIES, which the two waits above cannot buy.
      // They prove each side is on screen at some moment; the read that followed
      // them was a SINGLE `evaluate`, so a relocation still in flight between the
      // second wait and that call answered FALSE about correct markup. It failed
      // that way once on CI (PR #3617, `e2e (9)`) while passing 5/5 locally, which
      // is the signature of a window narrow enough that only a loaded box opens it.
      // Scoping the locator to the list asks the SAME question through a retrying
      // expect, so the answer is about the settled DOM instead of about the moment
      // it was taken.
      await expect(
        page.getByTestId("medication-list").getByTestId("shared-supplies-link")
      ).toBeVisible();
      // A count, not a bare label — this login's two profiles draw from the three
      // bottles this spec owns. Asserted as a PATTERN, never an exact number: other
      // specs' bottles are orphan-visible to everyone and exact-counting shared seed
      // rows is what the fixture-hygiene rule forbids.
      await expect(medDoor).toHaveText(/\d+ shared bottles/);
      await expect(medDoor.locator("svg.h-4.w-4").last()).toBeVisible();
      // The accessible name keeps the destination's NAME even when the visible label
      // is a count, so the link never reads as an anonymous number to AT.
      await expect(medDoor).toHaveAttribute("aria-label", /Medicine cabinet/);
      await followLink(page, medDoor, new RegExp(`${CABINET}$`));
      await expect(page.getByTestId("supplies-page")).toBeVisible();

      // Nutrition → Supplements: the same door lives in the tab's right-hand
      // management sidebar (the header's action slot is shared with Food).
      await page.goto("/nutrition?tab=supplements");
      const supplementDoor = page.getByTestId("shared-supplies-link");
      await expect(supplementDoor).toBeVisible();
      expect(
        await supplementDoor.evaluate((node) => {
          const sidebar = document.querySelector(
            '[data-testid="supplement-sidebar"]'
          );
          return Boolean(sidebar?.contains(node));
        })
      ).toBe(true);
      await followLink(page, supplementDoor, new RegExp(`${CABINET}$`));

      // Household: the cabinet is a household-scoped surface, so its door lives
      // beside History in that header.
      await page.goto("/household");
      await followLink(
        page,
        page.getByTestId("shared-supplies-link"),
        new RegExp(`${CABINET}$`)
      );
    } finally {
      await page.context().close();
    }
  });

  test("the cabinet edits a bottle and links both ways with a medication", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SUPPLY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // A linked medication's shared chip deep-links to the cabinet.
      await page.goto("/medications");
      const chip = page.getByTestId("shared-supply-chip").first(); // first-ok: spec-owned profile; every tracked med here is this fixture's and every chip targets the cabinet
      await followLink(page, chip, new RegExp(`${CABINET}$`));

      // Edit THIS case's own bottle through the cabinet form (explicit submit, and it
      // round-trips the loaded value for the #467 pool-level compare-and-set). Writing
      // an absolute value is idempotent, so the case repeats cleanly.
      await expect(page.getByTestId("supplies-page")).toHaveClass(
        /\bmx-auto\b/
      );
      const editable = bottleCard(page, SUPPLY_EDIT_BOTTLE);
      // The overflow trigger and its Edit item are onClick-only client state
      // (SharedSupplyCard) — the qty input the Edit reveals is the signal.
      await hydratedClick(
        page,
        editable.getByRole("button", {
          name: `Bottle actions for ${SUPPLY_EDIT_BOTTLE}`,
        })
      );
      await hydratedClick(page, page.getByTestId("shared-supply-edit"));
      await expect(
        editable.getByTestId("shared-supply-qty-input")
      ).toBeVisible();
      await editable.getByTestId("shared-supply-qty-input").fill("123");
      const save = editable.getByTestId("shared-supply-save");
      // The editor's commit is the card's one primary rank, and it is the
      // PRIMITIVE's (#4978): the marker attribute proves it renders through
      // Button at all, the paint utility proves the rank. Both replace the
      // retiring `.btn` class this used to read, which said neither.
      await expect(save).toHaveAttribute("data-button-control", "");
      await expect(save).toHaveClass(/\bbutton-control-primary\b/);
      await settledClick(page, save);
      await expect(async () => {
        expect(await onHand(page, SUPPLY_EDIT_BOTTLE)).toBe(123);
      }).toPass(); // topass-ok: awaits the revalidated cabinet after the explicit save

      // Both actions live in the card's standard overflow. Delete opens the
      // app-wide confirmation sheet rather than expanding bespoke controls into
      // the edit form; cancel it so this fixture remains repeat-safe.
      await hydratedClick(
        page,
        editable.getByRole("button", {
          name: `Bottle actions for ${SUPPLY_EDIT_BOTTLE}`,
        })
      );
      // Delete only opens the confirm sheet (a promise, not a write) — the
      // dialog asserted immediately below is the signal.
      await hydratedClick(page, page.getByTestId("shared-supply-delete"));
      const dialog = page.getByTestId("confirm-dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText("Delete bottle", { exact: true })
      ).toBeVisible();
      await expect(dialog).toContainText(`Delete “${SUPPLY_EDIT_BOTTLE}”?`);
      await expect(
        dialog.getByRole("button", { name: "Delete", exact: true })
      ).toHaveClass(/\bbtn-danger\b/);
      // Cancel resolves the confirm with false: nothing is written, so there is
      // no POST — the dialog's disappearance is the signal.
      await hydratedClick(
        page,
        dialog.getByRole("button", { name: "Cancel", exact: true })
      );
      await expect(dialog).not.toBeVisible();
      await expect(editable).toBeVisible();

      // The door back OUT, and the reason it is a button rather than a link: a member
      // item owned by ANOTHER profile switches first, so its profile-owned destination
      // cannot render against the caregiver's previous acting profile. Asserted here
      // rather than in the decrement case, which needs its 30s budget for the pooled
      // arithmetic and owes nothing to this navigation (#2525).
      //
      // From a FRESH cabinet, deliberately: driven straight off the tree the cancelled
      // delete sheet left behind, the form submit above it produced no action POST at
      // all (settledClick's "no same-origin POST was seen"), which is a different
      // question from this claim.
      await page.goto(CABINET);
      await settledClick(
        page,
        bottleCard(page, SUPPLY_SHARED_BOTTLE).getByRole("button", {
          name: `Switch to ${SUPPLY_CHILD_PROFILE} and open ${SUPPLY_CHILD_MED}`,
        })
      );
      await expect(page).toHaveURL(/\/medications\/\d+$/);
      // The switch is the claim, and since #3237 the ACTING identity is where it
      // shows. /medications/[id] drew a subject banner unconditionally — its only
      // call site in the app — and now draws one only when the subject is NOT the
      // acting profile, which after a switch-and-open it no longer is. The shell
      // identity bar is #1801's designated answer to "whose data am I looking
      // at", and it is the stronger assertion of the two: it pins the ACTING
      // profile having moved, where the banner only reported whose row rendered.
      await expect(page.getByTestId("profile-identity-bar")).toContainText(
        SUPPLY_CHILD_PROFILE,
        { timeout: 15_000 }
      );
      await expect(page.getByTestId("medication-detail")).toContainText(
        SUPPLY_CHILD_MED
      );
    } finally {
      // The switch-and-open above moved the acting profile; leave the login on the
      // one it started on so a later case in this worker's database sees the same
      // world (this file's other cases drive the PARENT's medications page).
      //
      // ASKED FIRST, because switchToProfile has no no-op path: the switcher panel
      // offers no row for the profile already being acted as, so calling it there
      // spins its popover retry until the test budget dies — and on a failure BEFORE
      // the click above, that timeout is what gets reported instead of the real
      // error. The trigger's accessible name states the acting profile, which is
      // exactly the question.
      const acting =
        (await page
          .getByTestId("profile-identity-bar")
          .getAttribute("aria-label")) ?? "";
      if (!acting.includes(SUPPLY_PARENT_PROFILE)) {
        await switchToProfile(page, SUPPLY_PARENT_PROFILE);
      }
      await page.context().close();
    }
  });
});

// ── ONE CONTROL HEIGHT IN THE ADD-FOR ROW (#3481) ────────────────────────────────
//
// The cabinet's "Add for another person" row paired a `.input` select with a
// `btn btn-sm` submit, and the mismatch had two different shapes depending on where
// you looked — which is why the class needs a RENDERED measurement rather than a class
// string, and at BOTH widths rather than one. Measured on origin/main, 2026-08-23:
//
//   1280px — select 38px, submit 32px, spread 6. The direction the phone review
//            reported ("the select is visibly taller than 'Add this bottle'").
//    390px — select 38px, submit 44px, spread 6, OPPOSITE DIRECTION. The button
//            family's rendered tap floor (#3486, ruled at 44 by #3514) lifts the
//            submit below `sm` and nothing reaches the select, so the row that was
//            filed as "button too short" is now "select too short". A guard written
//            only at desktop would have gone green on a phone the day the floor
//            landed, which is the same day the defect changed direction.
//
// The tolerance is the geometry census's own (scripts/ux-geometry-census.mjs,
// GEOMETRY_THRESHOLDS.controlHeightTolerancePx = 2 PIXELS OF RENDERED HEIGHT): a
// noise floor for sub-pixel layout and 1px borders, not a design allowance. Both
// readings above clear it three-fold.
const CONTROL_HEIGHT_TOLERANCE_PX = 2;

for (const [label, viewport] of [
  ["390px", { width: 390, height: 844 }],
  ["1280px", { width: 1280, height: 900 }],
] as const) {
  test(`the cabinet's add-for row has ONE control height at ${label} (#3481)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(CABINET);
    // WAIT FOR THE CONTENT, AND MEASURE ALL OF IT. A box read before the rows exist is
    // a box of zeros, and zeros compare EQUAL — the direction that flatters. So: wait
    // for the rows to be there, then require every reading to be a real rendered box
    // below, which is what actually closes that hole. Nothing here picks an arbitrary
    // row: every add-for row on the surface is measured and asserted.
    const rows = page.getByTestId("shared-supply-add-for");
    await expect(rows).not.toHaveCount(0);

    const spreads = await rows.evaluateAll((forms) =>
      forms.map((form) => {
        const select = form.querySelector(
          '[data-testid="shared-supply-add-for-select"]'
        )!;
        const submit = form.querySelector(
          '[data-testid="shared-supply-add-for-submit"]'
        )!;
        const s = select.getBoundingClientRect().height;
        const b = submit.getBoundingClientRect().height;
        return { select: s, submit: b, spread: Math.abs(s - b) };
      })
    );
    expect(spreads.length).toBeGreaterThan(0);
    // KEEP THIS, reviewer: it is how the numbers in the comment above were taken, and
    // it is what makes a red here say WHICH control moved instead of only that one did.
    console.log(`[#3481] ${label} add-for rows: ${JSON.stringify(spreads)}`);
    for (const r of spreads) {
      expect(
        r.select,
        `select measured ${r.select}px at ${label}`
      ).toBeGreaterThan(0);
      expect(
        r.submit,
        `submit measured ${r.submit}px at ${label}`
      ).toBeGreaterThan(0);
      expect(
        r.spread,
        `select ${r.select}px vs submit ${r.submit}px at ${label}`
      ).toBeLessThanOrEqual(CONTROL_HEIGHT_TOLERANCE_PX);
    }
  });
}
