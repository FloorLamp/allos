import { IconChevronRight } from "@tabler/icons-react";
import type { DistanceUnit } from "@/lib/settings";
import type { ActivityEditData } from "@/lib/activity-form-model";
import NotesField from "./NotesField";
import EstimatedCalories from "./EstimatedCalories";
import ImportedActivityDetails from "./ImportedActivityDetails";
import RouteMap from "@/components/RouteMap";

// The activity form's collapsible "More details" disclosure (#1207 extraction):
// notes, the manual calorie estimate, imported-metric read-outs, and the route map.
// Pure presentation over the parent's state — every value/handler is a prop, so the
// parent stays the single owner of form state.
export default function ActivityMoreDetails({
  open,
  onToggle,
  summary,
  notes,
  onNotesChange,
  showEstimate,
  displayedEstCalories,
  estEdited,
  autoEstimateKcal,
  onEstChange,
  onEstReset,
  editData,
  distanceUnit,
}: {
  open: boolean;
  onToggle: () => void;
  // The pre-joined disclosure summary line (distance/energy chips), or empty.
  summary: string[];
  notes: string;
  onNotesChange: (v: string) => void;
  showEstimate: boolean;
  displayedEstCalories: string;
  estEdited: boolean;
  autoEstimateKcal: number | null;
  onEstChange: (v: string) => void;
  onEstReset: () => void;
  editData: ActivityEditData | null;
  distanceUnit: DistanceUnit;
}) {
  return (
    <section data-testid="activity-more-details">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group flex w-full items-center justify-between gap-3 rounded-lg py-1.5 text-left text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <span className="min-w-0">
          <span className="label mb-0">More details</span>
          <span
            data-testid="more-details-summary"
            className="block truncate text-xs text-slate-500 dark:text-slate-400"
          >
            {summary.length > 0
              ? summary.join(" · ")
              : "Notes and optional supporting data"}
          </span>
        </span>
        <IconChevronRight
          data-testid="more-details-chevron"
          className={`h-4 w-4 shrink-0 text-slate-400 transition-[color,filter,transform] group-hover:text-brand-500 group-hover:[filter:drop-shadow(0_0_3px_currentColor)] ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="mt-3 space-y-5">
          <NotesField notes={notes} onNotesChange={onNotesChange} />

          {/* Estimated calories are manual-only. Imported active energy is
              read-only inside ImportedActivityDetails below. */}
          {showEstimate && (
            <EstimatedCalories
              value={displayedEstCalories}
              edited={estEdited}
              autoEstimateKcal={autoEstimateKcal}
              onChange={onEstChange}
              onReset={onEstReset}
            />
          )}

          <ImportedActivityDetails
            activity={editData}
            distanceUnit={distanceUnit}
          />

          {editData?.route_polyline && (
            <section
              data-testid="activity-form-route"
              aria-labelledby="activity-form-route-title"
            >
              <h3 id="activity-form-route-title" className="label mb-2">
                Route
              </h3>
              <RouteMap
                polyline={editData.route_polyline}
                width={480}
                height={96}
                className="h-auto w-full rounded-lg border border-black/10 bg-slate-50 text-brand-600 dark:border-white/10 dark:bg-ink-900 dark:text-brand-400"
              />
            </section>
          )}
        </div>
      )}
    </section>
  );
}
