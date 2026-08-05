import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { type Locator, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import {
  hydratedClick,
  openMeasurementGroup,
  settledClick,
  settledFill,
} from "./helpers";
import { workerDbPath } from "./worker-env";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// The "Log measurements" form's LAYOUT and DISCLOSURE (issue #2014).
//
// The form is authored once and mounted in hosts of very different widths, and its
// grid used to ask the WINDOW (`sm:grid-cols-2 lg:grid-cols-4`). At a 1280px desktop
// that laid four columns into the ~400px quick-entry sheet: 91px cells, wrapped
// labels, and unit rows whose min-content painted straight through the panel edge.
//
// So the assertion here is HOST-WIDTH AWARE rather than a class-name check: measure
// every field against the box it is actually inside, at the viewport where the bug
// appeared. A class assertion would have passed the whole time the screenshot was
// failing.

const LOG_DATE = "2026-01-03"; // deep past — no seeded row for profile 1 to collide with
const LOG_WEIGHT = "71.3";
const DB_PATH = workerDbPath();

function clearLoggedWeight(): void {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM body_metrics WHERE profile_id = 1 AND date = ?")
      .run(LOG_DATE);
  } finally {
    handle.close();
  }
}

// Every visible field of the form, measured against the CONTENT BOX of the host it
// is mounted in — the panel's border box less its own padding. Grid items do not
// clip, so an overflowing cell paints over its neighbour or past the panel edge;
// this catches both directions.
async function expectFieldsInsideHost(
  page: Page,
  hostSelector: string
): Promise<void> {
  const offenders = await page.evaluate((selector) => {
    const host = document.querySelector(selector);
    const form = document.getElementById("measurements-quick-add");
    if (!host || !form) return [`missing ${!host ? selector : "form"}`];
    const style = getComputedStyle(host);
    const box = host.getBoundingClientRect();
    const left = box.left + parseFloat(style.paddingLeft);
    const right = box.right - parseFloat(style.paddingRight);
    const bad: string[] = [];
    for (const el of Array.from(
      form.querySelectorAll("input, select, textarea, label")
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // inside a collapsed group
      if (r.right > right + 1 || r.left < left - 1) {
        bad.push(
          `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}> ` +
            `${Math.round(r.left)}–${Math.round(r.right)} vs content box ` +
            `${Math.round(left)}–${Math.round(right)}`
        );
      }
    }
    return bad;
  }, hostSelector);
  expect(offenders, offenders.join("\n")).toEqual([]);
}

async function openEveryGroup(page: Page, form: Locator): Promise<void> {
  for (const group of ["vitals", "body", "sleep"] as const) {
    await openMeasurementGroup(page, form, group);
  }
}

test("the quick-entry sheet's fields stay inside the panel at a desktop viewport", async ({
  browser,
}) => {
  // The vitals card's "Log reading" (#1892) opens the shared form in the quick-entry
  // BottomSheet — the ~400px host the four-column grid was overflowing, on the
  // 1280px viewport that made it four columns.
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    await page
      .getByRole("main")
      .getByTestId("vitals-latest-widget")
      .getByTestId("vitals-log-reading")
      .click();
    await expect(page.getByTestId("quick-entry-body")).toHaveAttribute(
      "data-form",
      "measurements"
    );
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // The entry point decides the open group: this button is on the vitals card.
    await expect(
      form.locator("#measurements-group-vitals-fields")
    ).toBeVisible();
    await expect(form.locator("#measurements-group-body-fields")).toBeHidden();

    await openEveryGroup(page, form);
    await expectFieldsInsideHost(page, "[data-sheet-panel]");
  } finally {
    await page.context().close();
  }
});

test("the Trends modal's fields stay inside the modal at a desktop viewport", async ({
  page,
}) => {
  test.slow();
  await page.goto("/trends");
  await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
  const form = page.getByTestId("measurements-quick-add");
  await expect(form).toBeVisible();

  // Trends → Body opens Body — the SAME component, a different entry point.
  await expect(form.locator("#measurements-group-body-fields")).toBeVisible();

  await openEveryGroup(page, form);
  await expectFieldsInsideHost(
    page,
    '[data-testid="log-measurements-modal-body"]'
  );
});

test("a collapsed group announces its value and still saves it", async ({
  page,
}) => {
  test.slow();
  clearLoggedWeight();
  try {
    await page.goto("/trends");
    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // A deep-past date so this write owns its row outright. settledFill can't
    // express this one: DateField accepts ISO and then re-renders the COMMITTED
    // value in the display format, so the post-fill assertion is that reformat —
    // which is itself the proof React took the value (a pre-hydration fill would
    // sit there as the raw ISO string until hydration reverted it).
    const dateField = form.locator("#m-date");
    await expect(async () => {
      await dateField.fill(LOG_DATE);
      await expect(dateField).toHaveValue(/Jan 3, 2026|2026-01-03/, {
        timeout: 2_000,
      });
    }).toPass({ timeout: 10_000 }); // topass-ok: hydration-guarded fill of a controlled date field — absolute value, so re-application is a no-op (the settledFill contract, with the display-format reformat as the settle)
    const weight = form.locator("#m-weight");
    await settledFill(page, weight, LOG_WEIGHT);

    // Collapse the group holding it. HIDDEN, NOT UNMOUNTED: the input keeps its
    // value, so the form still posts it — and the header says what is behind the
    // chevron, so the value is never invisible.
    await hydratedClick(
      page,
      form.getByTestId("measurements-group-body-toggle")
    );
    await expect(form.locator("#measurements-group-body-fields")).toBeHidden();
    await expect(
      form.getByTestId("measurements-group-body-summary")
    ).toContainText(LOG_WEIGHT);
    await expect(weight).toHaveValue(LOG_WEIGHT);

    await settledClick(
      page,
      form.getByRole("button", { name: "Save measurements" })
    );
    await expect(page.getByText("Measurements saved")).toBeVisible();

    // Server truth, not the toast: the collapsed field reached the write core.
    const handle = new Database(DB_PATH);
    try {
      const row = handle
        .prepare(
          "SELECT weight_kg FROM body_metrics WHERE profile_id = 1 AND date = ?"
        )
        .get(LOG_DATE) as { weight_kg: number } | undefined;
      expect(row?.weight_kg).toBeCloseTo(Number(LOG_WEIGHT), 1);
    } finally {
      handle.close();
    }
  } finally {
    clearLoggedWeight();
  }
});
