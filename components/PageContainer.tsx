import type { ReactNode } from "react";

// One source of truth for page-level content width (issue #794 cluster 9b). The
// app shell already centers and caps content at 110rem on 3xl (app/(app)/layout);
// individual pages that want a NARROWER reading/form measure used to hand-write a
// `max-w-*` literal on their outermost wrapper. Those named widths live here so a
// detail page and a form page can't drift to different values:
//   - "reading" — detail / reading pages (was max-w-3xl)
//   - "form"    — compact settings-style forms (max-w-lg)
//   - "full"    — no extra cap; fill the shell container (default)
// Extra classes (e.g. `mx-auto`, `space-y-*`) pass through `className` so adoption
// is mechanical and pixel-for-pixel — this component only owns the width token.
const WIDTHS = {
  form: "max-w-lg",
  reading: "max-w-3xl",
  full: "",
} as const;

export default function PageContainer({
  width = "full",
  className,
  children,
  "data-testid": testId,
}: {
  width?: keyof typeof WIDTHS;
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
