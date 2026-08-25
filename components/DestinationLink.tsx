import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import DestinationIndicator from "@/components/DestinationIndicator";

type DestinationLinkProps = Omit<
  ComponentProps<typeof Link>,
  "children" | "className"
> & {
  children: ReactNode;
  className?: string;
};

type StandingDestinationLinkProps = DestinationLinkProps & {
  destinationLabel: string;
};

// The one rightward destination indicator. Callers own their link's content and
// housing; this primitive owns the glyph, spacing, geometry, and accessibility.
export default function DestinationLink({
  children,
  className = "",
  ...props
}: DestinationLinkProps) {
  return (
    <Link {...props} className={className || undefined}>
      {children}
      <span
        className="ml-auto inline-flex shrink-0 items-center gap-1 pl-1 align-middle"
        aria-hidden="true"
      >
        <DestinationIndicator />
      </span>
    </Link>
  );
}

// Standing's hover/focus rail is a real presentation variant: its destination
// name and indicator exchange with the age in a fixed, out-of-flow rail.
export function StandingDestinationLink({
  children,
  className = "",
  destinationLabel,
  ...props
}: StandingDestinationLinkProps) {
  return (
    <Link {...props} className={className || undefined}>
      {children}
      <span
        className="standing-door pointer-events-none absolute inset-y-0 right-0 inline-flex shrink-0 items-center gap-1 bg-surface pl-3 text-xs font-medium whitespace-nowrap text-brand-700 dark:text-brand-400"
        data-testid="standing-door"
        aria-hidden="true"
      >
        {destinationLabel}
        <DestinationIndicator />
      </span>
    </Link>
  );
}
