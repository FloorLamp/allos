"use client";

// THE EXERCISE'S NAME, SETTLED OR BEING SEARCHED (#5370).
//
// A part that has a name states it as a HEADING — #5376's rung 2: normal case,
// semibold, body size — rather than sitting inside a mounted search field. The picker
// is one tap behind it, and the search glyph and the field's own Clear come back WITH
// the picker, because they belong to searching. That is what leaves one X on the row,
// at its end, removing the exercise.
//
// It owns the Escape branch and nothing else; the caller owns which part is being
// searched (at most one, like the guide overlay) and what a settle does to the draft.
// Keeping the branch here is also what keeps it out of ActivityPartsList, whose Escape
// contract belongs to the shared fact-editor host (lib/__tests__/fact-editors-reuse).
export default function PartNameField({
  name,
  badge,
  searching,
  onOpen,
  onEscape,
  headingRef,
  children,
}: {
  name: string;
  badge: React.ReactNode;
  searching: boolean;
  onOpen: () => void;
  onEscape: () => void;
  headingRef: (node: HTMLButtonElement | null) => void;
  // The picker, built by the caller: it is the caller's vocabulary, ranking and
  // free-text rules, and none of that is this component's business.
  children: React.ReactNode;
}) {
  // A part with no name has nothing to state, so it is the picker whatever the caller
  // says — that is the form's first exercise on every fresh log.
  const settled = !searching && name.trim() !== "";
  return (
    <div
      className="min-w-0 sm:flex-1"
      // Escape settles, in CAPTURE so ONE press does it: the field's own handler would
      // otherwise swallow it (ActivityCombobox pins `closeStopsPropagation`).
      // Unmounting the field closes its listbox anyway, and stopping the event here
      // keeps the press from also closing the editor behind.
      onKeyDownCapture={(e) => {
        if (!searching || e.key !== "Escape") return;
        e.stopPropagation();
        onEscape();
      }}
    >
      {settled ? (
        /* It keeps the field's 34px box (#3938): the part's `--set-schema-top` is
           derived from that box and the sticky set-schema row parks against it.
           ACTIVATION IS THE TAP, NOT THE FOCUS. #5370 asks for both; focus cannot have
           it, because settling returns focus HERE, so an onFocus that reopened the
           picker would reopen what Escape had just closed. Enter, Space and a tap all
           reach `onClick`. */
        <button
          type="button"
          ref={headingRef}
          data-testid="part-name-heading"
          onClick={onOpen}
          className="flex min-h-(--control-box) w-full min-w-0 items-center gap-2 rounded-sm text-left transition hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-hidden dark:hover:text-brand-300"
        >
          <span className="truncate text-base font-semibold text-slate-900 dark:text-slate-50">
            {name}
          </span>
          {badge}
        </button>
      ) : (
        children
      )}
    </div>
  );
}
