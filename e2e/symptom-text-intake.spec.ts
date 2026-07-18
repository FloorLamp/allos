import { test, expect } from "@playwright/test";

// Free-text symptom intake (#877) — offline-first degradation. The e2e DB boots
// WITHOUT an AI tier, so the AI intake field is absent and the manual tap path is the
// whole story. The field is gated on a configured Light tier, so this asserts
// whichever state holds (without depending on global tier config a neighbor spec might
// touch) — the manual add path is ALWAYS present, and the AI field, when it renders,
// is clearly suggest-only. Read-only, so it's safe under --repeat-each.
test("free-text symptom intake is suggest-only and degrades to taps offline", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("symptom-log-bar").first();
  await expect(bar).toBeVisible();
  if ((await bar.getByTestId("symptom-add-picker").count()) === 0) {
    await bar.getByTestId("symptom-add-picker-toggle").click();
  }
  await expect(bar.getByTestId("symptom-add-picker")).toBeVisible();
  // Offline-first: the manual free-text ADD (a plain tap-equivalent) is always there,
  // regardless of AI configuration.
  await expect(bar.getByTestId("symptom-custom-input")).toBeVisible();
  // The AI free-text intake is gated on a Light tier. When present, it is clearly
  // suggest-only (a "Suggest" button, not a silent write) — never a silent insert.
  const intake = bar.getByTestId("symptom-text-intake");
  if ((await intake.count()) > 0) {
    await expect(intake.getByTestId("symptom-text-suggest")).toBeVisible();
  }
});
