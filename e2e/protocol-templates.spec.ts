import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// Sun-exposure protocol template (issue #571). The Protocols page shows a
// "Start from a template" strip; picking one prefills the add form (name, notes,
// practice) so the user can review and save — the template never creates a
// protocol on its own.
test("the Sun exposure template prefills the add-protocol form", async ({
  page,
}) => {
  await page.goto("/longevity#protocols");

  const strip = page.getByTestId("protocol-templates");
  await expect(strip).toBeVisible();
  const sun = page.getByTestId("protocol-template-sun-exposure");
  await expect(sun).toBeVisible();
  await sun.click();

  await expect(page).toHaveURL(/\/longevity\?template=sun-exposure/);
  // The add form is prefilled with the template's name.
  const form = page.getByTestId("protocol-form");
  await expect(form.locator('input[name="name"]')).toHaveValue(
    "Daily daylight walk"
  );
  // Notes carry the observational framing (never prescriptive).
  await expect(form.locator('textarea[name="notes"]')).toContainText(
    /observational/i
  );

  // "Clear" returns to a blank form (nav anchor → followLink, #889 sweep).
  await followLink(
    page,
    page.getByRole("link", { name: "Clear" }),
    /\/longevity#protocols$/
  );
  await expect(
    page.getByTestId("protocol-form").locator('input[name="name"]')
  ).toHaveValue("");
});
