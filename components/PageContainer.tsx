import type { ReactNode } from "react";

// Page measures inside the app shell's 110rem cap. Rail combines a 48rem
// reading column, a 1.5rem gap, and a 47.5rem rail; history/page.tsx owns the
// grid's breakpoint derivation. className supplies spacing and centering only.
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

export default function PageContainer({
  width,
  className,
  children,
  "data-testid": testId,
}: {
  width: PageWidth;
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
