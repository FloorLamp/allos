import { test, expect } from "@playwright/test";

// #747 med parity, in the #817 redesign: the scannable medication ROW on the
// Medications list renders the SAME 14-day adherence summary line and "≈N days left"
// refill badge as the supplement row (the shared AdherenceRefill components). The
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
  // supplement row uses (#38/#301), naming its estimation basis.
  const badge = row.getByTestId("refill-days-left");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/days?\s+left/);
  await expect(badge).toContainText(/based on (your last 30 days|schedule)/);

  // Adherence summary — the shared AdherenceSummaryLine (#313). The all-taken log
  // run yields a deterministic percentage.
  await expect(row).toContainText(/% adherence/);

  // The same parity widgets render on the clinical-record detail page the row links
  // to (#817) — the row is the scannable index, the detail is the home.
  const detail = page.getByTestId("medication-detail");
  // Ride out the hydration window (#730): retry the navigation until detail shows.
  await expect(async () => {
    await row.getByTestId("medication-row-link").click();
    await expect(detail).toBeVisible({ timeout: 2000 });
  }).toPass();
  await expect(detail.getByTestId("refill-days-left")).toBeVisible();
  await expect(detail).toContainText(/% adherence/);
});
