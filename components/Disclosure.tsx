import type { ComponentPropsWithRef, ReactNode } from "react";

// THE DISCLOSURE (#3677, the first tenant of #3676's continuity class).
//
// One owner for every fold in the app. Before this, ~50 files hand-rolled a raw
// `<details>` and every one of them SNAPPED: the panel appeared at full height with
// the reader's finger still on the summary, which on a phone is a full-screen jump.
//
// It is a native `<details>` carrying `motion-disclose`, and the class does all the
// work in app/globals.css. So there is no state, no effect, no timer and no
// `"use client"`: a server component keeps rendering on the server, the fold still
// opens with JavaScript disabled, in-page find still auto-expands it, and the
// keyboard and accessibility semantics are the platform's, unchanged.
//
// NOT <Collapse>, which is the app's BUTTON disclosure. Its grid `0fr → 1fr` cannot
// animate a `<details>`: while a details is closed its contents are not rendered, so
// opening resolves the wrapper's first style already at full height and no transition
// runs — measured in Chromium 141, not assumed. Both spend the same continuity token.
//
// THE MEMORY CONTRACT IS UNTOUCHED, structurally: lib/disclosure-memory.ts's pre-paint
// script sets `open` before the first frame, and an element opened before it has ever
// been painted has no earlier height to travel from. A remembered-open fold is simply
// open, with no entrance replay — the ambient motion #3676 refuses — and nothing here
// has to remember to suppress it.
//
// The caller brings what the summary SAYS and the classes that are about its own type
// and colour. It does not bring the marker or the `group` its `group-open:` chevron
// needs: those are here, once.
export default function Disclosure({
  summary,
  summaryClassName = "",
  summaryTestId,
  summaryLabel,
  className = "",
  children,
  ...rest
}: Omit<ComponentPropsWithRef<"details">, "children"> & {
  /** What the closed fold says it holds. Rendered inside the `<summary>`. */
  summary: ReactNode;
  summaryClassName?: string;
  summaryTestId?: string;
  /** An accessible name for the summary, where its content is not enough. */
  summaryLabel?: string;
  children: ReactNode;
}) {
  return (
    <details className={`motion-disclose group ${className}`} {...rest}>
      <summary
        className={summaryClassName}
        data-testid={summaryTestId}
        aria-label={summaryLabel}
      >
        {summary}
      </summary>
      {children}
    </details>
  );
}
