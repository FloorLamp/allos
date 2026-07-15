import type {
  Betterness,
  OutcomeComparison,
  ProtocolComparison,
} from "@/lib/protocol-compare";

// Round a window mean for display: 2 dp for small magnitudes, 1 dp otherwise.
function fmtStat(n: number | null): string {
  if (n == null) return "—";
  return Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(1);
}

const TONE: Record<Betterness, string> = {
  better: "text-emerald-600 dark:text-emerald-400",
  worse: "text-rose-600 dark:text-rose-400",
  unchanged: "text-slate-500 dark:text-slate-400",
  unknown: "text-slate-500 dark:text-slate-400",
};

function OutcomePanel({ o }: { o: OutcomeComparison }) {
  const unit = o.unit ? ` ${o.unit}` : "";
  return (
    <div
      className="card"
      data-testid={`protocol-outcome-${o.key}`}
      data-insufficient={o.insufficient ? "1" : "0"}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          {o.label}
        </h3>
        {!o.insufficient && (
          <span className={`text-sm font-medium ${TONE[o.betterness]}`}>
            {o.betterness === "better"
              ? "Improved"
              : o.betterness === "worse"
                ? "Worsened"
                : "No change"}
          </span>
        )}
      </div>
      {o.insufficient ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {o.framing}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-ink-800">
              <div className="label">Before</div>
              <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                {fmtStat(o.baseline.mean)}
                <span className="ml-1 text-xs font-normal text-slate-400">
                  {unit.trim()}
                </span>
              </div>
              <div className="text-xs text-slate-400">
                n={o.baseline.n} · median {fmtStat(o.baseline.median)}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-ink-800">
              <div className="label">During</div>
              <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                {fmtStat(o.intervention.mean)}
                <span className="ml-1 text-xs font-normal text-slate-400">
                  {unit.trim()}
                </span>
              </div>
              <div className="text-xs text-slate-400">
                n={o.intervention.n} · median {fmtStat(o.intervention.median)}
              </div>
            </div>
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {o.framing}
          </p>
        </>
      )}
    </div>
  );
}

// The before/during panels for a protocol's comparison. Renders one panel per
// declared outcome; a metric with no readings in a window shows its
// "insufficient data" note rather than a fabricated number.
export default function ProtocolCompare({
  comparison,
}: {
  comparison: ProtocolComparison;
}) {
  if (comparison.outcomes.length === 0) {
    return (
      <div className="card text-sm text-slate-500 dark:text-slate-400">
        No outcome metrics declared. Edit this protocol to choose the biomarkers
        or metrics to compare.
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="protocol-compare">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Baseline window {comparison.baselineWindow.start} –{" "}
        {comparison.baselineWindow.end} vs. intervention{" "}
        {comparison.interventionWindow.start} –{" "}
        {comparison.interventionWindow.end}.
      </p>
      {comparison.outcomes.map((o) => (
        <OutcomePanel key={o.key} o={o} />
      ))}
    </div>
  );
}
