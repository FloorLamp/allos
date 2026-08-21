import { test, expect } from "./fixtures";
import { hydratedClick, settledClick } from "./helpers";
import { frozenNow } from "./worker-env";
import { openProtocolFact, withProtocolFact } from "./protocol-form-helpers";
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

    const uniqueName = `E2E Creatine ${Date.now()}`; // clock-ok: unique fixture-name suffix, never a stored timestamp
    // A relative past start so the baseline/intervention windows both have seeded
    // weekly body-metric readings (never a hardcoded date that ages out).
    const start = new Date(frozenNow().getTime() - 42 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await page.goto("/longevity#protocols");
    const main = page.getByRole("main");

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
    await form.getByRole("button", { name: "Create protocol" }).click();

    // Redirects to the detail page.
    await page.waitForURL(/\/protocols\/\d+/);
    const detailMain = page.getByRole("main");
    await expect(detailMain.getByTestId("protocol-header")).toContainText(
      uniqueName
    );
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
      editOutcomes.getByRole("button", { name: "Save outcomes" })
    );
    await expect(
      outcomes.getByRole("button", { name: "Choose outcomes" })
    ).toBeVisible();
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

    // Edit opens a bounded, sectioned modal with persistent actions instead of
    // replacing the narrow detail card inline.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "Edit", exact: true })
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

    // End → Resume stays on the same protocol run inside the seven-day window.
    await hydratedClick(
      page,
      detailMain.getByRole("button", { name: "More protocol actions" })
    );
    await page
      .getByRole("menu")
      .getByRole("button", { name: "End now" })
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
      page.getByRole("menu").getByRole("button", { name: "Resume" })
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
      page.getByRole("menu").getByRole("button", { name: "Run again" })
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
        .getByRole("button", { name: "Delete", exact: true })
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
