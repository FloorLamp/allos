import { test, expect } from "./fixtures";

// The appearance-palette picker (#2701). The palette choice is DEVICE-scoped:
// it lives in localStorage beside the `theme` key, is stamped on <html> as
// `data-palette` pre-paint by the boot script, applied live by the picker, and
// re-asserted on route changes by ThemeReassert. The base palette (Botanical)
// is the ABSENCE of the attribute — so the spec proves both directions: picking
// a palette sets it and survives a reload; picking the base removes it.

test("picking a palette applies it live, survives reload, and the base removes it", async ({
  page,
}) => {
  await page.goto("/settings/display");
  const picker = page.getByTestId("appearance-picker");
  await expect(picker).toBeVisible();

  // The default state: base palette, no attribute, Botanical marked selected.
  await expect(page.locator("html")).not.toHaveAttribute("data-palette");
  await expect(
    page.getByTestId("appearance-palette-botanical")
  ).toHaveAttribute("aria-pressed", "true");

  // Pick Almanac: the attribute lands immediately (no reload needed) and the
  // ruled-paper token block engages — the card surface goes warm paper.
  await page.getByTestId("appearance-palette-almanac").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "almanac");
  await expect(page.getByTestId("appearance-palette-almanac")).toHaveAttribute(
    "aria-pressed",
    "true"
  );

  // Survives a full reload: the boot script stamps the attribute pre-paint from
  // the same storage key the picker wrote.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "almanac");

  // And a client-side route change (ThemeReassert re-applies, never clears).
  await page
    .locator("aside nav")
    .getByRole("link", { name: "Upcoming" })
    .click();
  await expect(page).toHaveURL(/\/upcoming$/);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "almanac");

  // Back to the picker; choosing the base REMOVES the attribute rather than
  // writing a third value — the base tokens carry no [data-palette] scope.
  await page.goto("/settings/display");
  await page.getByTestId("appearance-palette-floodlight").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-palette",
    "floodlight"
  );
  await page.getByTestId("appearance-palette-botanical").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-palette");
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute("data-palette");
});
