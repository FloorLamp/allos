import { test, expect } from "@playwright/test";

// Symptom log (#799). The seed activates the built-in illness-type "Illness" situation, so
// the dashboard Symptoms card is surfaced. This drives the real one-tap card: log two
// symptoms at severities, confirm the chips reflect the worst-severity state, and confirm
// they render on the Timeline day view (the symptom-day event lists the logged symptoms).

test("logs two symptoms at severities from the illness-gated card and they render on the timeline", async ({
  page,
}) => {
  await page.goto("/");

  // The Symptoms card is present because an illness-type situation is active (seed).
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();

  // Log Headache at severity 3.
  const headache3 = page.getByTestId("symptom-headache-sev-3");
  await headache3.click();
  await expect(headache3).toHaveAttribute("aria-pressed", "true");

  // Log Nausea at severity 2.
  const nausea2 = page.getByTestId("symptom-nausea-sev-2");
  await nausea2.click();
  await expect(nausea2).toHaveAttribute("aria-pressed", "true");

  // A re-tap can only RAISE — tapping Headache at severity 1 leaves it at 3.
  await page.getByTestId("symptom-headache-sev-1").click();
  await expect(headache3).toHaveAttribute("aria-pressed", "true");

  // They render on the day: the Timeline shows a symptom-day event listing them.
  await page.goto("/timeline?category=symptom");
  await expect(page.getByText(/symptoms logged/i).first()).toBeVisible();
  await expect(page.getByText("Headache").first()).toBeVisible();
  await expect(page.getByText("Nausea").first()).toBeVisible();
});
