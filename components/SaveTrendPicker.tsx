import { toggleSavedItem } from "@/app/(app)/saved-actions";
import SaveTrendKeyPicker from "./SaveTrendKeyPicker";
import type { SeriesPickerInput } from "@/lib/series-picker-options";

// Add a tile to Trends Overview (issue #1487) — the picker that used to be "Pin a
// biomarker", then "Star a biomarker", and is now the grid's ONE add-entry point.
//
// It offers METRICS as well as biomarkers, and that is load-bearing rather than
// cosmetic. Overview is membership-driven now: the four standard metric tiles are
// ordinary saved rows, so unstarring training volume genuinely removes its tile.
// A remove gesture with no matching add gesture would STRAND the tile — the user
// would have no way back short of a database edit. Metrics and biomarkers therefore
// share the picker, because they now share the same membership semantics.
//
// It offers only what is NOT already saved (submitting always ADDS), and only what
// the profile may see: the metric options come from listCompareOptions, which applies
// the same age gates as the tile builder — so a training-restricted profile is never
// offered training volume, and a saved-but-gated metric simply has no tile and no
// option, exactly as before.
//
// A server-action form, writing through the same action as the ★ anywhere else.
// Renders nothing when there is nothing left to add.
//
// #1675 moved the CONTROL into SaveTrendKeyPicker — the shared Combobox over the
// relevance-ranked option list, with the old grouped `<select>` kept as the
// pre-hydration / no-JS rendering. The form, the action, and the posted `key` field
// are untouched: starring is still one POST of one series key.
export default function SaveTrendPicker({
  metrics,
  biomarkers,
  mobileSectionLabel = false,
}: {
  metrics: SeriesPickerInput[];
  biomarkers: SeriesPickerInput[];
  // In the phone's empty starred state, the disclosure IS the whole section row:
  // keep its label and Add/Close action together instead of positioning a form
  // beside a separate label and letting the open control overflow the viewport.
  mobileSectionLabel?: boolean;
}) {
  const rows = [...metrics, ...biomarkers];
  if (rows.length === 0) return null;
  return (
    <details
      className="group w-full max-w-full sm:w-fit"
      data-testid="save-trend-picker-disclosure"
    >
      <summary
        className={`w-fit cursor-pointer list-none text-xs font-medium text-brand-700 hover:underline dark:text-brand-300 [&::-webkit-details-marker]:hidden ${
          mobileSectionLabel ? "py-2 sm:py-0" : ""
        }`}
        data-testid="save-trend-picker-toggle"
      >
        {mobileSectionLabel ? (
          <>
            <span className="inline-flex items-baseline gap-1 sm:hidden">
              <span className="section-label">★ Starred</span>
              <span className="group-open:hidden">· Add tile</span>
              <span className="hidden group-open:inline">· Close</span>
            </span>
            <span className="hidden sm:group-open:hidden sm:inline">
              ＋ Add tile
            </span>
            <span className="hidden sm:group-open:inline">Close add tile</span>
          </>
        ) : (
          <>
            <span className="group-open:hidden">＋ Add tile</span>
            <span className="hidden group-open:inline sm:group-open:hidden">
              Close
            </span>
            <span className="hidden sm:group-open:inline">Close add tile</span>
          </>
        )}
      </summary>
      <form
        action={async (fd) => {
          "use server";
          await toggleSavedItem(fd);
        }}
        className="mt-3 grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-sm sm:mt-2 sm:flex sm:w-auto sm:flex-wrap"
        data-testid="save-trend-picker"
      >
        <SaveTrendKeyPicker rows={rows} />
      </form>
    </details>
  );
}
