"use client";

import { useCallback, useState, type ReactNode } from "react";

// The other half of the facts-with-editors primitive (#3218): the SINGLE-EDITOR HOST.
//
// AT MOST ONE EDITOR IS ON SCREEN. A consumer renders its chip row when nothing is open
// and this host when something is — never both — so the form is either stating what it
// will save or asking about exactly one fact. That is the whole reason the pattern beats
// grouping: complexity is paid per fact the person disagrees with, not per field.
//
// DONE AND ESC ARE THE SAME GESTURE, by contract, and both return to the chips. Nothing
// is committed or discarded by either: the editor is HIDDEN, not unmounted, so the value
// still posts with the form (#2014). A consumer must therefore keep its editor state
// outside the host.

// The open-editor state and its keyboard contract, so every consumer gets the same one.
// `K` is the consumer's own fact key union — the primitive never learns the names.
export function useFactEditor<K extends string>(
  initial: K | null = null
): {
  openEditor: K | null;
  open: (key: K) => void;
  close: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
} {
  const [openEditor, setOpenEditor] = useState<K | null>(initial);
  const close = useCallback(() => setOpenEditor(null), []);

  // Esc closes an editor exactly as Done does — the same return to the chips, so the
  // keyboard path is never the one that traps you inside a fact.
  //
  // IT YIELDS THE FIRST ESCAPE TO AN OPEN PICKER. A combobox inside an editor uses
  // Escape to close its own listbox; swallowing that would make the one key that
  // dismisses a dropdown throw away the whole editor instead. So an Escape aimed at
  // an EXPANDED combobox belongs to the combobox, and the next one closes the editor.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape" || openEditor == null) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.getAttribute("role") === "combobox" &&
        target.getAttribute("aria-expanded") === "true"
      )
        return;
      setOpenEditor(null);
    },
    [openEditor]
  );

  return { openEditor, open: setOpenEditor, close, onKeyDown };
}

// The one open editor, with the Done that returns to the chips. `panel` is echoed as
// `data-panel` so a test can name which fact is open without reading its contents.
export default function FactEditorHost({
  testId,
  panel,
  className,
  bodyClassName,
  doneTestId,
  doneLabel = "Done",
  onDone,
  children,
}: {
  testId?: string;
  panel?: string;
  className?: string;
  bodyClassName?: string;
  doneTestId?: string;
  doneLabel?: string;
  onDone: () => void;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} data-panel={panel} className={className}>
      <div className={bodyClassName}>{children}</div>
      <button
        type="button"
        data-testid={doneTestId}
        onClick={onDone}
        className="btn-ghost btn-sm mt-4"
      >
        {doneLabel}
      </button>
    </section>
  );
}
