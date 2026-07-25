import type { MetadataRoute } from "next";
import { PWA_SHORTCUTS } from "@/lib/pwa-shortcuts";

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
    // Long-press the installed icon → the OS app-shortcut menu (issue #1424).
    // The list, its labels, and its `?quick=` URLs all come from
    // lib/pwa-shortcuts.ts, which derives the quick-log names from the SAME
    // QUICK_LOG_ITEMS registry the in-app sheet renders — so a renamed action
    // renames here too. Each entry reuses the app icon; the OS badges it with
    // the app mark anyway, and no per-action art exists.
    shortcuts: PWA_SHORTCUTS.map((s) => ({
      name: s.name,
      short_name: s.name,
      description: s.description,
      url: s.url,
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    })),
  };
}
