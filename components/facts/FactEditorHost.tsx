"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

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
//
// AND THAT CONTRACT ONLY HOLDS INSIDE A MODAL BECAUSE THE OPEN PANEL DECLARES ITSELF AN
// ESCAPE LAYER (#3222). The shared focus trap answers Escape on the WINDOW CAPTURE phase
// and stops propagation (components/useFocusTrap.ts), so without the marker a React
// keydown handler on a child never runs: the first Escape would dismiss the whole dialog
// and throw the form away, which is the opposite of "returns to the chips". The trap
// already yields to `[data-escape-layer="true"]` for the same reason Combobox, DateField
// and InfoTooltipIcon set it — a nested layer owns Escape before its parent does. The
// open panel IS such a layer, so it says so, and the grammar composes: Escape closes an
// open listbox, then the editor, then the dialog.

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
//
// THE PANEL TAKES FOCUS WHEN IT OPENS (#3222), and without that nothing else here works.
// Opening an editor UNMOUNTS the chip row, which means it unmounts the chip that was
// just activated — so focus falls back to <body>, outside the consumer's keydown
// handler, and both halves of the contract die quietly: Escape never reaches
// useFactEditor, and a keyboard user is dropped out of the form at the exact moment they
// asked to edit something. Focus lands on the section rather than on its first field
// because the first field is sometimes a date or a combobox, and auto-opening a picker
// the person did not ask for is its own bug. Tab from here reaches the fields in order.
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
  const panelRef = useRef<HTMLElement>(null);
  // Keyed on `panel` so switching directly between two facts re-lands focus, while a
  // re-render from typing inside the open editor never steals it back.
  useEffect(() => {
    panelRef.current?.focus();
  }, [panel]);

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      data-testid={testId}
      data-panel={panel}
      // See the note above: this is what makes Esc return to the chips rather than
      // dismiss the dialog the chips are sitting in.
      data-escape-layer="true"
      className={className}
    >
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
