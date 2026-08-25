import ScrollFade from "@/components/ScrollFade";
import Chip from "@/components/Chip";
import type { ChipDensity } from "@/components/Chip";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

// The one composition for a single-choice filter group. A whole group uses
// either URL links or callback buttons; it cannot mix them. Option metadata and
// regular/dense geometry flow through Chip, while this owner supplies the label
// and either scrolling or wrapping layout. It declares no client boundary, so
// link groups remain server-renderable and button groups inherit their caller's.

type FilterPillBaseOption<T extends string | number> = {
  value: T;
  label: string;
  content?: ReactNode;
  title?: string;
  testId?: string;
};

export type FilterPillOption<T extends string | number> =
  FilterPillBaseOption<T> & {
    href: AppRoute;
  };

export type FilterPillButtonOption<T extends string | number> =
  FilterPillBaseOption<T> & {
    href?: never;
    disabled?: boolean;
    data?: Readonly<
      Record<`data-${string}`, string | number | boolean | undefined>
    >;
  };

type FilterPillsProps<T extends string | number> = {
  value: T | null;
  label: string;
  testId?: string;
  optionTestId?: (value: T) => string;
  density?: ChipDensity;
  layout?: "scroll" | "wrap";
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

export default function FilterPills<T extends string | number>(
  props: FilterPillsProps<T>
) {
  const options =
    props.mode === "link"
      ? props.options.map((o) => {
          const active = o.value === props.value;
          return (
            <Chip
              key={o.value}
              role="filter"
              density={props.density}
              href={o.href}
              current={active}
              linkBehavior={props.linkBehavior}
              title={o.title}
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
              key={o.value}
              role="filter"
              density={props.density}
              pressed={active}
              accessibleLabel={o.content ? o.label : undefined}
              disabled={o.disabled}
              title={o.title}
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
      <div
        {...groupProps}
        className={`flex flex-wrap items-center ${props.density === "dense" ? "gap-1.5" : "gap-2"}`}
      >
        {options}
      </div>
    );
  }
  return (
    <ScrollFade {...groupProps} className="flex gap-2">
      {options}
    </ScrollFade>
  );
}
