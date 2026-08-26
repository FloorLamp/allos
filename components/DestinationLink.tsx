import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import DestinationIndicator from "@/components/DestinationIndicator";

type DestinationLinkProps = Omit<
  ComponentProps<typeof Link>,
  "children" | "className" | "title"
> & {
  children: ReactNode;
  className?: string;
};

type StandingDestinationLinkProps = DestinationLinkProps & {
  destinationLabel: string;
};

type DestinationActionLinkProps = Omit<
  DestinationLinkProps,
  "className" | "style"
>;

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

// A destination presented beside ordinary row actions. It shares the one
// ordinary-control treatment without pretending a link is a button, and exposes
// no class/style seam for a caller to resize or recolor it.
export function DestinationActionLink({
  children,
  ...props
}: DestinationActionLinkProps) {
  return (
    <DestinationLink
      {...props}
      className="button-control"
      data-button-control=""
    >
      {children}
    </DestinationLink>
  );
}

// Standing's hover/focus rail is a real presentation variant: its destination name
// and indicator arrive in a fixed, out-of-flow rail at the right edge of the row's
// facts cell. Nothing is exchanged for it — the reading's own age text stays fully
// visible underneath (#3555 ruling 1).
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
        // `z-20` keeps the door above the members that share its line: those sit at
        // `z-10` so their own text stays the pointer's target under the row-wide link
        // surface (#3555 ruling 2), and without this the door's `bg-surface` would
        // fall behind the very text it exists to cover.
        className="standing-door pointer-events-none absolute inset-y-0 right-0 z-20 inline-flex shrink-0 items-center gap-1 bg-surface pl-3 text-xs font-medium whitespace-nowrap text-brand-700 dark:text-brand-400"
        data-testid="standing-door"
        aria-hidden="true"
      >
        {destinationLabel}
        <DestinationIndicator />
      </span>
    </Link>
  );
}
