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
}: {
  metrics: SeriesPickerInput[];
  biomarkers: SeriesPickerInput[];
}) {
  const rows = [...metrics, ...biomarkers];
  if (rows.length === 0) return null;
  return (
    <form
      action={async (fd) => {
        "use server";
        await toggleSavedItem(fd);
      }}
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid="save-trend-picker"
    >
      <SaveTrendKeyPicker rows={rows} />
    </form>
  );
}
