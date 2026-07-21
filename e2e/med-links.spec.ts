import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// #1051 med↔prescriber + #1052 med↔indication display. Read-only over the deterministic
// seed fixture: Sertraline is linked to the individual prescriber "Dr. Anita Patel" and
// (as its indication) the "Major depressive disorder" condition. The med detail shows a
// linked prescriber + a "For:" line; the /records conditions list shows "Treated with:".
// No mutation, so it is safe under --repeat-each.

test("medication detail shows the linked prescriber and 'For:' indication", async ({
  page,
}) => {
  await page.goto("/medications");
  // Into the Sertraline detail via its list-row link.
  await followLink(
    page,
    page.getByRole("link", { name: /Sertraline/i }).first(), // first-ok: on profile 1 the seed has one Sertraline med; it renders in both the out-of-supply Today band and the list, both linking the same /medications/<id> detail ("Sertraline 50 mg" lives on a separate isolated fixture profile)
    /\/medications\/\d+/
  );

  // The linked prescriber (registry name), via the shared ProviderName link.
  await expect(
    page.getByRole("link", { name: /Dr\. Anita Patel/i })
  ).toBeVisible();

  // The "For:" indication line links the condition.
  const indication = page.getByTestId("medication-indication");
  await expect(indication).toBeVisible();
  await expect(indication).toContainText("Major depressive disorder");
});

test("condition list shows 'Treated with:' the linked medication", async ({
  page,
}) => {
  await page.goto("/records/problems");
  const treated = page
    .getByTestId("condition-treated-with")
    .filter({ hasText: "Sertraline" });
  await expect(treated.first()).toBeVisible(); // first-ok: filtered to the one seed condition (MDD) treated with Sertraline on profile 1 — deterministic single match
  await expect(treated.first()).toContainText("Treated with:"); // first-ok: same filtered MDD row as above
});
