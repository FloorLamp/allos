import { test, expect } from "@playwright/test";
import { INTEGRATIONS } from "../lib/integrations/registry";

// Registry-driven Import-grid presence check (e2e-efficiency follow-up). The Import
// grid on /data?section=import renders one card PER registry provider
// (components/IntegrationsGrid.tsx over lib/integrations/registry.ts): every
// `available` provider has a per-provider setup page and renders as a <Link> to
// /integrations/<id>, while a `planned` provider (Garmin) renders as a non-link
// div. This ONE loop replaces the per-provider "shows as a connectable provider in
// the Import grid" tests that oura.spec.ts and withings.spec.ts each duplicated
// (one full navigation apiece) — and extends the same guarantee, for free, to the
// providers that had no grid test (Health Connect, Strava, Calendar feed). Each
// provider's SPECIFIC setup flow (paste-token, credentials→Connect reveal, OAuth
// callback) stays in its own spec.
//
// Fixture hygiene (#868): read-only against the shared seeded admin session. The
// grid is a static render of the declarative registry — profile 1's connected
// Strava only flips a card badge, never its link/href — so there is no fixture
// ownership or exact-count assertion here.

// The connectable providers, straight from the registry — `available` ones each
// carry a detail route at /integrations/<id> (lib/hrefs.ts INTEGRATION_DETAIL_ROUTES),
// so the grid renders them as links. `planned` providers are excluded (non-link).
const CONNECTABLE = INTEGRATIONS.filter((it) => it.status === "available");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("every available registry provider renders as a connectable card in the Import grid", async ({
  page,
}) => {
  await page.goto("/data?section=import");
  const main = page.getByRole("main");

  for (const it of CONNECTABLE) {
    // The card (from the declarative registry) is a link to the provider's setup
    // page under /integrations/<id>. Match on the provider's registry name (unique
    // across the grid — the only provider-name links on the Import section are the
    // grid cards); pin the href to the canonical detail route.
    const card = main.getByRole("link", {
      name: new RegExp(escapeRegExp(it.name)),
    });
    await expect(card, it.name).toBeVisible();
    await expect(card, it.name).toHaveAttribute(
      "href",
      `/integrations/${it.id}`
    );
  }
});
