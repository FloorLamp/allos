"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconChevronDown, IconPlus } from "@tabler/icons-react";
import Collapse from "./Collapse";
import ModalShell from "./ModalShell";

// The shared RARE-CADENCE ENTRY disclosure (the #1497 rule), defined once.
//
// A standing add form is a permanent tax on the page it sits at the bottom of, and
// it is charged on every visit whether or not the visit is an entry visit. That is
// fine for a daily-cadence surface (logging a dose, a meal, a set) — and wrong for a
// RARE one: lab results, imaging studies and genomic variants arrive a few times a
// year, mostly by import, so their forms rendered open on every read of the Results
// hub. #1499's audit counted fifteen forms standing on the Biomarkers tab alone.
//
// Behind "+ Add" the form costs one button until it is wanted. Inline panels stay
// MOUNTED while collapsed so <Collapse> can animate them and preserve their fields;
// modal panels mount only while their dialog is open.
//
// DEEP LINKS AUTO-EXPAND. `defaultOpen` is the SERVER's decision — it reads the
// intent params that mean "you came here to add something" (`?new=1&name=…` from the
// command palette and the medication-monitoring "Add result" action) — and it is the
// INITIAL state only, never a controlled value: once the user has opened or closed
// the panel, the next render must not yank it back. Same contract as
// CustomRangeDisclosure (#1455) and the Timeline's symptom entry (#1517), which is
// now a wrapper over this component rather than a second copy of it.
//
// `id` lands on the wrapper so an in-page anchor (`#add-result`) still finds the
// panel whether it is open or closed.
const AddEntryModalCloseContext = createContext<(() => void) | null>(null);

// Add forms use this only after a successful save. Edit forms render outside the
// provider and receive null, so their existing row-level onDone behavior is
// unchanged.
export function useAddEntryModalClose() {
  return useContext(AddEntryModalCloseContext);
}

export default function AddEntryPanel({
  label,
  addLabel,
  defaultOpen = false,
  id,
  panelId,
  testId,
  toggleTestId,
  dense = false,
  presentation = "inline",
  children,
}: {
  // The heading shown when the panel is OPEN, and the fallback for the collapsed
  // button ("+ Add medical record").
  label: string;
  // Optional shorter collapsed-button text when the heading would be long on a
  // phone ("+ Add result").
  addLabel?: string;
  defaultOpen?: boolean;
  id?: string;
  // DOM id for the panel region, referenced by the toggle's aria-controls.
  panelId: string;
  testId?: string;
  // The toggle's own testid, when the surface's spec names it independently of the
  // wrapper (the Timeline's `timeline-symptom-toggle`). Defaults to `<testId>-toggle`.
  toggleTestId?: string;
  // Tighter rhythm + a small-caps-weight heading, for a panel that sits INSIDE a
  // day view rather than at the foot of a page. Purely visual.
  dense?: boolean;
  // Rare-entry forms in hub rails use a modal so opening one never pushes the
  // list away. Inline remains available for compact, in-context disclosures.
  presentation?: "inline" | "modal";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeModal = useCallback(() => {
    setOpen(false);
    // The dialog's focused control is about to unmount. Return keyboard users to
    // the CTA that opened it after React commits the close.
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  const gap = presentation === "modal" ? "" : dense ? "mb-5" : "mb-6";

  if (presentation === "modal") {
    return (
      <div
        id={id}
        data-testid={testId}
        data-open={open ? "true" : "false"}
        className={gap}
      >
        <button
          ref={triggerRef}
          type="button"
          data-testid={
            toggleTestId ?? (testId ? `${testId}-toggle` : undefined)
          }
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(true)}
          className="btn text-sm"
        >
          <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
          {addLabel ?? label}
        </button>
        {open ? (
          <ModalShell title={label} onClose={closeModal}>
            <AddEntryModalCloseContext.Provider value={closeModal}>
              <div id={panelId} className="mt-4">
                {children}
              </div>
            </AddEntryModalCloseContext.Provider>
          </ModalShell>
        ) : null}
      </div>
    );
  }

  return (
    <div
      id={id}
      data-testid={testId}
      data-open={open ? "true" : "false"}
      // Collapsed it is a bare affordance, not a card: a bordered box holding one
      // button would give most of the block back and then charge for the frame.
      className={open ? `card ${gap}` : gap}
    >
      <button
        type="button"
        data-testid={toggleTestId ?? (testId ? `${testId}-toggle` : undefined)}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={
          open
            ? `flex w-full items-center justify-between gap-2 text-left font-semibold text-slate-800 dark:text-slate-100${
                dense ? " text-sm" : ""
              }`
            : "btn-ghost text-sm"
        }
      >
        {open ? (
          <>
            <span>{label}</span>
            <IconChevronDown
              className="h-4 w-4 shrink-0 rotate-180 transition-transform"
              aria-hidden="true"
            />
          </>
        ) : (
          <>
            <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
            {addLabel ?? label}
          </>
        )}
      </button>
      <Collapse open={open}>
        <div id={panelId} className="pt-3">
          {children}
        </div>
      </Collapse>
    </div>
  );
}
