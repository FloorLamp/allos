import Link from "next/link";
import { IconLayoutGrid, IconChartLine } from "@tabler/icons-react";
import type { AppRoute } from "@/lib/hrefs";
import type { BodyView } from "./body-view";

// The Trends → Overview → body census overview toggle (#1067 Phase 2): sparkline TILES vs the classic
// full-chart STACK. #2152 makes the phone answer unconditional: tiles only, even
// for `?view=all` and 1D. This desktop-only control chooses the presentation above
// the breakpoint. A GET-link segmented control keeps the choice in the URL.

export default function BodyViewToggle({
  view,
  tilesHref,
  allHref,
}: {
  view: BodyView;
  tilesHref: AppRoute;
  allHref: AppRoute;
}) {
  return (
    <nav
      aria-label="Body overview layout"
      data-testid="body-view-toggle"
      className="inline-flex gap-1 rounded-full border border-black/10 p-1 text-sm dark:border-white/10"
    >
      <Segment
        href={tilesHref}
        active={view === "tiles"}
        testid="body-view-tiles"
      >
        <IconLayoutGrid className="h-4 w-4" stroke={1.75} aria-hidden />
        Tiles
      </Segment>
      <Segment
        href={allHref}
        // The control only renders on desktop, where the URL-less responsive
        // default IS the full chart stack. Reflect the effective layout instead
        // of leaving both segments unselected until `?view=all` is explicit.
        active={view !== "tiles"}
        testid="body-view-all"
      >
        <IconChartLine className="h-4 w-4" stroke={1.75} aria-hidden />
        All charts
      </Segment>
    </nav>
  );
}

function Segment({
  href,
  active,
  testid,
  children,
}: {
  href: AppRoute;
  active: boolean;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      data-testid={testid}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 font-medium transition ${
        active
          ? "bg-brand-600 text-white"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-ink-750"
      }`}
    >
      {children}
    </Link>
  );
}
