import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCurrentSession } from "./auth";
import pin from "./deck-ui-pin.json";

// Deck's web UI (spaceport deck/ui), the pinned version vendored into public/deck-ui/
// by scripts/deck-ui.mjs and served from there at /deck-ui/<version>/…. Never fetched
// at runtime. The Health place (app/deck/health) mounts its Health views with its web
// host on this origin's session-authenticated /api twins (docs/device-api.md).

export const DECK_UI = `/deck-ui/${pin.version}`;

// The CSP the pinned bundle declares for its pages (ui/contract/host-contract.json);
// the place's route sets it, so middleware leaves that one path to it (isDeckPlacePath).
export function deckUiCsp(): string {
  const contract = JSON.parse(
    readFileSync(
      join(process.cwd(), "public", DECK_UI, "ui/contract/host-contract.json"),
      "utf8"
    )
  ) as { csp: string };
  return contract.csp;
}

// The place is the owner's, exactly like /v1/me's `owner`: allos's admin role. Anyone
// else, signed in or not, gets a 404 (an anonymous request never reaches here:
// middleware sends it to the login).
export async function ownerOnly(
  body: () => string,
  type: string,
  csp?: () => string
): Promise<Response> {
  const session = await getCurrentSession();
  if (session?.login.role !== "admin")
    return new Response("Not found", { status: 404 });
  return new Response(body(), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(csp && { "Content-Security-Policy": csp() }),
    },
  });
}

// The page: no inline script (the CSP is script-src 'self'); its one module is
// DECK_HEALTH_SCRIPT.
export const DECK_HEALTH_SCRIPT = "/deck/health.js";
export const deckHealthHtml = (): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health</title>
<link rel="stylesheet" href="${DECK_UI}/ui/src/tokens.css">
<link rel="stylesheet" href="${DECK_UI}/ui/src/base.css">
<script defer src="/boarding/client.js"></script>
<script type="module" src="${DECK_HEALTH_SCRIPT}"></script>
</head>
<body>
<main id="health"></main>
</body>
</html>
`;

// The module: the bundle's Health mount on the web host, allos registered as a
// backend at this origin. The scopes are the registry's names for the routes the
// session may use (the twins ignore them); no credential is ever in the page.
export const deckHealthScript = (): string =>
  `import { mountHealth } from "${DECK_UI}/ui/src/mount.js";
import { webHost } from "${DECK_UI}/ui/src/host/web.js";
import { ALLOS_OPS } from "${DECK_UI}/ui/src/host/backends.js";

const places = await (await fetch("${DECK_UI}/ui/contract/places.json")).json();
const origin = location.origin;
const host = webHost(window, {
  backends: { allos: { origin, baseUrl: origin, scopes: ["allos:read", "allos:ask", "allos:log"], ops: ALLOS_OPS } },
});
mountHealth(document.getElementById("health"), host, { places });
`;
