import { test, expect } from "@playwright/test";

// #747 med parity, in the #817 redesign: the scannable medication ROW on the
// Medications list renders the SAME 14-day adherence summary line and refill badge as
// the supplement row (the shared AdherenceRefill components). On the medication surfaces
// the badge shows both "≈N days left" AND the projected run-out DATE (#852 item 3). The
// seed (e2e/seed-events.ts) ships a CURRENT daily med, "Adherence Refill Med (e2e)",
// with quantity_on_hand set and a run of deterministic all-taken logs, so the row —
// and the /medications/[id] detail it links to — render with stable text. Read-only
// against seeded data.
test("medication row shows the adherence summary and refill badge (#747)", async ({
  page,
}) => {
  await page.goto("/medications");

  // The med renders as a scannable row in the "Current" section.
  const row = page
    .getByTestId("medication-row")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
  await expect(row).toBeVisible();

  // Refill badge — the shared RefillBadge, same `refill-days-left` testid the
  // supplement row uses (#38/#301), naming its estimation basis. On the medication row
  // it also projects the run-out DATE (#852 item 3).
  const badge = row.getByTestId("refill-days-left");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/days?\s+left/);
  await expect(badge).toContainText(/based on (your last 30 days|schedule)/);
  await expect(badge.getByTestId("refill-run-out")).toContainText(/runs out ~/);

  // Adherence summary — the shared AdherenceSummaryLine (#313). The all-taken log
  // run yields a deterministic percentage.
  await expect(row).toContainText(/% adherence/);

  // The same parity widgets render on the clinical-record detail page the row links
  // to (#817) — the row is the scannable index, the detail is the home.
  const detail = page.getByTestId("medication-detail");
  // Direct goto to the row's href (not a Link click): a client-side transition to the
  // detail can be interrupted/reverted under a heavy list page; a full navigation is
  // deterministic (the #852 settle-race fix).
  const href = await row
    .getByTestId("medication-row-link")
    .getAttribute("href");
  expect(href).toMatch(/\/medications\/\d+/);
  await page.goto(href!);
  await expect(detail).toBeVisible();
  const detailBadge = detail.getByTestId("refill-days-left");
  await expect(detailBadge).toBeVisible();
  await expect(detailBadge).toContainText(/days?\s+left/);
  // Same run-out-date parity on the detail card (#852 item 3).
  await expect(detailBadge.getByTestId("refill-run-out")).toContainText(
    /runs out ~/
  );
  await expect(detail).toContainText(/% adherence/);
});
