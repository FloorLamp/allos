import type { ReactNode } from "react";

// One source of truth for page-level content width (issue #794 cluster 9b). The
// app shell already centers and caps content at 110rem on 3xl (app/(app)/layout);
// individual pages that want a NARROWER reading/form measure used to hand-write a
// `max-w-*` literal on their outermost wrapper. Those named widths live here so a
// detail page and a form page can't drift to different values.
//
// The vocabulary, narrowest first:
//   - "form"    — compact settings-style forms (max-w-lg)
//   - "narrow"  — a single centered card/artifact on a chrome-less page (max-w-2xl)
//   - "reading" — detail / reading pages (max-w-3xl)
//   - "flow"    — a guided multi-step flow: wider than prose so its choice grids
//                 fit, narrower than a dashboard (max-w-4xl)
//   - "wide"    — dense multi-column pages that still want a measure inside the
//                 shell's 110rem (max-w-6xl)
//   - "full"    — no extra cap; fill the shell container (default)
//
// Extra classes (e.g. `mx-auto`, `space-y-*`) pass through `className` so adoption
// is mechanical and pixel-for-pixel — this component only owns the width token, and
// `lib/__tests__/page-width-scan.test.ts` reads WIDTHS straight out of this file so
// the guard's vocabulary can never drift from the component's (a new token here is
// a new token there, with no second list to update).
const WIDTHS = {
  form: "max-w-lg",
  narrow: "max-w-2xl",
  reading: "max-w-3xl",
  flow: "max-w-4xl",
  wide: "max-w-6xl",
  full: "",
} as const;

export type PageWidth = keyof typeof WIDTHS;

export default function PageContainer({
  width = "full",
  className,
  children,
  "data-testid": testId,
}: {
  width?: PageWidth;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const classes = [WIDTHS[width], className].filter(Boolean).join(" ");
  return (
    <div className={classes || undefined} data-testid={testId}>
      {children}
    </div>
  );
}
