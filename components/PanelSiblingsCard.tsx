import Link from "next/link";
import { panelLabel, type PanelId } from "@/lib/biomarker-panels";
import { panelFilterHref, readingDetailHref } from "@/lib/hrefs";

// "Part of your <panel> panel. Also measured: …" (#1502), shared by both reading
// detail surfaces since #1932 — a panel's members can now render on two different
// pages by cadence (an SpO2 charts as a trend, a lipid reads against its band), and
// this strip is the cross-reference that has to keep working across that split.
// Each chip goes through `readingDetailHref`, so a sibling lands on ITS own surface
// rather than on whichever page happened to draw the card.
export function PanelSiblingsCard({
  panelId,
  names,
}: {
  panelId: PanelId;
  names: string[];
}) {
  if (names.length === 0) return null;
  return (
    <div
      data-testid="panel-siblings"
      className="card mb-6 border-l-4 border-l-violet-300 text-sm dark:border-l-violet-700"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <span className="text-slate-700 dark:text-slate-200">
          <span className="font-semibold">
            Part of your {panelLabel(panelId)} panel.
          </span>{" "}
          Also measured:
        </span>
        <Link
          href={panelFilterHref(panelId)}
          className="shrink-0 font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          See the whole panel →
        </Link>
      </div>
      <ul className="flex flex-wrap gap-2">
        {names.map((name) => (
          <li key={name}>
            <Link
              href={readingDetailHref(name)}
              className="badge bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-200 dark:hover:bg-ink-700"
            >
              {name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
