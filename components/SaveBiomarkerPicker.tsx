import { toggleSavedItem } from "@/app/(app)/saved/actions";

// Star any biomarker straight from Trends Overview (issue #1456) — the add-entry
// point that used to be "Pin a biomarker". It now writes a SAVE through the same
// action as the ★ button anywhere else, so a biomarker added here also gains the
// Results status card and passport inclusion, not just a chart tile.
//
// A no-JS server-action form: only currently-unstarred biomarkers are offered, so
// submitting always ADDS. Renders nothing when everything in use is already starred.
export default function SaveBiomarkerPicker({
  options,
}: {
  options: { key: string; label: string }[];
}) {
  if (options.length === 0) return null;
  return (
    <form
      action={async (fd) => {
        "use server";
        await toggleSavedItem(fd);
      }}
      className="flex flex-wrap items-center gap-2 text-sm"
      data-testid="save-biomarker-picker"
    >
      <label htmlFor="star-bio" className="text-slate-500 dark:text-slate-400">
        Star a biomarker:
      </label>
      <select
        id="star-bio"
        name="key"
        defaultValue={options[0].key}
        className="input h-9 max-w-[16rem] py-1"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
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
