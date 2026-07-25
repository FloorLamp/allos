import { toggleSavedItem } from "@/app/(app)/saved/actions";

// THE save toggle (issue #1456) — one gesture, one intent, every savable kind. It
// submits a Trends SERIES KEY ("bio:LDL Cholesterol" | "metric:weight"), which the
// action resolves to a (kind, key) row in `saved_items`; each kind's MEANING lives in
// domain code, not here.
//
// The ★ icon and the "star" verb are deliberately KEPT (existing muscle memory —
// `saved_items` is the internal name only). This replaced the separate pin toggle that
// used to live on Trends Overview tiles: starring a biomarker now earns it the Results
// status card, a Trends chart tile, AND passport inclusion in ONE gesture.
//
// A server-action form — no client JS needed. `compact` is the tile-footer size; the
// default is the biomarker detail header's.
export default function StarButton({
  itemKey,
  saved,
  compact = false,
  label,
}: {
  itemKey: string;
  saved: boolean;
  compact?: boolean;
  label?: string;
}) {
  const subject = label ?? "this";
  return (
    <form
      action={async (fd) => {
        "use server";
        await toggleSavedItem(fd);
      }}
    >
      <input type="hidden" name="key" value={itemKey} />
      <button
        type="submit"
        aria-pressed={saved}
        data-testid="star-toggle"
        title={saved ? `Unstar ${subject}` : `Star ${subject}`}
        className={`inline-flex items-center rounded-lg border font-medium transition ${
          compact ? "gap-1 px-2 py-1 text-xs" : "gap-1.5 px-3 py-1.5 text-sm"
        } ${
          saved
            ? "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
            : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
        }`}
      >
        <span>{saved ? "★" : "☆"}</span>
        {saved ? "Starred" : "Star"}
      </button>
    </form>
  );
}
