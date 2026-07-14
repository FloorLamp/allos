"use client";

// Notes live inside the form's shared "More details" disclosure, so this field
// stays plain rather than creating a second nested disclosure.
export default function NotesField({
  notes,
  onNotesChange,
}: {
  notes: string;
  onNotesChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label" htmlFor="activity-notes">
        Notes
      </label>
      <textarea
        id="activity-notes"
        value={notes}
        onChange={(e) => onNotesChange(e.target.value)}
        rows={2}
        className="input bg-white dark:bg-ink-900"
        placeholder="How did it feel?"
      />
    </div>
  );
}
