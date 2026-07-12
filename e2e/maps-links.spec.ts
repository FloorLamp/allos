import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// "Open in Maps / Directions" deep links (issue #568). The seed plants an
// organization provider "Northside Family Medicine" with a synthetic address
// ("120 Elm St, Springfield"); its provider detail page must expose a Directions
// link pointing at the user's own maps provider (Google Maps universal URL) with
// the address URL-encoded. No navigation is asserted — the whole point is that the
// only outbound data is the address the user chose to click, so we assert the href.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";

function providerId(name: string): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT id FROM providers WHERE name = ? ORDER BY id LIMIT 1")
      .get(name) as { id: number } | undefined;
    if (!row) throw new Error(`no seeded provider "${name}"`);
    return row.id;
  } finally {
    db.close();
  }
}

test("provider detail exposes an Open in Maps link built from the address", async ({
  page,
}) => {
  await page.goto(`/providers/${providerId("Northside Family Medicine")}`);
  const detail = page.getByTestId("provider-detail");
  await expect(detail).toBeVisible();

  const maps = detail.getByTestId("open-in-maps").first();
  await expect(maps).toBeVisible();
  const href = await maps.getAttribute("href");
  // Google Maps universal search URL with the seeded address URL-encoded.
  expect(href).toBe(
    "https://www.google.com/maps/search/?api=1&query=120%20Elm%20St%2C%20Springfield"
  );
  // Opens the user's own maps app in a new context, never an in-app fetch.
  await expect(maps).toHaveAttribute("target", "_blank");
  await expect(maps).toHaveAttribute("rel", "noreferrer");
});
