// Placeholder shown while a chart's recharts bundle is fetched. The chart
// components are code-split via next/dynamic (ssr:false) so recharts stays out of
// the initial JS of the analytics routes; this fills the chart's box until the
// client chunk loads. Kept dependency-free so it can render in any context.
export default function ChartLoading({
  heightClass = "h-64",
}: {
  heightClass?: string;
}) {
  return (
    <div
      className={`flex ${heightClass} w-full items-center justify-center text-sm text-slate-500 dark:text-slate-400`}
      aria-hidden
    >
      <span className="animate-pulse">Loading chart…</span>
    </div>
  );
}
