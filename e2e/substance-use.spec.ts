import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_SUBSTANCE,
  E2E_LOGIN_CHILD,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";

// Substance-use domain (issues #998, #1078, #1085): the Records › Specialty ›
// Substance use section (#1175, formerly the standalone /medical/substance-use
// page) — in-app AUDIT-C and DAST-10 tap-throughs (banded scores; DAST-10 since
// #1085, incl. its reverse-scored item), outside total-only entry for the AUDIT
// (its item text isn't shipped), one-tap consumption logging per substance
// (alcohol on the shared food-log ledger; nicotine/cannabis on the dedicated
// substance_log ledger, #1078), and per-substance weekly-cap reduction targets
// with their calm progress lines. No streaks, no celebration anywhere.
// LIFE-STAGE gated (#1174): adult-validated instruments, so the section + its
// jump-link hide for a known minor and the route re-gates a direct URL.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_SUBSTANCE in its OWN
// cookie context on a dedicated, substance-data-free adult profile. Every
// assertion is RELATIVE (before/after counts, idempotent cap upserts), so
// --repeat-each stays clean without reseeding. Interactions settle via
// settledClick.

async function weekCount(page: Page, substance: string): Promise<number> {
  const text = await page
    .getByTestId(`substance-week-count-${substance}`)
    .innerText();
  return Number(text.trim().split(/\s+/)[0]);
}

