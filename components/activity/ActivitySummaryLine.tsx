import type { ZoneId } from "@/lib/training-zones";
import { zonePresentation } from "@/lib/training-zones";
import { relativeEffortPresentation } from "@/lib/activity-import-details";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

const INTENSITY_DOT: Record<string, string> = {
  easy: "bg-emerald-500 dark:bg-emerald-400",
  moderate: "bg-amber-500 dark:bg-amber-400",
  hard: "bg-rose-500 dark:bg-rose-400",
};

interface SummaryItem {
  label: string;
  value: string;
  intensity?: string | null;
  heartRate?: boolean;
  color?: string;
  title?: string;
  tooltip?: string;
}

function summaryTestId(item: SummaryItem): string | undefined {
  if (item.intensity) return "activity-intensity";
  if (item.heartRate) return "activity-heart-rate";
  return undefined;
}

function SummaryValue({
  item,
  detail = false,
}: {
  item: SummaryItem;
  detail?: boolean;
}) {
  return (
    <span
      className={
        detail
          ? "inline-flex min-w-0 items-center text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100"
          : "inline-flex items-center"
      }
    >
      {item.intensity && INTENSITY_DOT[item.intensity] && (
        <span
          aria-hidden
          data-testid="activity-intensity-dot"
          className={`mr-1 h-1.5 w-1.5 rounded-full ${INTENSITY_DOT[item.intensity]}`}
        />
      )}
      {item.heartRate ? (
        <>
          <span
            aria-hidden
            data-testid="activity-heart-rate-icon"
            style={item.color ? { color: item.color } : undefined}
          >
            ♥
          </span>
          <span className="ml-1">{item.value.replace(/^♥\s*/, "")}</span>
        </>
      ) : (
        item.value
      )}
      {item.tooltip ? (
        <InfoTooltipIcon label={item.tooltip} className="ml-1" />
      ) : null}
    </span>
  );
}

// One presentation for an activity's primary facts. Feed cards, the compact
// weekly overview, and the canonical activity page all pass the same formatted
// values through this component; their containers may differ in density, but
// the reading order, separators, heart-rate treatment, and intensity signal do
// not fork.
export default function ActivitySummaryLine({
  timeText,
  durationText,
  distanceText,
  speedText,
  heartRateText,
  relativeEffort,
  relativeEffortProvider,
  calorieText,
  intensity,
  heartRateZone,
  density = "compact",
  testId = "activity-summary",
}: {
  timeText: string | null;
  durationText: string | null;
  distanceText: string | null;
  speedText: string | null;
  heartRateText: string | null;
  relativeEffort?: number | null;
  relativeEffortProvider?: string | null;
  calorieText: string | null;
  intensity?: string | null;
  heartRateZone?: ZoneId | null;
  density?: "compact" | "detail";
  testId?: string;
}) {
  const intensityKey = intensity?.toLowerCase() ?? null;
  const heartRate = zonePresentation(heartRateZone);
  const relativeEffortItem =
    relativeEffort != null
      ? relativeEffortPresentation(relativeEffort, relativeEffortProvider)
      : null;
  const items: (SummaryItem | null)[] = [
    timeText ? { label: "Time", value: timeText } : null,
    durationText ? { label: "Duration", value: durationText } : null,
    heartRateText
      ? {
          label: "Heart rate",
          value: heartRateText,
          heartRate: true,
          color: heartRate?.color,
          title: heartRate?.title,
        }
      : null,
    relativeEffortItem
      ? {
          label: "Effort",
          value: relativeEffortItem.label,
          tooltip: relativeEffortItem.help,
        }
      : null,
    distanceText ? { label: "Distance", value: distanceText } : null,
    speedText ? { label: "Average speed", value: speedText } : null,
    calorieText ? { label: "Calories", value: calorieText } : null,
    intensity
      ? {
          label: "Intensity",
          value: intensity.replace(/^\w/, (character) =>
            character.toUpperCase()
          ),
          intensity: intensityKey,
        }
      : null,
  ];
  const summary = items.filter((item): item is SummaryItem => item != null);

  if (summary.length === 0) return null;

  if (density === "detail") {
    return (
      <dl
        data-testid={testId}
        data-density={density}
        className="grid grid-cols-2 gap-x-5 gap-y-4 border-y border-black/5 py-4 sm:grid-cols-4 dark:border-white/10"
      >
        {summary.map((item, index) => (
          <div
            key={index}
            data-testid={summaryTestId(item)}
            title={item.title}
            className="flex min-w-0 flex-col items-start gap-1"
          >
            <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {item.label}
            </dt>
            <dd>
              <SummaryValue item={item} detail />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <div
      data-testid={testId}
      data-density={density}
      className="mt-0.5 flex flex-wrap items-center text-xs text-slate-600 dark:text-slate-300"
    >
      {summary.map((item, index) => (
        <span
          key={index}
          data-testid={summaryTestId(item)}
          title={item.title}
          className="inline-flex items-center whitespace-nowrap"
        >
          <SummaryValue item={item} />
          {/* Keep the separator with the preceding value so a wrapped line
              never begins with a stray bullet. */}
          {index < summary.length - 1 && (
            <span
              aria-hidden
              className="mx-1.5 text-slate-500 dark:text-slate-400"
            >
              ·
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
