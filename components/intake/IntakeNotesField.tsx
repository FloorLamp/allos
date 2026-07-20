"use client";

// The free-text notes field shared by both intake forms (#846). `fid` keeps the
// label/textarea ids unique across multiple forms on one page.
export default function IntakeNotesField({
  fid,
  defaultValue,
}: {
  fid: string | number;
  defaultValue?: string | null;
}) {
  return (
    <div className="border-t border-black/5 pt-4 sm:col-span-2 dark:border-white/5">
      <label className="label" htmlFor={`intake-notes-${fid}`}>
        Notes
      </label>
      <textarea
        id={`intake-notes-${fid}`}
        name="notes"
        defaultValue={defaultValue ?? ""}
        className="input"
        rows={3}
      />
    </div>
  );
}
