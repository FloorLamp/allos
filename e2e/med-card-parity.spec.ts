import { test, expect } from "@playwright/test";

// #747 med-card parity: the medication CARD now renders the SAME 14-day adherence
// summary line and "≈N days left" refill badge as the supplement row — it
// previously received neither `strip` nor `refillRate`, so the page computed the
// strip for every medication and discarded it. The seed (e2e/seed-events.ts) ships
// a CURRENT daily med, "Adherence Refill Med (e2e)", with quantity_on_hand set and
// a run of deterministic all-taken logs, so both surfaces render with stable text.
// Read-only against seeded data — nothing to clean up.
test("medication card shows the adherence summary and refill badge (#747)", async ({
  page,
}) => {
  await page.goto("/medications");

  // The med renders in the (always-open) "Current" section on the Medications page.
  const card = page
    .locator("div.card")
    .filter({ hasText: "Adherence Refill Med (e2e)" });
  await expect(card).toBeVisible();

  // Refill badge — the shared RefillBadge, same `refill-days-left` testid the
  // supplement row uses (#38/#301), naming its estimation basis.
  const badge = card.getByTestId("refill-days-left");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(/days?\s+left/);
  await expect(badge).toContainText(/based on (your last 30 days|schedule)/);

  // Adherence summary — the shared AdherenceSummaryLine (#313). The all-taken log
  // run yields a deterministic percentage.
  await expect(card).toContainText(/% adherence/);
});
