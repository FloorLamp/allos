import { test, expect } from "./fixtures";
import { appContent, hydratedClick, openMeasurementGroup } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_VIEWONLY_READ,
  E2E_LOGIN_VIEWONLY_WRITE,
} from "./fixture-logins";
import { sharedDayRestorePoint } from "./shared-profile-guard";
import { frozenNow } from "./worker-env";

// View-only access (issue #33). A profile grant now carries an access LEVEL:
// 'write' (read + edit — the historical behavior) or 'read' (view-only). These
// specs prove the boundary end-to-end:
//   1. a read-only member SEES the profile's data (reads are allowed) and gets a
//      "read-only" badge, but a mutating Server Action is REJECTED server-side
//      (requireWriteAccess() redirects to the app root before any write);
//   2. a write member is unaffected — the same mutation succeeds.
// The two members are DEDICATED, seeded logins (e2e/seed-events.ts + fixture-logins.ts),
// each granted ONLY profile 1 (the shared sample record) at its access level — so profile
// 1 is its sole/active profile on sign-in. This replaces the former runtime member
// creation through the Family UI (createLoginViaFamily/setGrantsViaFamily), whose
// onClick+router.refresh() create/grant went stale under CI load — the #830/#1111 census
// flake. We sign in as each in a fresh, cookie-less context (loginAs) so it never touches
// the shared admin storageState.

// THE WRITE MEMBER'S SAVE LANDS ON THE SHARED PROFILE (#5266). That is the whole
// point of the second test — the grant is for profile 1 — so the blood pressure it
// posts becomes today's `medical_records` rows on the profile every spec shares, and
// every reading surface there takes the LATEST row under a canonical name. The day is
// copied before the save and put back after it rather than cleared: the seed carries
// a today-dated Body Temperature in that same table, and deleting the day would take
// it from everyone downstream (#5265's ruling). Restored from an `afterEach` so a
// failure between the save and the assertions cannot skip it.
let restoreSharedDay: (() => void) | null = null;

test.afterEach(() => {
  restoreSharedDay?.();
  restoreSharedDay = null;
});

