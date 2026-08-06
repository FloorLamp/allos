import { test, expect } from "./fixtures";
import { settledFill, settledSelectSave } from "./helpers";
import type { Locator, Page } from "@playwright/test";

// A free-text field here saves ON BLUR (the settings-form contract), so the fill
// alone writes nothing: move focus off the field, then wait out the card's autosave
// before touching the next control — otherwise the next interaction races a save
// still in flight. settledFill owns the pre-hydration retry; the blur is what
// commits; the spinner going away is what says it landed.
async function fillAndSave(
  page: Page,
  field: Locator,
  value: string,
  scope: Locator
): Promise<void> {
  await settledFill(page, field, value);
  await field.blur();
  await expect(scope.getByLabel("Saving")).toHaveCount(0);
}

// Advance directives on the emergency card (#1848): code status, healthcare proxy,
// organ-donor status and the documents-on-file line — the first facts an ED asks
// for, which the card previously could not hold at all. Everything is edited inline
// in the Passport's #emergency section (the #1087 co-location), autosaves, and then
// has to appear on BOTH artifacts the page carries: the emergency card and the
// passport summary above it.
test("code status, proxy and donor status save inline and render on the card and passport (#1848)", async ({
  page,
}) => {
  // Several full navigations, and local `next dev` compiles /profile on first hit.
  test.slow();

  await page.goto("/profile#emergency");
  const settings = page.getByTestId("advance-directives-settings");
  await expect(settings).toBeVisible();

  // The emergency card only assembles when the offline opt-in is on — the same
  // toggle this section sits beside. Turn it on if a previous iteration left it off.
  const toggle = page.getByTestId("emergency-toggle");
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await expect(page.getByTestId("emergency-card")).toBeVisible();
  }

  // Each control autosaves in place: select on change, free text on blur.
  await settledSelectSave(
    page,
    settings.getByTestId("code-status-select"),
    "dnr-dni",
    settings
  );
  await fillAndSave(
    page,
    settings.getByTestId("code-status-note"),
    "Intubate for a reversible cause",
    settings
  );
  await fillAndSave(
    page,
    settings.getByTestId("proxy-name"),
    "Robin Reyes",
    settings
  );
  await fillAndSave(
    page,
    settings.getByTestId("proxy-phone"),
    "555-0100",
    settings
  );
  await settledSelectSave(
    page,
    settings.getByTestId("organ-donor-select"),
    "registered",
    settings
  );
  await fillAndSave(
    page,
    settings.getByTestId("directive-documents"),
    "POLST on the fridge",
    settings
  );

  // The card carries every recorded fact, with the free-text qualifier verbatim.
  // Asserted on the LIVE page first: each save revalidates /profile, so the card
  // below the form re-renders with the new fact — that is the signal the write
  // landed, and it is what makes the reload below a persistence check rather than
  // a race.
  const directives = page.getByTestId("emergency-directives");
  await expect(directives).toBeVisible();
  await expect(page.getByTestId("emergency-code-status")).toContainText(
    "DNR / DNI"
  );
  await expect(page.getByTestId("emergency-code-status-note")).toHaveText(
    "Intubate for a reversible cause"
  );
  await expect(page.getByTestId("emergency-proxy")).toContainText(
    "Robin Reyes"
  );
  await expect(page.getByTestId("emergency-proxy")).toContainText("555-0100");
  await expect(page.getByTestId("emergency-organ-donor")).toContainText(
    "Registered organ donor"
  );
  await expect(page.getByTestId("emergency-directive-documents")).toContainText(
    "POLST on the fridge"
  );
  // The card says what it is NOT: a summary, never the signed instrument.
  await expect(directives).toContainText(
    "the signed document itself is not stored here"
  );

  // …and the passport summary above it shows the same facts (one settings read,
  // two surfaces — they cannot disagree).
  const passportDirectives = page.getByTestId("passport-directives");
  await expect(passportDirectives).toContainText("DNR / DNI");
  await expect(passportDirectives).toContainText("Robin Reyes");

  // The values survive a reload (they are stored profile facts, not form state).
  await page.reload();
  await expect(page.getByTestId("emergency-code-status")).toContainText(
    "DNR / DNI"
  );
  await expect(settings.getByTestId("code-status-select")).toHaveValue(
    "dnr-dni"
  );
  await expect(settings.getByTestId("organ-donor-select")).toHaveValue(
    "registered"
  );
});
