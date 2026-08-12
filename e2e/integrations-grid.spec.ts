import { test, expect } from "./fixtures";
import { INTEGRATIONS } from "../lib/integrations/registry";

// Registry-driven Import-grid presence check (e2e-efficiency follow-up). The Import
// grid on /data?section=import renders one card PER registry source
// (components/IntegrationsGrid.tsx over lib/integrations/registry.ts): every
// `available` source has a per-source setup page and renders as a <Link> to
// /integrations/<id>, while a `planned` source (Garmin) renders as a non-link
// div. This ONE loop replaces the per-source "shows as a connectable source in
// the Import grid" tests that oura.spec.ts and withings.spec.ts each duplicated
// (one full navigation apiece) — and extends the same guarantee, for free, to the
// sources that had no grid test (Health Connect, Strava, Calendar feed). Each
// source's SPECIFIC setup flow (paste-token, credentials→Connect reveal, OAuth
// callback) stays in its own spec.
//
// Fixture hygiene (#868): read-only against the shared seeded admin session. The
// grid is a static render of the declarative registry — profile 1's connected
// Strava only flips a card badge, never its link/href — so there is no fixture
// ownership or exact-count assertion here.

// The connectable sources, straight from the registry — `available` ones each
// carry a detail route at /integrations/<id> (lib/hrefs.ts INTEGRATION_DETAIL_ROUTES),
// so the grid renders them as links. `planned` sources are excluded (non-link).
const CONNECTABLE = INTEGRATIONS.filter((it) => it.status === "available");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("every available registry source renders as a connectable card in the Import grid", async ({
  page,
}) => {
  await page.goto("/data?section=import");
  const main = page.getByRole("main");

  for (const it of CONNECTABLE) {
    // The card (from the declarative registry) is a link to the source's setup
    // page under /integrations/<id>. Match on the source's registry name (unique
    // across the grid — the only source-name links on the Import section are the
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

// `/integrations` is the visible PARENT of every source's setup route, so it gets
// typed and truncated — and it used to 404 with the grid one click away (#1756). It is
// not a page; it forwards to where the grid actually lives.
test("the bare /integrations path lands on the Import grid instead of a 404", async ({
  page,
}) => {
  await page.goto("/integrations");
  await expect(page).toHaveURL(/\/data\?section=import/);
  await expect(
    page.getByRole("main").getByRole("link", { name: /Patient portals/ })
  ).toBeVisible();
});
