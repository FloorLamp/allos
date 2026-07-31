import { test, expect } from "./fixtures";
// Date-display coherence (issue #1448). The app already owned a pref-aware
// formatter (#964/#1020) but several surfaces hand-rolled their own shapes, so
// the census found five coexisting date presentations — worst of all two inside
// ONE printed card, and two conventions across three sibling admin tables.
//
// This asserts the two worst cases are now single-family. It deliberately reads
// only SHAPES (a regex over the rendered text), never a specific date, so it is
// independent of the run's frozen clock and of any seeded row's value — and it
// asserts no counts on shared-seed data (#868).

// The vocabulary's year-bearing short form under the default mdy prefs:
// "Jul 24, 2026". The year is the load-bearing part — a printed medication list
// outlives the calendar year it was printed in.
const DATE_WITH_YEAR = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
// The same shape plus a 24h clock: "Jul 24, 2026, 22:14".
const TIMESTAMP = /[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}/;

test("the printable medication list uses ONE date family, and it carries the year (#1448)", async ({
  page,
}) => {
  await page.goto("/medications/print");
  await expect(page.getByTestId("medication-print")).toBeVisible();

  // The "Generated" stamp is a timestamp in the shared shape.
  const generated = page.getByText(/^Generated /);
  await expect(generated).toBeVisible();
  await expect(generated).toHaveText(TIMESTAMP);

  // Every STARTED cell renders the year-bearing short form — never the long
  // "Friday, July 24" that dropped the year inside the current year, which is
  // exactly what made one card carry two formats.
  const started = page.getByTestId("medication-list-view").locator("tbody tr");
  const count = await started.count();
  // Guard the assertion is meaningful without pinning a shared-seed count.
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const cell = started.nth(i).locator("td").last();
    const text = (await cell.innerText()).trim();
    if (text === "—") continue; // no start date recorded
    expect(
      text,
      `a STARTED cell rendered "${text}" — not the one date family`
    ).toMatch(DATE_WITH_YEAR);
  }
});

test("the admin ops tables agree on one timestamp convention (#1448)", async ({
  page,
}) => {
  // Audit rendered SQLite's raw "2026-07-24 22:14:15" while its sibling
  // Errors/AI-log tables called toLocaleString() — three admin screens, two
  // conventions (and, for the client-rendered ones, a server-vs-browser
  // timezone split across hydration). All three now read as UTC through the
  // shared formatter and say so in the column header.
  await page.goto("/settings/audit");
  await expect(
    page.getByRole("columnheader", { name: /Time \(UTC\)/ })
  ).toBeVisible();

  const rows = page.getByTestId("audit-row");
  const auditCount = await rows.count();
  if (auditCount > 0) {
    const first = (await rows.first().locator("td").first().innerText()).trim(); // first-ok: any audit row proves the column's rendered shape — order-agnostic
    expect(first, "the audit Time column is not in the shared shape").toMatch(
      TIMESTAMP
    );
    // And specifically NOT the raw SQLite serialization it used to print.
    expect(first).not.toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }

  // The Errors table is the sibling that has to agree.
  await page.goto("/settings/errors");
  await expect(page.getByTestId("error-log")).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: /Time \(UTC\)/ })
  ).toBeVisible();
});
