import type { MetadataRoute } from "next";

// Web app manifest — makes Allos installable to the home screen. Next serves
// this at /manifest.webmanifest and auto-injects the <link rel="manifest"> into
// every page's <head>. Kept in sync with the brand assets: icons reuse the
// existing /icon.svg (the allostatic-wave mark, single source lib/logo.ts) and
// the /apple-icon route. sharp/rsvg aren't installed, so we lean on the SVG
// (which Chrome accepts for install, including maskable) rather than shipping
// generated PNGs. Colors match the app's dark near-black canvas so the splash
// screen and status bar read as one surface with the icon's dark tile.
//
// NOTE: /manifest.webmanifest is added to middleware's public allowlist so it
// loads on the login page (a standalone launch starts unauthenticated).
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Allos",
    short_name: "Allos",
    description: "Health tracking and coaching for stability through change",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Match the icon tile / dark page background so the launch splash is seamless.
    background_color: "#090c0b",
    theme_color: "#090c0b",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
