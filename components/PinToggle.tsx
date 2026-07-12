import { IconPin } from "@tabler/icons-react";
import { toggleTrendPin } from "@/app/(app)/trends/actions";

// Pin / unpin a Trends-Overview tile. Submits the toggleTrendPin server action
// (which flips the key in the profile's `trend_pins` list and revalidates
// /trends). A plain server-action form — no client JS needed; pinned tiles then
// render first on the Overview.
export default function PinToggle({
  pinKey,
  pinned,
}: {
  pinKey: string;
  pinned: boolean;
}) {
  return (
    <form
      action={async (fd) => {
        "use server";
        await toggleTrendPin(fd);
      }}
    >
      <input type="hidden" name="key" value={pinKey} />
      <button
        type="submit"
        aria-pressed={pinned}
        title={pinned ? "Unpin from Trends" : "Pin to top of Trends"}
        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
          pinned
            ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
            : "border-black/10 bg-white text-slate-500 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-ink-800"
        }`}
      >
        <IconPin className="h-3.5 w-3.5" stroke={2} />
        {pinned ? "Pinned" : "Pin"}
      </button>
    </form>
  );
}
