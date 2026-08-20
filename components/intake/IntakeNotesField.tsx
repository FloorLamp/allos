"use client";

// The free-text notes field of the intake form (#846). `fid` keeps the label/textarea
// ids unique across multiple forms on one page.
//
// CONTROLLED, not defaultValue: the merged form (#3216) shows one editor at a time, so
// a field that lived only in the DOM would be a field that saves only when its editor
// happened to be open. Every value the form posts is state.
export default function IntakeNotesField({
  fid,
  value,
  onChange,
}: {
  fid: string | number;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="border-t border-black/5 pt-4 sm:col-span-2 dark:border-white/5">
      <label className="label" htmlFor={`intake-notes-${fid}`}>
        Notes
      </label>
      <textarea
        id={`intake-notes-${fid}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        rows={3}
      />
    </div>
  );
}
