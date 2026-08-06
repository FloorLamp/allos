import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { ToastProvider } from "@/components/Toast";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import DemoBanner from "@/components/DemoBanner";
import { getAppVersion } from "@/lib/version";
import { isDemoMode } from "@/lib/demo";
import ThemeReassert from "@/components/ThemeReassert";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Allos",
  description: "Health tracking and coaching for stability through change",
  applicationName: "Allos",
  // iOS home-screen (add-to-home-screen) metadata. `capable` makes an installed
  // launch run standalone (no Safari chrome); the "default" status bar stays
  // opaque and inset, so it never overlaps content the way "black-translucent"
  // would in light mode. The web manifest link is auto-injected by app/manifest.ts.
  appleWebApp: {
    capable: true,
    title: "Allos",
    statusBarStyle: "default",
  },
  // Stop iOS from auto-linkifying numbers (weights, reps) as phone numbers.
  formatDetection: { telephone: false },
};

// viewportFit "cover" lets the app paint edge-to-edge on notched phones; the
// chrome that touches screen edges (mobile top bar, drawer) pads itself back
// out with safe-area insets. themeColor tints the browser UI to match the
// page background in each scheme.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e4ece6" },
    { media: "(prefers-color-scheme: dark)", color: "#090c0b" },
  ],
};

// Bare html/body shell shared by both the login page (app/(auth)) and the
// authenticated app (app/(app)). Per-user chrome (nav, calendar, providers that
// read the DB) lives in app/(app)/layout.tsx behind requireSession(), so the
// login page renders without any authenticated data. ToastProvider stays here so
// both trees can raise toasts.
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Stamp the service worker's cache name from the running commit, so a deploy
  // (new COMMIT_SHA) mints a fresh cache and the SW's activate step drops the
  // old ones. Passed to the registrar as a query param on /sw.js — and, since
  // #1795, as the baseline the ONE update notice compares the server's commit
  // against when this context has no worker to watch.
  const { sha } = getAppVersion();

  // Per-request CSP nonce (issue #595, step 3) set by middleware.ts on the
  // x-nonce request header. The theme-boot inline <script> carries it so it
  // passes the nonce-based script-src (production) that no longer allows
  // 'unsafe-inline'. Reading headers() opts the app into dynamic rendering — an
  // accepted trade-off (the app is mostly dynamic already). In dev the header may
  // be absent/ignored (script-src keeps 'unsafe-inline' for HMR); undefined then
  // renders no nonce attribute, which is fine.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint to set the theme class, avoiding a
            light-mode flash. The source lives in lib/theme.ts beside the rule
            it transcribes; a pure test executes it against isDarkTheme so the
            two cannot drift (#2183). */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body>
        {/* The boot script's safety net (#2183): re-asserts the theme class
            post-hydration and on route changes, so one hard navigation whose
            boot script never ran cannot poison the whole SPA session. */}
        <ThemeReassert />
        <ServiceWorkerRegister sha={sha} />
        {isDemoMode() && <DemoBanner />}
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