test.describe("View-only access (issue #33)", () => {
  test("a read-only member sees data but a mutation is rejected server-side", async ({
    browser,
  }) => {
    // Local `next dev` compiles the login/trends/medications routes on first hit.
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_VIEWONLY_READ,
      password: E2E_MEMBER_PASSWORD,
    });

    // READ works: the profile menu shows the "read-only" badge, and the profile's
    // data renders (the Trends → Overview → body census measurements form is reachable — since #1486
    // it is one combined form behind the desktop "+ Log" modal).
    await memberPage.goto("/trends");
    await expect(memberPage.getByTestId("read-only-badge")).toBeVisible();
    await hydratedClick(
      memberPage,
      memberPage.getByTestId("log-measurements-toggle")
    );
    const form = memberPage.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // A read-only medication detail keeps today's scheduled status visible, just
    // as the PRN detail keeps its day summary visible, without exposing mutations.
    await memberPage.goto("/medications");
    const medicationLink = memberPage
      .getByTestId("medication-row")
      .filter({ hasText: "Adherence Refill Med (e2e)" })
      .getByTestId("medication-row-link");
    await expect(medicationLink).toBeVisible();
    await memberPage.goto((await medicationLink.getAttribute("href"))!);
    const scheduledToday = memberPage.getByTestId("scheduled-today");
    await expect(scheduledToday).toBeVisible();
    await expect(
      scheduledToday.getByTestId("scheduled-dose-readonly")
    ).toBeVisible();
    await expect(scheduledToday.getByTestId("dose-status")).toHaveCount(0);

    await memberPage.goto("/trends");
    await hydratedClick(
      memberPage,
      memberPage.getByTestId("log-measurements-toggle")
    );
    const readOnlyForm = memberPage.getByTestId("measurements-quick-add");

    // WRITE is blocked: submitting the (still-rendered) form hits addMeasurements,
    // whose requireWriteAccess() redirects a read-only member to the app ROOT before
    // any row is written. That redirect is the unmistakable signature of the server
    // guard — a SUCCESSFUL save would instead stay on /trends and refresh in place
    // (see the write-member test below). We assert the redirect on pathname, not
    // the toast: the form optimistically toasts once the action call resolves, so
    // the toast is not a reliable "it wrote" signal on a redirect.
    await openMeasurementGroup(memberPage, readOnlyForm, "vitals");
    await readOnlyForm.getByLabel("Systolic", { exact: true }).fill("118");
    await readOnlyForm.getByLabel("Diastolic", { exact: true }).fill("76");
    await readOnlyForm
      .getByRole("button", { name: "Save measurements" })
      .click();

    await memberPage.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });

    // Reads still work after the bounce: the member is on their (read-only)
    // dashboard, not an error/login page.
    await expect(memberPage.getByTestId("read-only-badge")).toBeVisible();

    await memberPage.context().close();
  });

  test("a write member is unaffected — the same mutation succeeds", async ({
    browser,
  }) => {
    test.slow();

    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_VIEWONLY_WRITE,
      password: E2E_MEMBER_PASSWORD,
    });

    await memberPage.goto("/trends");
    // A write grant shows NO read-only badge.
    await expect(memberPage.getByTestId("read-only-badge")).toHaveCount(0);

    await hydratedClick(
      memberPage,
      memberPage.getByTestId("log-measurements-toggle")
    );
    const form = memberPage.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(memberPage, form, "vitals");
    restoreSharedDay = sharedDayRestorePoint(
      "medical_records",
      frozenNow().toISOString().slice(0, 10)
    );
    await form.getByLabel("Systolic", { exact: true }).fill("120");
    await form.getByLabel("Diastolic", { exact: true }).fill("78");
    await form.getByRole("button", { name: "Save measurements" }).click();

    // The write path completes: the success toast appears and we STAY on the
    // Trends page — no requireWriteAccess redirect to root (contrast the read
    // member, who is bounced to "/").
    await expect(memberPage.getByText("Measurements saved")).toBeVisible();
    await expect(memberPage).toHaveURL(/\/trends/);

    await memberPage.context().close();
  });

  // THE DOOR ITSELF, on the two record panes that gate on it (#4694, riding #5302's
  // adoption of the facts primitive). The measurements case above is the SERVER half:
  // the write is refused whoever asks. This is the affordance half, and it is the one
  // that costs a person their typing — the add door used to render for everyone, so a
  // read-only member filled the form in and was redirected to the app root with
  // nothing saved and nothing said. Asserted per form, because the gate is a value
  // each section passes to the shared add-panel shell.
  test("a read-only member is offered no add door on the record panes", async ({
    browser,
  }) => {
    test.slow();

    const memberPage = await loginAs(browser, {
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
        // #5302 slice 2's three, all on the one care-overview route. Each is its own
        // entry rather than one route check, because the gate is a value each SECTION
        // passes to the shared shell — three call sites, three chances to miss it.
        [
          "/records/care/overview",
          "add-family-history-panel-toggle",
          "records-family-history",
        ],
        [
          "/records/care/overview",
          "add-care-plan-panel-toggle",
          "records-care-plan",
        ],
        [
          "/records/care/overview",
          "add-health-goal-panel-toggle",
          "records-health-goals",
        ],
        // #5302 slice 3. The skin pane is the one that resolves NO scope — it is
        // acting-profile-only by design — so its page asks `accessForProfile`
        // directly and hands the section the value; a third supply route is a third
        // chance to miss it, which is why it gets its own entry here.
        [
          "/records/specialty/skin",
          "add-skin-lesion-panel-toggle",
          "records-skin",
        ],
        [
          "/records/history/procedures",
          "add-procedure-panel-toggle",
          "records-procedures",
        ],
        // #5302 slice 4's four, and the first three of them are on the RESULTS hub
        // rather than under /records — three more separate sections, each passing the
        // value its own scope resolved.
        [
          "/records/history/immunizations",
          "add-immunization-panel-toggle",
          "records-immunizations",
        ],
        [
          "/results/clinical-results",
          "add-result-panel-toggle",
          "results-clinical-results",
        ],
        ["/results/imaging", "add-imaging-panel-toggle", "results-imaging"],
        ["/results/genomics", "add-genomic-panel-toggle", "results-genomics"],
        // The DENTAL door is gated the same way and asserted at the component tier
        // instead (components/__tests__/record-facts-forms.test.tsx). Its route is
        // DATA-GATED — `/records/specialty/dental` redirects when the view set has no
        // dental rows — so the positive control this loop depends on would be
        // asserting the seed rather than the gate, and seeding a dental row for the
        // view-only member is a fixture change in a spec every worker shares.
      ] as const) {
        await memberPage.goto(route);
        // THE POSITIVE CONTROL, and the test is worth little without it: the pane
        // renders for a read-only viewer — reads are allowed — so the missing door
        // below is the gate and not a page that failed to load.
        const pane = appContent(memberPage);
        await expect(pane.getByTestId(section)).toBeVisible();
        await expect(pane.getByTestId(door)).toHaveCount(0);
      }
    } finally {
      await memberPage.context().close();
    }
  });
});
