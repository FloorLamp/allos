import LineChartCard from "@/components/LineChartCard";
import { bioAgeDelta, type BioAgeDirection } from "@/lib/bio-age";
import WidgetHeader from "./WidgetHeader";

// Dashboard biological-age widget (issue #209): the headline number — estimated
// biological age, its delta to calendar age, and a sparkline of the series — deep-
// linking to the full hero card on the Biomarkers page. Off by default in the
// registry (a specialized medical signal); a thin formatter over the same lib/bio-age
// math the hero uses. Rendered only for adults with ≥1 complete draw; the dashboard
// page routes the empty/child cases to the data-aware CTA instead.
export interface BioAgeWidgetPoint {
  date: string;
  bioAge: number;
  chronoAge: number;
}

const DELTA_CLASS: Record<BioAgeDirection, string> = {
  younger: "text-emerald-600 dark:text-emerald-400",
  older: "text-amber-600 dark:text-amber-400",
  even: "text-slate-600 dark:text-slate-300",
};

export default function BioAgeWidget({
  draws,
}: {
  draws: BioAgeWidgetPoint[];
}) {
  const latest = draws[draws.length - 1];
  const delta = bioAgeDelta(latest.bioAge, latest.chronoAge);
  const sign =
    delta.direction === "even" ? "" : delta.direction === "younger" ? "−" : "+";

  return (
    <div className="card">
      <WidgetHeader
        title="Biological age"
        href="/biomarkers"
        linkLabel="View card"
      />
      <div className="flex items-baseline gap-2">
        <span
          className="text-3xl font-bold tabular-nums text-slate-900 dark:text-white"
          data-testid="bio-age-widget-value"
        >
          {delta.bioAge}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          years
        </span>
      </div>
      <p
        className={`mt-0.5 text-sm font-medium ${DELTA_CLASS[delta.direction]}`}
      >
        {delta.direction === "even"
          ? "about your calendar age"
          : `${sign}${delta.magnitudeYears} yr vs calendar age ${delta.chronoAge}`}
      </p>
      <div className="mt-2">
        <LineChartCard
          data={draws.map((d) => ({ date: d.date, value: d.bioAge }))}
          label="Bio age"
          unit=" yr"
          heightClass="h-24"
        />
      </div>
      <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
        Estimate · Levine PhenoAge (2018)
      </p>
    </div>
  );
}
