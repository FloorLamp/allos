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
    // Android share target (issue #1423): registers Allos in the phone's native
    // share sheet for PDFs and images, so a lab PDF or a photographed document
    // goes straight into the medical-document pipeline instead of "save the file,
    // open the app, navigate to Data → Import, find it again". The OS POSTs a
    // multipart body to /share-target, whose handler (app/share-target/route.ts)
    // checks the session and hands the file to the SAME ingestMedicalUpload engine
    // the upload form uses. The field name matches that form's input (`file`), so
    // both entry points read `formData.getAll("file")`.
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        files: [
          { name: "file", accept: ["application/pdf", ".pdf", "image/*"] },
        ],
      },
    },
  };
}
