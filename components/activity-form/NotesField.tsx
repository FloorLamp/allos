"use client";

import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";

// The activity form's collapsible notes field. Presentational only — extracted
// from ActivityForm so the parent stays composition (#319).
export default function NotesField({
  notesOpen,
  notes,
  onToggle,
  onNotesChange,
}: {
  notesOpen: boolean;
  notes: string;
  onToggle: () => void;
  onNotesChange: (v: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="label mb-0 flex items-center gap-1.5 hover:text-slate-700 dark:hover:text-slate-200"
      >
        Notes
        <span className="text-slate-400 dark:text-slate-500">
          {notesOpen ? (
            <IconChevronDown className="h-4 w-4" />
          ) : (
            <IconChevronRight className="h-4 w-4" />
          )}
        </span>
        {!notesOpen && notes.trim() && (
          <span className="normal-case text-slate-400 dark:text-slate-500">
            ({notes.trim().length} chars)
          </span>
        )}
      </button>
      {notesOpen && (
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          rows={2}
          className="input mt-1"
          placeholder="How did it feel?"
        />
      )}
    </div>
  );
}
