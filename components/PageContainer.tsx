import type { ReactNode } from "react";

// Page measures inside the app shell's 110rem cap. Rail combines a 48rem
// reading column, a 1.5rem gap, and a 47.5rem rail; history/page.tsx owns the
// grid's breakpoint derivation. className supplies spacing only.
const WIDTHS = {
  form: "max-w-lg",
  narrow: "max-w-2xl",
  reading: "max-w-3xl",
  rail: "max-w-3xl min-[1440px]:max-w-[97rem]",
  flow: "max-w-4xl",
  wide: "max-w-6xl",
  full: "",
} as const;

export type PageWidth = keyof typeof WIDTHS;

/**
 * Where a capped measure sits in the space it is given (#3961). Alignment is the
 * primitive's, not a per-call-site class: a capped page centers unless it says
 * otherwise, so it cannot drift back to left-hugging one page at a time. `start`
 * is for content anchored to something beside it — the settings form beside its
 * sub-nav, a record tab under its tab strip, which would slide on every switch
 * if each tab centered its own measure. `full` has no cap, so alignment is moot.
 */
export type PageAlign = "center" | "start";

export default function PageContainer({
  width,
  align = "center",
  className,
  children,
  "data-testid": testId,
}: {
  width: PageWidth;
  align?: PageAlign;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const centered = width !== "full" && align === "center";
  const classes = [WIDTHS[width], centered ? "mx-auto" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes || undefined} data-testid={testId}>
      {children}
    </div>
  );
}
