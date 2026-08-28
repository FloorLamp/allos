import ScrollFade from "@/components/ScrollFade";
import Chip from "@/components/Chip";
import type { ChipDensity } from "@/components/Chip";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

// The one composition for a single-choice filter group. A whole group uses
// either URL links or callback buttons; it cannot mix them. Option metadata and
// regular/dense geometry flow through Chip, while this owner supplies the label
// and one of three bounded layouts: scrolling, wrapping, or Timeline's
// phone-scroll/`sm`-wrap response. It declares no client boundary, so link groups
// remain server-renderable and button groups inherit their caller's.
//
// ONE GAP, AND IT IS THE REACH FLOOR (#3938). Every layout spends `gap-3` = 12px,
// which is 2x the per-side reach a coarse pointer gets around the 34px control
// box — so a filter group's hit regions meet without ever owning the same point.
// The dense density used to tighten this to 6px, which would overlap them.

type FilterPillValue = string | number | null;

type FilterPillBaseOption<T extends FilterPillValue> = {
  value: T;
  label: string;
  content?: ReactNode;
  testId?: string;
};

export type FilterPillOption<T extends FilterPillValue> =
  FilterPillBaseOption<T> & {
    href: AppRoute;
  };

export type FilterPillButtonOption<T extends FilterPillValue> =
  FilterPillBaseOption<T> & {
    href?: never;
    disabled?: boolean;
    data?: Readonly<
      Record<`data-${string}`, string | number | boolean | undefined>
    >;
  };

type FilterPillsProps<T extends FilterPillValue> = {
  /** `undefined` means no option is selected; `null` may be a real option. */
  value: T | undefined;
  label: string;
  testId?: string;
  optionTestId?: (value: T) => string;
  density?: ChipDensity;
  layout?: "scroll" | "wrap" | "responsive";
} & (
  | {
      mode: "link";
      options: readonly FilterPillOption<T>[];
      linkBehavior?: "timeline";
      onSelect?: never;
    }
  | {
      mode: "button";
      options: readonly FilterPillButtonOption<T>[];
      onSelect: (next: T) => void;
      linkBehavior?: never;
    }
);

function optionKey(value: FilterPillValue): string {
  return value === null ? "null:" : `${typeof value}:${value}`;
}

export default function FilterPills<T extends FilterPillValue>(
  props: FilterPillsProps<T>
) {
  const options =
    props.mode === "link"
      ? props.options.map((o) => {
          const active = o.value === props.value;
          return (
            <Chip
              key={optionKey(o.value)}
              role="filter"
              density={props.density}
              href={o.href}
              current={active}
              linkBehavior={props.linkBehavior}
              testId={o.testId ?? props.optionTestId?.(o.value)}
            >
              {o.content ?? o.label}
            </Chip>
          );
        })
      : props.options.map((o) => {
          const active = o.value === props.value;
          return (
            <Chip
              key={optionKey(o.value)}
              role="filter"
              density={props.density}
              pressed={active}
              accessibleLabel={o.content ? o.label : undefined}
              disabled={o.disabled}
              testId={o.testId ?? props.optionTestId?.(o.value)}
              data={o.data}
              onClick={() => props.onSelect(o.value)}
            >
              {o.content ?? o.label}
            </Chip>
          );
        });

  const groupProps = {
    role: "group" as const,
    "aria-label": props.label,
    "data-testid":
      props.testId ?? (props.layout === "wrap" ? undefined : "filter-pills"),
    "data-chip-role": "filter",
  };
  if (props.layout === "wrap") {
    return (
      <div {...groupProps} className="flex flex-wrap items-center gap-3">
        {options}
      </div>
    );
  }
  return (
    <ScrollFade
      {...groupProps}
      className={
        props.layout === "responsive"
          ? "-mx-2 flex gap-3 px-2 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
          : "flex gap-3"
      }
    >
      {options}
    </ScrollFade>
  );
}
