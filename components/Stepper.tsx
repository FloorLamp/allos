import type { ReactNode } from "react";

// ONE STEPPER (#4542). "A value with a decrement and an increment" was written six
// ways at once — three glyph sources, four geometries, four paints. This owns the
// control box and the two buttons; the caller owns the VALUE, so `onStep` takes a
// direction and does its own domain's arithmetic. At-floor behaviour lives there
// too (clamp, or clear the field by stepping off the bottom): it is a property of
// the step, not of the chrome, so there is no policy prop for it here.
//
// 44px BELOW `sm`, 28×36 ABOVE — the activity form's shipped pair, pinned by
// e2e/entry-ergonomics.spec.ts. #4505 moves it onto `--control-box` with every other
// pressable, and this extraction is what makes that one line instead of six files.
const BUTTON =
  "flex h-11 w-11 shrink-0 items-center justify-center text-sm font-semibold text-slate-500 hover:bg-slate-100 hover:text-brand-600 disabled:opacity-40 sm:h-9 sm:w-7 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-brand-400";

export default function Stepper({
  onStep,
  decreaseLabel,
  increaseLabel,
  children,
  className,
  testId,
  stepTestId,
  disabled,
  decreaseDisabled,
  // The buttons are pointer sugar beside a value the reader can type into, so the
  // activity form keeps them OUT of the tab sequence (#3335: a set row's tab order
  // must not change when a conditional column appears). A stepper whose value is not
  // editable keeps them in it, because they are the only way to act.
  tabStops = true,
}: {
  onStep: (direction: -1 | 1) => void;
  decreaseLabel: string;
  increaseLabel: string;
  /** The middle slot: an input, a static reading, or nothing. */
  children?: ReactNode;
  /** The caller's sizing and border color — the box owns everything else. */
  className?: string;
  testId?: string;
  /** Names the two buttons `<stepTestId>-down` and `-up`, where a spec drives them. */
  stepTestId?: string;
  disabled?: boolean;
  decreaseDisabled?: boolean;
  tabStops?: boolean;
}) {
  const button = (direction: -1 | 1, label: string, off?: boolean) => (
    <button
      type="button"
      data-testid={
        stepTestId && `${stepTestId}-${direction === -1 ? "down" : "up"}`
      }
      tabIndex={tabStops ? undefined : -1}
      disabled={disabled || off}
      onClick={() => onStep(direction)}
      aria-label={label}
      className={BUTTON}
    >
      {direction === -1 ? "−" : "+"}
    </button>
  );
  return (
    <div
      data-testid={testId}
      className={`flex overflow-hidden rounded-lg border bg-field focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500 ${className ?? ""}`}
    >
      {button(-1, decreaseLabel, decreaseDisabled)}
      {children}
      {button(1, increaseLabel, false)}
    </div>
  );
}