test.describe("substance use (#998/#1078/#1085)", () => {
  // Serial: every test mutates the ONE shared fixture profile and asserts
  // relative before/after counts. CI runs workers=1 anyway; this pins the same
  // ordering for multi-worker local runs (the sibling-spec precedent).
  test.describe.configure({ mode: "serial" });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_SUBSTANCE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("adult: the section renders as a Records › Specialty pane with a jump-link (#1175)", async () => {
    // Landing on a sibling specialty pane, the sub-tab strip carries the
    // Substance use jump-link (the section-visibility predicate is true for an
    // adult), and it points at the folded section route — no standalone page.
    await page.goto("/records/specialty/skin");
    const subTab = page
      .getByTestId("records-sub-tabs")
      .getByRole("link", { name: "Substance use" });
    await expect(subTab).toBeVisible();
    await expect(subTab).toHaveAttribute(
      "href",
      "/records/specialty/substance-use"
    );

    // The section itself renders the screening form.
    await page.goto("/records/specialty/substance-use");
    await expect(page.getByTestId("records-substance-use")).toBeVisible();
    await expect(page.getByTestId("substance-instruments-form")).toBeVisible();

    // The old standalone route is gone with NO redirect (#1175 standing
    // preference) — a stale bookmark 404s.
    const res = await page.goto("/medical/substance-use");
    expect(res?.status()).toBe(404);
  });

  test("in-app AUDIT-C computes a banded total and records a score", async () => {
    await page.goto("/records/specialty/substance-use");
    await expect(page.getByTestId("substance-instruments-form")).toBeVisible();

    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    // AUDIT-C is the default selection; 3 items × option 1 = total 3 → Lower risk.
    for (let i = 0; i < 3; i++) {
      await page.getByTestId(`substance-option-${i}-1`).click();
    }
    await expect(page.getByTestId("substance-total")).toHaveText("3");
    await expect(page.getByTestId("substance-band")).toContainText(
      "Lower risk"
    );

    await settledClick(page, page.getByTestId("substance-instrument-submit"));
    await expect(rows).toHaveCount(before + 1);
  });

  test("in-app DAST-10 (#1085): 10-item tap-through with the reverse-scored item, banded total", async () => {
    await page.goto("/records/specialty/substance-use");
    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    await settledClick(
      page,
      page.getByTestId("substance-instrument-select-DAST-10")
    );
    // The in-app tap-through renders (no total-only note), with the instrument's
    // past-12-months framing and all 10 items.
    await expect(page.getByTestId("substance-total-only-note")).toHaveCount(0);
    await expect(
      page.getByTestId("substance-instrument-instructions")
    ).toContainText("past 12 months");
    await expect(page.getByTestId("substance-item-9")).toBeVisible();

    // The reverse-scored item 3 flips its options: its 1-point answer is "No",
    // while a normal item's 1-point answer is "Yes" (pins the #1085 encoding in
    // the rendered UI).
    await expect(page.getByTestId("substance-option-2-1")).toHaveText("No");
    await expect(page.getByTestId("substance-option-0-1")).toHaveText("Yes");

    // Lowest-risk answer everywhere (option value 0 — "No" on normal items,
    // "Yes" on the reverse item) → total 0 → "None reported".
    for (let i = 0; i < 10; i++) {
      await page.getByTestId(`substance-option-${i}-0`).click();
    }
    await expect(page.getByTestId("substance-total")).toHaveText("0");
    await expect(page.getByTestId("substance-band")).toContainText(
      "None reported"
    );

    await settledClick(page, page.getByTestId("substance-instrument-submit"));
    await expect(rows).toHaveCount(before + 1);
  });

  test("AUDIT stays total-only (no reproduced items) and records an outside total", async () => {
    await page.goto("/records/specialty/substance-use");
    const rows = page.getByTestId(/^substance-reading-\d+$/);
    const before = await rows.count();

    await settledClick(
      page,
      page.getByTestId("substance-instrument-select-AUDIT")
    );
    // No item tap-through renders — only the total-only note + total input.
    await expect(page.getByTestId("substance-total-only-note")).toBeVisible();
    await expect(page.getByTestId("substance-item-0")).toHaveCount(0);

    await page.getByTestId("substance-outside-total").fill("2");
    await settledClick(
      page,
      page.getByTestId("substance-instrument-submit-outside")
    );
    await expect(rows).toHaveCount(before + 1);
  });

  test("one tap logs a standard drink into this week's alcohol count", async () => {
    await page.goto("/records/specialty/substance-use");
    const before = await weekCount(page, "alcohol");

    await settledClick(page, page.getByTestId("substance-log-alcohol"));
    // The count is server-rendered and lands with the router refresh that follows
    // the settled action POST — a plain retrying web-first assertion covers it.
    const after = before + 1;
    await expect(page.getByTestId("substance-week-count-alcohol")).toHaveText(
      `${after} standard ${after === 1 ? "drink" : "drinks"} logged this week.`
    );
  });

  test("nicotine (#1078): its own section logs uses one tap at a time, and undo reverses", async () => {
    await page.goto("/records/specialty/substance-use");
    const before = await weekCount(page, "nicotine");

    await settledClick(page, page.getByTestId("substance-log-nicotine"));
    const after = before + 1;
    await expect(page.getByTestId("substance-week-count-nicotine")).toHaveText(
      `${after} ${after === 1 ? "use" : "uses"} logged this week.`
    );

    await settledClick(page, page.getByTestId("substance-undo-nicotine"));
    await expect(page.getByTestId("substance-week-count-nicotine")).toHaveText(
      `${before} ${before === 1 ? "use" : "uses"} logged this week.`
    );

    // The cannabis section renders independently alongside (#1078).
    await expect(page.getByTestId("substance-log-cannabis")).toBeVisible();
  });

  test("an alcohol weekly cap shows the calm progress line; removing it clears the line", async () => {
    await page.goto("/records/specialty/substance-use");

    await page.getByTestId("substance-cap-input-alcohol").fill("7");
    await settledClick(page, page.getByTestId("substance-cap-save-alcohol"));
    const progress = page.getByTestId("substance-cap-progress-alcohol");
    await expect(progress).toBeVisible();
    // "N of your 7-drink weekly cap used." (or the over-cap phrasing if repeats
    // accumulated) — either way the cap is named, and never a streak/badge.
    await expect(progress).toContainText("7-drink weekly cap");
    await expect(progress).not.toContainText("streak");

    await settledClick(page, page.getByTestId("substance-cap-clear-alcohol"));
    await expect(progress).toHaveCount(0);
  });

  test("a nicotine weekly cap (#1078) speaks use-wording and clears cleanly", async () => {
    await page.goto("/records/specialty/substance-use");

    await page.getByTestId("substance-cap-input-nicotine").fill("7");
    await settledClick(page, page.getByTestId("substance-cap-save-nicotine"));
    const progress = page.getByTestId("substance-cap-progress-nicotine");
    await expect(progress).toBeVisible();
    await expect(progress).toContainText("7-use weekly cap");
    await expect(progress).not.toContainText("streak");

    await settledClick(page, page.getByTestId("substance-cap-clear-nicotine"));
    await expect(progress).toHaveCount(0);
  });
});

// The #1174 life-stage gate: a KNOWN minor (the seeded "Riley (child)" profile, an
// infant) never sees the adult-validated substance-use section. Defense in depth —
// the specialty jump-link is absent AND a direct route hit re-gates to the first
// visible specialty pane (Skin), never rendering the section. Read-only: reuses the
// E2E_LOGIN_CHILD fixture (Riley is its sole/active profile), mutates nothing.
test("known-minor: the substance-use section + its jump-link are absent, and the route re-gates (#1174)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_CHILD,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // On a sibling specialty pane, the sub-tab strip drops the Substance use
    // jump-link (Mental health stays — it is NOT life-stage gated).
    await page.goto("/records/specialty/skin");
    const subTabs = page.getByTestId("records-sub-tabs");
    await expect(
      subTabs.getByRole("link", { name: "Substance use" })
    ).toHaveCount(0);
    await expect(
      subTabs.getByRole("link", { name: "Mental health" })
    ).toBeVisible();

    // A direct URL re-gates server-side to the first visible pane (Skin) — the
    // section never renders for a minor.
    await page.goto("/records/specialty/substance-use");
    await expect(page).toHaveURL(/\/records\/specialty\/skin$/);
    await expect(page.getByTestId("records-substance-use")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
