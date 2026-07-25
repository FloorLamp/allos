import { toggleSavedItem } from "@/app/(app)/saved/actions";

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
// A no-JS server-action form, writing through the same action as the ★ anywhere else.
// Renders nothing when there is nothing left to add.
export default function SaveTrendPicker({
  metrics,
  biomarkers,
}: {
  metrics: { key: string; label: string }[];
  biomarkers: { key: string; label: string }[];
}) {
  const first = metrics[0]?.key ?? biomarkers[0]?.key;
  if (!first) return null;
  return (
    <form
      action={async (fd) => {
        "use server";
        await toggleSavedItem(fd);
      }}
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid="save-trend-picker"
    >
      <label
        htmlFor="star-trend"
        className="text-slate-500 dark:text-slate-400"
      >
        Add to your overview:
      </label>
      <select
        id="star-trend"
        name="key"
        defaultValue={first}
        className="input h-9 max-w-[16rem] py-1"
      >
        {metrics.length > 0 && (
          <optgroup label="Metrics">
            {metrics.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </optgroup>
        )}
        {biomarkers.length > 0 && (
          <optgroup label="Biomarkers">
            {biomarkers.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button
        type="submit"
        className="btn-ghost inline-flex items-center gap-1 py-1.5"
      >
        <span aria-hidden>☆</span>
        Star
      </button>
    </form>
  );
}
