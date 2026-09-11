import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import { followLink } from "./nav";

// PageContainer owns alignment (#3961). The defect was visible, not textual: on a
// wide viewport a 48rem column hugged the LEFT of a ~1770px main area, and walking
// from the episodes index into an episode jumped the column sideways. A class-list
// assertion cannot say where a box actually sits, so this spec measures rendered
// geometry at the owner's viewport — the slack on each side of the page's own
// column, inside the box that column is laid out in.
//
// Both halves matter. Centering is the new default, so the four surfaces the owner
// named must centre; but two families are left-anchored BY DECISION — settings
// beside the sub-nav that selects it, and record/result tab content under its tab
// strip — and the same measurement proves this change did not slide them.

test.use({ viewport: { width: 1800, height: 1000 } });

/** The slack between a page column and the box it is laid out in, per side. */
type Slack = { left: number; right: number };

/**
 * Measure the column the anchor belongs to. With `container`, the column is the
 * anchor's ancestor that sits directly inside that container (a page whose root
 * is the PageContainer); without it, the anchor IS the column and its own parent
 * is the reference box.
 */
async function columnSlack(
  anchor: Locator,
  container?: string
): Promise<Slack> {
  await anchor.waitFor();
  return anchor.evaluate((el, sel) => {
    let column = el as HTMLElement;
    if (sel) {
      while (column.parentElement && !column.parentElement.matches(sel)) {
        column = column.parentElement;
      }
      if (!column.parentElement) {
        throw new Error(`no ancestor of the anchor sits inside ${sel}`);
      }
    }
    const parent = column.parentElement;
    if (!parent) throw new Error("the column has no reference box");
    const box = column.getBoundingClientRect();
    const outer = parent.getBoundingClientRect();
    const style = getComputedStyle(parent);
    return {
      left: box.left - (outer.left + parseFloat(style.paddingLeft)),
      right: outer.right - parseFloat(style.paddingRight) - box.right,
    };
  }, container ?? null);
}

const SHELL = '[data-testid="app-content-container"]';
// Enough spare width that an off-centre column is unmistakable rather than a
// rounding artifact: every capped measure here is far narrower than 1800px.
const ROOM = 200;

function expectCentred(slack: Slack, what: string) {
  expect(
    slack.left + slack.right,
    `${what} has room to be off-centre`
  ).toBeGreaterThan(ROOM);
  expect(
    Math.abs(slack.left - slack.right),
    `${what} sits at ${Math.round(slack.left)}px from the left and ${Math.round(slack.right)}px from the right`
  ).toBeLessThanOrEqual(1);
}

function expectLeftAnchored(slack: Slack, what: string) {
  expect(
    slack.left + slack.right,
    `${what} has room to sit off its left edge`
  ).toBeGreaterThan(ROOM);
  expect(
    slack.left,
    `${what} left its container's left edge by ${Math.round(slack.left)}px`
  ).toBeLessThanOrEqual(1);
}

test("the surfaces that hugged the left now centre in the shell (#3961)", async ({
  page,
}) => {
  test.slow();

  // The episodes INDEX — the surface the owner reported. Its own detail page
  // already centred, which is why the index → episode jump was the tell.
  await page.goto("/medical/episodes");
  expectCentred(
    await columnSlack(
      page.getByRole("heading", { name: "Illness episodes" }),
      SHELL
    ),
    "the illness episodes index"
  );

  // Equipment detail, the one entity detail page that did not centre with its family.
  await page.goto("/equipment");
  await followLink(
    page,
    page
      .getByTestId("equipment-row")
      .filter({ hasText: "E2E Registry Bike" })
      .getByRole("link", { name: /E2E Registry Bike/ }),
    /\/equipment\/\d+$/
  );
  expectCentred(
    await columnSlack(page.getByTestId("equipment-detail")),
    "the equipment detail page"
  );

  // The one integrations page left outside the ruling that centred that family.
  await page.goto("/integrations/patient-portals");
  expectCentred(
    await columnSlack(
      page.getByRole("heading", { name: "Patient portals" }),
      SHELL
    ),
    "the patient portals page"
  );

  // The trends-metric fallback branch: a bad metric URL used to shift the whole
  // page left relative to the real metric page it is reached from.
  await page.goto("/trends/metric/not-a-real-metric");
  expectCentred(
    await columnSlack(page.getByText("Unknown metric."), SHELL),
    "the unknown-metric fallback"
  );
});

test("the left-anchored families stay against their own left edge (#3961)", async ({
  page,
}) => {
  test.slow();

  // A record tab child keeps a stable left edge under the tab strip: centring per
  // tab would slide the content sideways on every tab switch, because sibling tabs
  // cap at different measures inside the same wide shell.
  await page.goto("/records/problems/conditions");
  expectLeftAnchored(
    await columnSlack(page.getByTestId("records-conditions")),
    "the Conditions tab pane"
  );

  // Results flipped from centred to left-anchored to match its sibling shell.
  await page.goto("/results/reports");
  expectLeftAnchored(
    await columnSlack(page.getByTestId("results-reports")),
    "the Reports tab pane"
  );

  // A settings group page stays beside the sub-nav that selects it.
  await page.goto("/settings/display");
  expectLeftAnchored(
    await columnSlack(
      page.getByTestId("distance-unit-select"),
      '[data-testid="settings-group-content"]'
    ),
    "the Display & units form"
  );

  // And the settings index, which is not inside the two-column shell.
  await page.goto("/settings");
  expectLeftAnchored(
    await columnSlack(page.getByTestId("settings-index"), SHELL),
    "the settings index"
  );
});
