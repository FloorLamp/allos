import { permanentRedirect } from "next/navigation";

// `/integrations` has never been a page — the integrations grid lives at Data → Import,
// and every per-integration setup page is a CHILD of this path (`/integrations/strava`,
// `/integrations/patient-portals`, …). So a hand-typed parent URL, or a link truncated
// at the first path segment, dead-ended on a 404 with the grid one click away (#1756).
//
// This is a PER-CASE decision, not a restored convention. #1635 removed next.config.js's
// `redirects()` table by owner decision: a route that no longer exists now 404s, and a
// future route merge does not get a redirect by default. Nothing was merged here — this
// path is the visible parent of eight real routes and never resolved to anything — and
// the owner asked for it by name in #1756, which is exactly the per-case decision that
// config comment reserves.
//
// It forwards to where the grid ACTUALLY is, section anchor included, so the URL a person
// guessed lands on the thing they were guessing at.
export default function IntegrationsIndexPage() {
  permanentRedirect("/data?section=import");
}
