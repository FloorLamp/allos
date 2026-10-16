import { createElement as h } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { deckBasePath } from "./public-paths";
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
  body: () => BodyInit | Promise<BodyInit>,
  type: string,
  csp?: () => string
): Promise<Response> {
  const session = await getCurrentSession();
  if (session?.login.role !== "admin")
    return new Response("Not found", { status: 404 });
  return new Response(await body(), {
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(csp && { "Content-Security-Policy": csp() }),
    },
  });
}

// Deck-ui owns the shell and Health view; the server supplies only the mount.
export const deckHealthHtml = () => {
  const base = deckBasePath();
  return renderToReadableStream(
    h(
      "html",
      { lang: "en" },
      h(
        "head",
        null,
        h("meta", { charSet: "utf-8" }),
        h("meta", {
          name: "viewport",
          content: "width=device-width, initial-scale=1",
        }),
        h("title", null, "Health"),
        h("script", { defer: true, src: "/boarding/client.js" }),
        h("script", { async: true, type: "module", src: `${base}/health.js` })
      ),
      h("body", null, h("main", { id: "health" }))
    )
  );
};

// The module: the bundle's Health mount on the web host, allos registered as a
// backend at this origin. The scopes are the registry's names for the routes the
// session may use (the twins ignore them); no credential is ever in the page.
export const deckHealthScript = (): string => {
  const base = deckBasePath();
  return `import { mountHealth } from "${base}${DECK_UI}/ui/src/mount.js";
import { webHost } from "${base}${DECK_UI}/ui/src/host/web.js";
import { ALLOS_OPS } from "${base}${DECK_UI}/ui/src/host/backends.js";

const places = await (await fetch("${base}${DECK_UI}/ui/contract/places.json")).json();
const origin = location.origin;
for (const place of places) if (place.id === "health") place.href = ${JSON.stringify(base || "/")};
// Keep the pinned host's origin and route validation; scope only its API transport.
const transport = {
  location, navigator, localStorage, WebSocket,
  open: window.open.bind(window), matchMedia: window.matchMedia.bind(window),
  fetch: (input, init) => {
    const url = new URL(input, origin);
    if (url.origin === origin && url.pathname.startsWith("/api/")) url.pathname = ${JSON.stringify(base)} + url.pathname;
    return fetch(url, init);
  },
};
const host = webHost(transport, {
  backends: { allos: { origin, baseUrl: origin, scopes: ["allos:read", "allos:ask", "allos:log"], ops: ALLOS_OPS } },
});
mountHealth(document.getElementById("health"), host, { places });
`;
};
