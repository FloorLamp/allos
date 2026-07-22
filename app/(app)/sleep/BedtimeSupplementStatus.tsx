import {
  bedtimeSupplementStatusLabel,
  type BedtimeSupplementState,
  type BedtimeSupplementSummary,
} from "@/lib/sleep-bedtime-supplements";

const TONE: Record<BedtimeSupplementState, string> = {
  taken: "text-emerald-700 dark:text-emerald-300",
  partial: "text-slate-600 dark:text-slate-300",
  skipped: "text-slate-500 dark:text-slate-400",
  missed: "text-slate-600 dark:text-slate-300",
};

export default function BedtimeSupplementStatus({
  summary,
  prefix,
  compact = false,
  detailsMode = "expand",
  labelMode = "status",
}: {
  summary: BedtimeSupplementSummary;
  prefix?: string;
  compact?: boolean;
  detailsMode?: "expand" | "taken-inline";
  labelMode?: "status" | "fraction";
}) {
  const label =
    labelMode === "fraction"
      ? `${summary.taken}/${summary.due} taken`
      : bedtimeSupplementStatusLabel(summary);
  const itemLabels = summary.items.map(
    (item) => `${item.name}: ${bedtimeSupplementStatusLabel(item)}`
  );
  const details = itemLabels.join("; ");
  const takenNames = summary.items
    .filter((item) => item.taken > 0)
    .map((item) => item.name);
  const summaryText = prefix ? `${prefix} · ${label}` : label;

  if (detailsMode === "taken-inline") {
    return (
      <span
        className={`inline-flex items-center gap-1 font-medium ${compact ? "text-[11px]" : "text-xs"} ${TONE[summary.state]}`}
        data-testid="bedtime-supplement-status"
        data-state={summary.state}
        aria-label={`${summaryText}${takenNames.length > 0 ? `. Taken: ${takenNames.join(", ")}` : ""}`}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          aria-hidden
        />
        <span>
          {summaryText}
          {takenNames.length > 0 ? ` (${takenNames.join(", ")})` : ""}
        </span>
      </span>
    );
  }

  return (
    <details
      className={`group ${compact ? "text-[11px]" : "text-xs"}`}
      data-testid="bedtime-supplement-status"
      data-state={summary.state}
    >
      <summary
        className={`inline-flex cursor-pointer list-none items-center gap-1 font-medium ${TONE[summary.state]}`}
        title={details}
        aria-label={`${prefix ? `${prefix}: ` : ""}${label}. ${details}`}
        data-testid="bedtime-supplement-status-summary"
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          aria-hidden
        />
        {prefix ? `${prefix} · ${label}` : label}
      </summary>
      <span className="mt-1 block max-w-72 whitespace-normal font-normal leading-relaxed text-slate-500 dark:text-slate-400">
        {itemLabels.map((item) => (
          <span key={item} className="block">
            {item}
          </span>
        ))}
      </span>
    </details>
  );
}
