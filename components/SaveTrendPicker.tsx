import { toggleSavedItem } from "@/app/(app)/saved-actions";
import SaveTrendKeyPicker from "./SaveTrendKeyPicker";
import type { SeriesPickerInput } from "@/lib/series-picker-options";
import Disclosure from "@/components/Disclosure";

// Add a metric pin from the final cell of the Body census (#3387). Clinical-result
// saves keep their Results/passport meanings but no longer render a second copy on
// Trends, so offering one here would promise a tile that never appears.
//
// It offers only what is NOT already saved (submitting always ADDS), and only what
// the profile may see: the metric options come from listCompareOptions, which applies
// the same metric membership rules as the tile builder.
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
}: {
  metrics: SeriesPickerInput[];
}) {
  const rows = metrics;
  if (rows.length === 0) return null;
  return (
    <Disclosure
      className="w-full max-w-full sm:w-fit"
      data-testid="save-trend-picker-disclosure"
      summaryClassName="w-fit text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
      summaryTestId="save-trend-picker-toggle"
      summary={
        <>
          <span className="group-open:hidden">＋ Add tile</span>
          <span className="hidden group-open:inline sm:group-open:hidden">
            Close
          </span>
          <span className="hidden sm:group-open:inline">Close add tile</span>
        </>
      }
    >
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
    </Disclosure>
  );
}
