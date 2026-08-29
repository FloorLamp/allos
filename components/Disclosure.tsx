import type { ComponentPropsWithRef } from "react";

// THE DISCLOSURE (#3677) — one owner for every fold in the app, and the first tenant
// of #3676's continuity class. Before this, 47 files hand-rolled a raw `<details>` and
// every one SNAPPED: the panel arrived at full height with the reader's finger still
// on the summary, which on a phone is a full-screen jump.
//
// A native `<details>` carrying `motion-disclose`; the class does all the work in
// app/globals.css. So there is no state, no effect, no timer and no `"use client"`:
// this still renders on the server, the fold still opens with JavaScript disabled,
// in-page find still auto-expands it, and the keyboard and AT semantics are the
// platform's. The `<summary>` stays the CALLER'S element — that is where a fold says
// what it holds, and 47 of them say it differently.
//
// NOT <Collapse>, the app's BUTTON disclosure: its grid `0fr → 1fr` cannot animate a
// `<details>`, because a closed details does not render its contents, so opening
// resolves the wrapper's first style already at full height and no transition runs
// (measured, Chromium 141). Both spend the same continuity token.
//
// THE MEMORY CONTRACT IS UNTOUCHED, structurally: lib/disclosure-memory.ts's pre-paint
// script sets `open` before the first frame, and an element opened before it was ever
// painted has no earlier height to travel from. A remembered-open fold is simply open,
// with no entrance replay — the ambient motion #3676 refuses — and nothing here has to
// remember to suppress it.
export default function Disclosure({
  className = "",
  children,
  ...rest
}: ComponentPropsWithRef<"details">) {
  // `group` is here so an adopter's chevron can read `group-open:` without each one
  // declaring the group itself.
  return (
    <details className={`motion-disclose group ${className}`} {...rest}>
      {children}
    </details>
  );
}
