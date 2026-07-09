import { IconPin } from "@tabler/icons-react";
import { toggleTrendPin } from "@/app/(app)/trends/actions";

// Pin any biomarker to the Trends Overview. A no-JS server-action form: pick a
// biomarker (only currently-unpinned ones are offered, so submitting always ADDS
// a pin) and submit. Renders nothing when there's nothing left to pin.
export default function PinBiomarkerPicker({
  options,
}: {
  options: { key: string; label: string }[];
}) {
  if (options.length === 0) return null;
  return (
    <form
      action={toggleTrendPin}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <label htmlFor="pin-bio" className="text-slate-500 dark:text-slate-400">
        Pin a biomarker:
      </label>
      <select
        id="pin-bio"
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
        <IconPin className="h-4 w-4" stroke={2} />
        Pin
      </button>
    </form>
  );
}
