import Link from "next/link";
import type { MouseEventHandler, ReactNode } from "react";
import TimelineFilterLink from "@/components/TimelineFilterLink";
import type { AppRoute } from "@/lib/hrefs";

export type ChipRole = "nav" | "filter";
export type ChipDensity = "regular" | "dense";

interface InternalChipLinkProps {
  href: AppRoute | `#${string}`;
  className: string;
  children: ReactNode;
  ariaCurrent?: "page" | "true" | "location";
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
}

type CommonProps = {
  role: ChipRole;
  density?: ChipDensity;
  children: ReactNode;
  testId?: string;
};

type LinkChipProps = CommonProps & {
  current: boolean;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  pressed?: never;
  disabled?: never;
  expanded?: never;
  controls?: never;
} & (
    | {
        href: `#${string}`;
        linkBehavior?: never;
      }
    | {
        href: AppRoute;
        /** Closed behavior adapter; presentation and ARIA remain primitive-owned. */
        linkBehavior?: "timeline";
      }
  );

type FilterButtonChipProps = CommonProps & {
  role: "filter";
  pressed: boolean;
  accessibleLabel?: string;
  data?: Readonly<
    Record<`data-${string}`, string | number | boolean | undefined>
  >;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  href?: never;
  current?: never;
  linkBehavior?: never;
};

export type ChipProps = LinkChipProps | FilterButtonChipProps;

function DefaultChipLink({
  href,
  className,
  children,
  ariaCurrent,
  onClick,
  testId,
}: InternalChipLinkProps) {
  const props = {
    href,
    className,
    children,
    "aria-current": ariaCurrent,
    onClick,
    "data-testid": testId,
  };
  return href.startsWith("#") ? <a {...props} /> : <Link {...props} />;
}

// The one pressable chip primitive. Role chooses the visual language, density
// chooses the registered regular or 44px-dense geometry, and interaction state
// is the same state that paints the selected treatment. Callers provide content
// and behavior, never presentation classes or independent ARIA state.
export default function Chip(props: ChipProps) {
  const density = props.density ?? "regular";
  const className = `chip-base chip-${props.role}${density === "dense" ? " chip-sm" : ""}`;

  if (props.href !== undefined) {
    const ariaCurrent = props.current
      ? props.role === "filter"
        ? "true"
        : props.href.startsWith("#")
          ? "location"
          : "page"
      : undefined;
    if (props.linkBehavior === "timeline") {
      return (
        <TimelineFilterLink
          href={props.href}
          ariaCurrent={ariaCurrent}
          onClick={props.onClick}
          className={className}
          testId={props.testId}
        >
          {props.children}
        </TimelineFilterLink>
      );
    }
    return (
      <DefaultChipLink
        href={props.href}
        ariaCurrent={ariaCurrent}
        onClick={props.onClick}
        className={className}
        testId={props.testId}
      >
        {props.children}
      </DefaultChipLink>
    );
  }

  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-pressed={props.pressed}
      aria-label={props.accessibleLabel}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={props.onClick}
      data-testid={props.testId}
      data-chip-role="filter"
      className={className}
      {...props.data}
    >
      {props.children}
    </button>
  );
}
