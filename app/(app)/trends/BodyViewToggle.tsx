import { IconLayoutGrid, IconChartLine } from "@tabler/icons-react";
import SegmentedControl from "@/components/SegmentedControl";
import type { AppRoute } from "@/lib/hrefs";
import type { BodyView } from "./body-view";

// The Trends → Overview → body census overview toggle (#1067 Phase 2): sparkline TILES vs the classic
// full-chart STACK. #2152 makes the phone answer unconditional: tiles only, even
// for `?view=all` and 1D. This desktop-only control chooses the presentation above
// the breakpoint. A GET-link segmented control keeps the choice in the URL.
//
// The shared SegmentedControl in its LINK binding since #2535 — it had its own
// private `Segment` sub-component and its own rounded-full track, and marked the
// selection with `aria-pressed` on a <Link>, which is not a state a link supports.
// `aria-current="true"`, not `"page"`: both segments render the SAME page (Trends
// Overview) in two presentations, so claiming the selected one is the current page
// would overclaim — unlike Timeline's or the care trail's, whose segments really are
// different views of the surface.

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
    <SegmentedControl<"tiles" | "all">
      ariaLabel="Body overview layout"
      ariaCurrent="true"
      testId="body-view-toggle"
      // The control only renders on desktop, where the URL-less responsive default
      // IS the full chart stack. Reflect the effective layout instead of leaving
      // both segments unselected until `?view=all` is explicit.
      value={view === "tiles" ? "tiles" : "all"}
      options={[
        {
          value: "tiles",
          label: "Tiles",
          href: tilesHref,
          testId: "body-view-tiles",
          icon: (
            <IconLayoutGrid className="h-4 w-4" stroke={1.75} aria-hidden />
          ),
        },
        {
          value: "all",
          label: "All charts",
          href: allHref,
          testId: "body-view-all",
          icon: <IconChartLine className="h-4 w-4" stroke={1.75} aria-hidden />,
        },
      ]}
    />
  );
}
