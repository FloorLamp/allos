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
// "OUTSIDE THE HOST" IS ABOUT LIFETIME, NOT ABOUT OWNERSHIP — and the difference used to
// matter enough to lose someone's typing (#3352). The sentence above says the state must
// SURVIVE a panel closing; it does not say the field's `value` has to become a React
// prop. Taking it as the latter on a DOM-collected form (`<form action={...}>`, named
// inputs) turned every converted field CONTROLLED, and the dirty-form registry read the
// DOM `defaultValue` as the server's value — which React syncs onto a controlled field
// to match its `value`. So the field compared equal to itself, reported clean forever,
// and its discard guard vanished with no test noticing.
//
// That hole is closed in the registry itself (components/DirtyFormRegistry.tsx detects
// who owns a field from the user's own first keystroke), so a consumer may now write
// either kind and keep its guard. Two things are still worth knowing:
//
//   * The CHEAPEST way to keep editor state outside the host is a field that is merely
//     hidden rather than unmounted — the DOM already holds the value, and nothing has to
//     mirror it. `ProtocolForm` does this for most of its fields.
//   * A controlled field that AUTOSAVES needs `data-server-value` to say what the server
//     now holds; without it the DOM cannot tell a saved value from a mirrored one, and
//     the field stays dirty until the form submits, resets or unmounts.
//
// AND BOTH RETURN FOCUS TO THE CHIP THAT OPENED THE EDITOR, not merely to the row and
// not merely to the panel's first door (#3311). Opening an
// editor unmounts the chip that was activated, so without this focus falls to <body> and
// stays there: someone navigating by keyboard states a fact and finds the next Tab
// starting from the top of the document. See `restoreFact` in useFactEditor for why the
// fix is keyed on the FACT and not on the element.
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
//
// `scopeRef` is the region the chips and the one editor share — the consumer's form or
// dialog body, the same element that already receives `onKeyDown`. The hook needs it to
// put focus back where it came from, and it is REQUIRED rather than optional because a
// consumer that forgets loses the return path with nothing on screen to show for it.
export function useFactEditor<K extends string>({
  scopeRef,
  initial = null,
}: {
  scopeRef: React.RefObject<HTMLElement | null>;
  initial?: K | null;
}): {
  openEditor: K | null;
  // `focusKey` is the CHIP that opened this panel, when the two are not the same
  // question — several chips can open one editor. Defaults to the panel key, which is
  // right whenever a panel has exactly one door. See FactChipRow's header.
  open: (key: K, focusKey?: string) => void;
  close: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
} {
  const [openEditor, setOpenEditor] = useState<K | null>(initial);

  // WHICH CHIP FOCUS GOES BACK TO, and note that it is a KEY rather than the element the
  // person activated (#3311).
  //
  // The obvious implementation — capture `document.activeElement` on open, call
  // `.focus()` on it on close — is a no-op here EVERY time, not just in the awkward
  // cases. Opening an editor unmounts the entire chip row, so when the row comes back
  // every chip is a freshly created DOM node and the captured one is disconnected. The
  // captured element is not stale only when a fact stated for the first time replaces
  // its "+ thing" prompt; it is stale always. A key still names the chip across that
  // remount, so the row is asked for it rather than told which element to use.
  //
  // It is the CHIP's key, not the panel's: the intake form draws one chip per rule
  // sentence and all of them open the one rules builder, so a panel key would return
  // focus to the first rule no matter which one was opened.
  const openedFrom = useRef<string | null>(null);
  const restoreFocus = useRef<string | null>(null);

  const open = useCallback((key: K, focusKey?: string) => {
    openedFrom.current = focusKey ?? key;
    setOpenEditor(key);
  }, []);

  const close = useCallback(() => {
    if (openEditor != null) restoreFocus.current = openedFrom.current;
    setOpenEditor(null);
  }, [openEditor]);

  // Esc closes an editor exactly as Done does — the same return to the chips, so the
  // keyboard path is never the one that traps you inside a fact. Literally the same
  // call, so the focus return cannot come to differ between the two.
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
      close();
    },
    [close, openEditor]
  );

  // Land the focus once the chips are back on screen. Runs only after a close, so a
  // consumer mounting with nothing open never has focus taken from it.
  //
  // THE SECOND ESCAPE STILL CLOSES THE DIALOG, which is deliberate and asserted
  // (#3222): the chip is inside the modal panel and is not itself an escape layer, so
  // the shared window-capture trap answers the next Escape exactly as it did when focus
  // sat on <body>.
  useEffect(() => {
    if (openEditor !== null) return;
    const key = restoreFocus.current;
    restoreFocus.current = null;
    const scope = scopeRef.current;
    if (key == null || scope == null) return;
    // FOCUS LANDS WHERE THE THING YOU JUST DID NOW LIVES, in three tiers.
    //
    // The chip itself, when the row still draws it. Otherwise the trailing affordance:
    // an optional fact left empty has no chip of its own and has gone back inside that
    // one control, so that is where the person would reach for it again — returning to
    // the row instead would be true but unhelpful. Only a surface with no trailing
    // affordance at all (the sleep dialog has none by design — its facts are all
    // essential) falls through to the row, which beats <body> and nothing else.
    const target =
      scope.querySelector<HTMLElement>(
        `[data-focus-key="${CSS.escape(key)}"]`
      ) ??
      scope.querySelector<HTMLElement>("[data-fact-more]") ??
      scope.querySelector<HTMLElement>("[data-fact-row]");
    target?.focus();
  }, [openEditor, scopeRef]);

  return { openEditor, open, close, onKeyDown };
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
