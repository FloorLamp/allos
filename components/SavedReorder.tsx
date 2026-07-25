import { IconChevronUp, IconChevronDown } from "@tabler/icons-react";
import { moveSaved } from "@/app/(app)/saved/actions";

// Reorder one saved tile within the Trends Overview's saved row (issue #1456). This
// is what replaced the pin toggle: pinning USED to mean both "show this first" and
// (for a biomarker) "give it a tile at all". The star now carries membership, so all
// that is left is ordering — two no-JS server-action buttons that move the tile one
// slot earlier/later in the profile's saved list.
//
// Ordering is presentation only: it never changes WHAT is saved, so an end-of-list
// move is simply disabled (and a direct POST at the boundary is a no-op server-side).
export default function SavedReorder({
  itemKey,
  isFirst,
  isLast,
  label,
}: {
  itemKey: string;
  isFirst: boolean;
  isLast: boolean;
  label: string;
}) {
  const btn =
    "inline-flex items-center rounded-md border border-black/10 bg-white p-1 text-slate-500 transition hover:bg-slate-50 disabled:opacity-30 disabled:hover:bg-white dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-ink-800 dark:disabled:hover:bg-ink-900";
  return (
    <form
      action={async (fd) => {
        "use server";
        await moveSaved(fd);
      }}
      className="inline-flex items-center gap-1"
    >
      <input type="hidden" name="key" value={itemKey} />
      <button
        type="submit"
        name="dir"
        value="up"
        disabled={isFirst}
        title={`Move ${label} earlier`}
        aria-label={`Move ${label} earlier`}
        data-testid="saved-move-up"
        className={btn}
      >
        <IconChevronUp className="h-3.5 w-3.5" stroke={2} />
      </button>
      <button
        type="submit"
        name="dir"
        value="down"
        disabled={isLast}
        title={`Move ${label} later`}
        aria-label={`Move ${label} later`}
        data-testid="saved-move-down"
        className={btn}
      >
        <IconChevronDown className="h-3.5 w-3.5" stroke={2} />
      </button>
    </form>
  );
}
