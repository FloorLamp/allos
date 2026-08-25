import Link from "next/link";
import type { ComponentType, MouseEventHandler, ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

export type ChipRole = "nav" | "filter";
export type ChipDensity = "regular" | "dense";

export interface ChipLinkRenderProps {
  href: AppRoute | `#${string}`;
  className: string;
  children: ReactNode;
  current?: boolean;
  ariaCurrent?: "page" | "true";
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
  title?: string;
}

type CommonProps = {
  role: ChipRole;
  density?: ChipDensity;
  children: ReactNode;
  title?: string;
  testId?: string;
};

type LinkChipProps = CommonProps & {
  href: AppRoute | `#${string}`;
  current: boolean;
  LinkComponent?: ComponentType<ChipLinkRenderProps>;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  pressed?: never;
  disabled?: never;
  expanded?: never;
  controls?: never;
};

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
  LinkComponent?: never;
};

export type ChipProps = LinkChipProps | FilterButtonChipProps;

function DefaultChipLink({
  href,
  className,
  children,
  current,
  ariaCurrent,
  onClick,
  testId,
  title,
}: ChipLinkRenderProps) {
  const props = {
    href,
    className,
    children,
    "aria-current": current ? ariaCurrent : undefined,
    onClick,
    "data-testid": testId,
    title,
  };
  return href.startsWith("#") ? <a {...props} /> : <Link {...props} />;
}

// The one pressable chip primitive. Role chooses the visual language, density
// chooses the registered regular or 44px-dense geometry, and interaction state
// is the same state that paints the selected treatment. Callers provide content
// and behavior, never presentation classes or independent ARIA state.
export default function Chip(props: ChipProps) {
  const density = props.density ?? "regular";
  const className = `chip chip-${props.role}${density === "dense" ? " chip-sm" : ""}`;

  if (props.href !== undefined) {
    const ChipLink = props.LinkComponent ?? DefaultChipLink;
    return (
      <ChipLink
        href={props.href}
        current={props.current}
        ariaCurrent={props.role === "nav" ? "page" : "true"}
        onClick={props.onClick}
        className={className}
        testId={props.testId}
        title={props.title}
      >
        {props.children}
      </ChipLink>
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
      title={props.title}
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
