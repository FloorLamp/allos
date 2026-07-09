import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/Toast";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import { getAppVersion } from "@/lib/version";

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

// Runs before first paint to set the theme class, avoiding a light-mode flash.
// Must stay in sync with components/ThemeToggle.tsx.
const themeBoot = `
(function () {
  try {
    var t = localStorage.getItem('theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
`;

// Bare html/body shell shared by both the login page (app/(auth)) and the
// authenticated app (app/(app)). Per-user chrome (nav, calendar, providers that
// read the DB) lives in app/(app)/layout.tsx behind requireSession(), so the
// login page renders without any authenticated data. ToastProvider stays here so
// both trees can raise toasts.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Stamp the service worker's cache name from the running commit, so a deploy
  // (new COMMIT_SHA) mints a fresh cache and the SW's activate step drops the
  // old ones. Passed to the registrar as a query param on /sw.js.
  const { sha } = getAppVersion();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <ServiceWorkerRegister version={sha ?? "dev"} />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
