import { DEMO_BANNER_TEXT } from "@/lib/demo";

// Persistent, non-dismissible demo banner (#181). Rendered from the ROOT layout
// (app/layout.tsx) so it sits above every tree — the login page, the authenticated
// app, and public share links — on every viewport, from one place (no responsive
// fork). The PHI warning is the load-bearing part: the one real risk of a public
// health-app demo is someone pasting real labs in. There is deliberately no
// dismiss control.
export default function DemoBanner() {
  return (
    <div
      data-testid="demo-banner"
      role="status"
      className="w-full bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950"
    >
      {DEMO_BANNER_TEXT}
    </div>
  );
}
