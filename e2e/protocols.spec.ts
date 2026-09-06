import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import {
  dismissToast,
  expectPhoneTapTargets,
  hydratedClick,
  settledBoxes,
  settledClick,
} from "./helpers";
import { frozenNow } from "./worker-env";
import { openProtocolFact, withProtocolFact } from "./protocol-form-helpers";
import {
  TAP_FLOOR_FLOAT_EPSILON_PX,
  TAP_FLOOR_PX,
} from "@/lib/tap-floor-tokens";

const PHONE = { width: 390, height: 844 };
const PROTOCOL_FORM_PRIMARY_MIN_WIDTH_PX = 6 * 16;

type Box = { x: number; y: number; width: number; height: number };

function expectContained(outer: Box, inner: Box, name: string) {
  expect(
    inner.x + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} left containment`
  ).toBeGreaterThanOrEqual(outer.x);
  expect(
    inner.y + TAP_FLOOR_FLOAT_EPSILON_PX,
    `${name} top containment`
  ).toBeGreaterThanOrEqual(outer.y);
  expect(
    inner.x + inner.width,
    `${name} right containment`
  ).toBeLessThanOrEqual(outer.x + outer.width + TAP_FLOOR_FLOAT_EPSILON_PX);
  expect(
    inner.y + inner.height,
    `${name} bottom containment`
  ).toBeLessThanOrEqual(outer.y + outer.height + TAP_FLOOR_FLOAT_EPSILON_PX);
}

function expectDisjoint(a: Box, b: Box, name: string) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  expect(
    overlapX > TAP_FLOOR_FLOAT_EPSILON_PX &&
      overlapY > TAP_FLOOR_FLOAT_EPSILON_PX,
    name
  ).toBe(false);
}

async function expectDesktopProtocolActions({
  actions,
  cancel,
  primaryOwner,
  submit,
  primaryMinWidth = 0,
}: {
  actions: Locator;
  cancel: Locator;
  primaryOwner: Locator;
  submit: Locator;
  primaryMinWidth?: number;
}) {
  const [actionsBox, cancelBox, ownerBox, submitBox] = await settledBoxes([
    actions,
    cancel,
    primaryOwner,
    submit,
  ]);

  expect(cancelBox.height, "desktop Cancel stays compact").toBeLessThan(
    TAP_FLOOR_PX
  );
  expect(submitBox.height, "desktop submit stays compact").toBeLessThan(
    TAP_FLOOR_PX
  );
  expect(cancelBox.width, "desktop Cancel does not fill its row").toBeLessThan(
    actionsBox.width / 2
  );
  expect(submitBox.width, "desktop submit does not fill its row").toBeLessThan(
    actionsBox.width / 2
  );
  if (primaryMinWidth > 0)
    expect(ownerBox.width).toBeGreaterThanOrEqual(primaryMinWidth);
  expect(submitBox.width, "submit stretches to its layout owner").toBe(
    ownerBox.width
  );
  expectContained(actionsBox, cancelBox, "desktop Cancel in actions");
  expectContained(actionsBox, ownerBox, "desktop primary owner in actions");
  expectContained(ownerBox, submitBox, "desktop submit in primary owner");
  expectDisjoint(cancelBox, submitBox, "desktop actions stay disjoint");
}

async function expectPhoneProtocolActions({
  actions,
  cancel,
  primaryOwner,
  submit,
  name,
}: {
  actions: Locator;
  cancel: Locator;
  primaryOwner: Locator;
  submit: Locator;
  name: string;
}) {
  await expectPhoneTapTargets(actions.page(), name, [cancel, submit], {
    disjoint: true,
  });
  const [actionsBox, cancelBox, ownerBox, submitBox] = await settledBoxes([
    actions,
    cancel,
    primaryOwner,
    submit,
  ]);

  expect(cancelBox.x, `${name} controls share one column`).toBeCloseTo(
    ownerBox.x,
    1
  );
  expect(cancelBox.width, `${name} controls fill one column`).toBeCloseTo(
    ownerBox.width,
    1
  );
  expect(submitBox.width, `${name} submit fills its owner`).toBeCloseTo(
    ownerBox.width,
    1
  );
  expectContained(actionsBox, cancelBox, `${name} Cancel in actions`);
  expectContained(actionsBox, ownerBox, `${name} primary owner in actions`);
  expectContained(ownerBox, submitBox, `${name} submit in primary owner`);
}
// N-of-1 protocols + healthspan pillars (issue #161).
//   1. Full create → compare flow: create a protocol with two body-metric outcomes
//      and a past start date, land on its detail page, and see before/during
//      panels. Self-cleaning (deletes the protocol it created).
//   2. The dashboard healthspan-pillar readouts render, showing at least the
//      optimal-biomarkers pillar (seed profile 1 has labs) — proving the cluster
//      renders only the pillars whose data exists.
// The default specs run authenticated as admin acting as profile 1 (storageState).
// Locators are scoped to the main content region to avoid the responsive shell.

test.describe("protocols create → compare (issue #161)", () => {
  test("creates a protocol and shows the before/during comparison", async ({
    page,
  }) => {
    test.slow(); // next dev compiles these routes on first hit

    const uniqueName = `E2E Creatine ${Date.now()}`; // eslint-disable-line no-restricted-properties -- clock-ok: unique fixture-name suffix, never a stored timestamp
    const updatedName = `${uniqueName} updated`;
    // A relative past start so the baseline/intervention windows both have seeded
    // weekly body-metric readings (never a hardcoded date that ages out).
    const start = new Date(frozenNow().getTime() - 42 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");
    const desktopViewport = page.viewportSize();
    expect(
      desktopViewport,
      "the desktop project has a fixed viewport"
    ).not.toBeNull();

    await main.getByTestId("new-protocol-toggle").click();
    const form = page.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await withProtocolFact(form, "window", async () => {
      await form.locator("#pr-start-new").fill(start);
      // Filling the date field opens its DateField popover, which floats over the
      // panel's Done — dismiss it first.
      await page.keyboard.press("Escape");
    });
    const outcomeSearch = form.getByLabel("Filter outcome metrics");
    await outcomeSearch.click();
    // The protocol picker keeps its tracked-only scope, but its empty-query
    // biomarker order comes from the shared relevance rank (#1675). Seeded LDL
    // is starred, so it reaches the first eight options instead of being buried
    // in the old alphabetical biomarker tail.
    // The option rows are in the PORTALED listbox (#3271), not inside the form —
    // addressed through it so they cannot be confused with a same-named control
    // on the page behind.
    const outcomeOptions = page.getByRole("listbox");
    await expect(
      outcomeOptions.getByRole("option", {
        name: "LDL Cholesterol",
        exact: true,
      })
    ).toBeVisible();
    await outcomeSearch.fill("Body weight");
    await outcomeOptions.getByRole("option", { name: "Body weight" }).click();
    await outcomeSearch.fill("Resting heart rate");
    await outcomeOptions
      .getByRole("option", { name: "Resting heart rate", exact: true })
      .click();
    await expectDesktopProtocolActions({
      actions: form.getByTestId("protocol-form-actions"),
      cancel: form.getByRole("button", { name: "Cancel", exact: true }),
      primaryOwner: form.getByTestId("protocol-form-primary-action"),
      submit: form.getByRole("button", {
        name: "Create protocol",
        exact: true,
      }),
      primaryMinWidth: PROTOCOL_FORM_PRIMARY_MIN_WIDTH_PX,
    });
    await settledClick(
      page,
      form.getByRole("button", { name: "Create protocol", exact: true })
    );

    // Redirects to the detail page.
    await page.waitForURL(/\/protocols\/\d+/);
    const detailMain = page.getByRole("main");
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      uniqueName
    );
    await dismissToast(page, "Protocol created");
    await expect(
      detailMain.getByRole("link", { name: "Back to protocols" })
    ).toHaveAttribute("href", "/longevity#protocols");
    await expect(
      detailMain
        .getByRole("heading", { name: uniqueName })
        .locator("..")
        .locator("..")
    ).toHaveCSS("margin-bottom", "0px");

    // The comparison section renders per-outcome panels for the two chosen metrics.
    await expect(detailMain.getByTestId("protocol-compare")).toBeVisible();
    await expect(
      detailMain.getByTestId("protocol-outcome-metric:weight")
    ).toBeVisible();
    await expect(
      detailMain.getByTestId("protocol-outcome-metric:resting_hr")
    ).toBeVisible();

    // Outcomes are editable in place. Clearing them exposes a useful empty-state
    // action, and that action can add one back without opening the full protocol
    // editor or changing unrelated settings.
    const outcomes = detailMain.getByTestId("protocol-compare");
    await outcomes.getByRole("button", { name: "Edit outcomes" }).click();
    const editOutcomes = outcomes.getByTestId("protocol-outcomes-form");
    await expect(editOutcomes).toBeVisible();
    await expectDesktopProtocolActions({
      actions: editOutcomes.getByTestId("protocol-outcomes-actions"),
      cancel: editOutcomes.getByRole("button", {
        name: "Cancel",
        exact: true,
      }),
      primaryOwner: editOutcomes.getByTestId(
        "protocol-outcomes-primary-action"
      ),
      submit: editOutcomes.getByRole("button", {
        name: "Save outcomes",
        exact: true,
      }),
    });
    await hydratedClick(
      page,
      editOutcomes.getByRole("button", { name: "Cancel", exact: true })
    );
    await expect(editOutcomes).toHaveCount(0);

    await outcomes.getByRole("button", { name: "Edit outcomes" }).click();
    const phoneEditOutcomes = outcomes.getByTestId("protocol-outcomes-form");
    await expect(phoneEditOutcomes).toBeVisible();
    await page.setViewportSize(PHONE);
    await expectPhoneProtocolActions({
      actions: phoneEditOutcomes.getByTestId("protocol-outcomes-actions"),
      cancel: phoneEditOutcomes.getByRole("button", {
        name: "Cancel",
        exact: true,
      }),
      primaryOwner: phoneEditOutcomes.getByTestId(
        "protocol-outcomes-primary-action"
      ),
      submit: phoneEditOutcomes.getByRole("button", {
        name: "Save outcomes",
        exact: true,
      }),
      name: "phone protocol outcome actions",
    });
    await expect(page.getByRole("dialog", { name: /outcomes/i })).toHaveCount(
      0
    );
    await expect(
      outcomes.getByTestId("protocol-outcome-metric:weight")
    ).toBeVisible();
    await outcomes.getByRole("button", { name: "Remove Body weight" }).click();
    await outcomes
      .getByRole("button", { name: "Remove Resting heart rate" })
      .click();
    await settledClick(
      page,
      phoneEditOutcomes.getByRole("button", { name: "Save outcomes" })
    );
    await expect(
      outcomes.getByRole("button", { name: "Choose outcomes" })
    ).toBeVisible();
    await dismissToast(page, "Outcomes updated");
    await expect(
      detailMain.getByTestId("protocol-outcome-metric:weight")
    ).toHaveCount(0);

    await outcomes.getByRole("button", { name: "Choose outcomes" }).click();
    const chooseOutcomes = outcomes.getByTestId("protocol-outcomes-form");
    await expect(chooseOutcomes).toBeVisible();
    await expect(page.getByRole("dialog", { name: /outcomes/i })).toHaveCount(
      0
    );
    const chooseSearch = chooseOutcomes.getByLabel("Filter outcome metrics");
    await chooseSearch.click();
    const outcomeListbox = page.getByRole("listbox");
    await expect(outcomeListbox).toBeVisible();
    await expect(chooseOutcomes).toHaveCSS("z-index", "20");
    // The list is portaled to <body> now (#3271) and takes the layer a picker
    // opened from inside a dialog needs — above the sheet/dialog host's `z-60`,
    // the same one the portaled date calendar takes. It used to be `z-50`, which
    // only ever had to beat this inline form; stacking is not what keeps it
    // unclipped any more, because z-index cannot escape an ancestor's clip box.
    await expect(outcomeListbox).toHaveCSS("z-index", "70");
    await chooseSearch.fill("Body weight");
    const weightOption = outcomeListbox.getByRole("option", {
      name: /^Body weight [−+±]\d/,
    });
    await expect(weightOption).toBeVisible();
    await weightOption.click();
    await settledClick(
      page,
      chooseOutcomes.getByRole("button", { name: "Save outcomes" })
    );
    await expect(
      detailMain.getByTestId("protocol-outcome-metric:weight")
    ).toBeVisible();
    await dismissToast(page, "Outcomes updated");

    // Edit opens a bounded, sectioned modal with persistent actions instead of
    // replacing the narrow detail card inline.
    await page.setViewportSize(desktopViewport!);
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Edit", exact: true })
      .click();
    const editDialog = page.getByRole("dialog", { name: "Edit protocol" });
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByLabel("Name")).toHaveValue(uniqueName);
    // THE SECTIONS THAT USED TO BE LISTED HERE ARE THE POINT OF #3219, not a
    // casualty of it: "What you're testing", "Weekly practice" and "Notes" were three
    // stacked field walls a person read whether or not they disagreed with any of
    // them, and they are the chip row now. What survives is the geometry this test is
    // actually about — the form still has its two headed sections, and the edit still
    // opens on a work surface with its actions reachable.
    for (const section of ["Details", "Outcomes"]) {
      await expect(
        editDialog.getByRole("heading", { name: section, exact: true })
      ).toBeVisible();
    }
    // The facts those sections held are stated by the row instead, each one a
    // disclosure over its own editor. Read back in full by
    // e2e/protocol-facts.spec.ts; pinned here as "the edit opens onto them".
    await expect(editDialog.getByTestId("protocol-fact-row")).toBeVisible();
    await expect(editDialog.getByTestId("protocol-form-actions")).toBeVisible();
    await expect(
      editDialog.getByRole("button", { name: "Save", exact: true })
    ).toBeVisible();
    await expectDesktopProtocolActions({
      actions: editDialog.getByTestId("protocol-form-actions"),
      cancel: editDialog.getByRole("button", { name: "Cancel", exact: true }),
      primaryOwner: editDialog.getByTestId("protocol-form-primary-action"),
      submit: editDialog.getByRole("button", { name: "Save", exact: true }),
      primaryMinWidth: PROTOCOL_FORM_PRIMARY_MIN_WIDTH_PX,
    });
    const [desktopSaveOwnerBox] = await settledBoxes([
      editDialog.getByTestId("protocol-form-primary-action"),
    ]);
    expect(
      desktopSaveOwnerBox.width,
      "ProtocolForm's parent keeps the 6rem desktop minimum"
    ).toBe(PROTOCOL_FORM_PRIMARY_MIN_WIDTH_PX);
    const dialogBox = await editDialog.boundingBox();
    const viewport = page.viewportSize();
    expect(dialogBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    // Width is DECLARED now (#2774): the dialog takes its `size` from the shared
    // primitive instead of a per-host `max-w-*`, and this bucket is what "a work
    // surface, not the widest thing on screen" resolves to.
    expect(dialogBox!.width).toBeLessThanOrEqual(768);
    // Its HEIGHT is deliberately no longer pinned to the viewport, and that is a
    // ruling rather than a relaxation. The old geometry bounded the panel and gave
    // it an inner scroller — which also CLIPPED every picker the form opens; the
    // practice combobox came out cut off mid-list
    // (e2e/wellness-practices.spec.ts). A tall dialog now scrolls its container
    // instead, so what must still hold is that it starts on screen and every
    // control in it is reachable — which the Cancel click immediately below is.
    expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.y).toBeLessThan(viewport!.height);
    await editDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(editDialog).toHaveCount(0);

    await page.setViewportSize(PHONE);
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Edit", exact: true })
      .click();
    const phoneEditDialog = page.getByRole("dialog", { name: "Edit protocol" });
    await expect(phoneEditDialog).toBeVisible();
    await expectPhoneProtocolActions({
      actions: phoneEditDialog.getByTestId("protocol-form-actions"),
      cancel: phoneEditDialog.getByRole("button", {
        name: "Cancel",
        exact: true,
      }),
      primaryOwner: phoneEditDialog.getByTestId("protocol-form-primary-action"),
      submit: phoneEditDialog.getByRole("button", {
        name: "Save",
        exact: true,
      }),
      name: "phone protocol form actions",
    });
    await phoneEditDialog.getByLabel("Name").fill(updatedName);
    await settledClick(
      page,
      phoneEditDialog.getByRole("button", { name: "Save", exact: true })
    );
    await expect(phoneEditDialog).toHaveCount(0);
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      updatedName
    );
    await page.reload();
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      updatedName
    );
    await expect(
      detailMain.getByTestId("protocol-outcome-metric:weight")
    ).toBeVisible();

    // End → Resume stays on the same protocol run inside the seven-day window.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "End now" })
      .click();
    await settledClick(
      page,
      page
        .getByTestId("confirm-dialog")
        .getByRole("button", { name: "End protocol" })
    );
    await expect(detailMain.getByTestId("protocol-header")).not.toContainText(
      "Ongoing"
    );

    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await settledClick(
      page,
      page.getByRole("menu").getByRole("menuitem", { name: "Resume" })
    );
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      "Ongoing"
    );

    // Self-clean: delete it through the app confirmation.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Delete", exact: true })
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

  test("starts an expired protocol as a new run and preserves the old run", async ({
    page,
  }) => {
    test.slow();
    const uniqueName = `E2E Restart ${frozenNow().getTime()}`;
    const end = new Date(frozenNow().getTime() - 20 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const start = new Date(frozenNow().getTime() - 50 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");
    await main.getByTestId("new-protocol-toggle").click();
    const form = page.getByTestId("protocol-form");
    await form.getByLabel("Name").fill(uniqueName);
    await withProtocolFact(form, "window", async () => {
      await form.locator("#pr-start-new").fill(start);
      await page.keyboard.press("Escape");
      await form.locator("#pr-end-new").fill(end);
      await page.keyboard.press("Escape");
    });
    await settledClick(
      page,
      form.getByRole("button", { name: "Create protocol" })
    );
    await page.waitForURL(/\/protocols\/\d+/);
    const oldUrl = page.url();
    const detailMain = page.getByRole("main");

    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await settledClick(
      page,
      page.getByRole("menu").getByRole("menuitem", { name: "Run again" })
    );
    await page.waitForURL((url) => url.href !== oldUrl);
    const newUrl = page.url();
    expect(newUrl).not.toBe(oldUrl);
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      /ongoing/i
    );

    // The expired run remains addressable after the new run starts.
    await page.goto(oldUrl);
    await expect(detailMain.getByTestId("protocol-header")).not.toContainText(
      "ongoing"
    );

    // Clean up both runs.
    for (const url of [oldUrl, newUrl]) {
      await page.goto(url);
      await hydratedClick(
        page,
        detailMain.getByRole("button", { name: "More protocol actions" })
      );
      await page
        .getByRole("menu")
        .getByRole("menuitem", { name: "Delete", exact: true })
        .click();
      await settledClick(
        page,
        page
          .getByTestId("confirm-dialog")
          .getByRole("button", { name: "Delete protocol" })
      );
      await page.waitForURL(/\/longevity(?:#|$)/);
    }
    await expect(page.getByRole("main")).not.toContainText(uniqueName);
  });
});

// #592: the protocol "Recovery gear" selector must offer only recovery (+
// uncategorized) gear, not the whole inventory. Profile 1 owns a seeded recovery
// "E2E Protocol Sauna" and a strength "E2E Protocol Barbell" (see seed-events); the
// add form's gear select must list the sauna and exclude the barbell (and the
// cardio Road Bike). Read-only — never submits — so it leaves the seed untouched.
test.describe("protocols recovery-gear filter (#592)", () => {
  test("the gear selector offers recovery gear but not a barbell", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/longevity#protocols");
    await page.getByTestId("new-protocol-toggle").click();
    // The gear select is behind the row's `link` fact since #3219, and with nothing
    // linked yet that fact has no chip — it is reached through the one trailing
    // affordance, which is what `openProtocolFact` routes.
    const form = page.getByTestId("protocol-form");
    await expect(form).toBeVisible();
    await openProtocolFact(form, "link");
    const select = page.getByTestId("protocol-equipment");
    await expect(select).toBeVisible();

    // The recovery sauna is offered.
    await expect(
      select.locator("option", { hasText: "E2E Protocol Sauna" })
    ).toHaveCount(1);
    // The strength barbell and the cardio bike are filtered out.
    await expect(
      select.locator("option", { hasText: "E2E Protocol Barbell" })
    ).toHaveCount(0);
    await expect(
      select.locator("option", { hasText: "Road Bike" })
    ).toHaveCount(0);
  });
});
