import ScrollFade from "@/components/ScrollFade";
import Chip from "@/components/Chip";
import type { ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";

// The one composition for a single-choice filter group. A whole group uses
// either URL links or callback buttons; it cannot mix them. Option metadata and
// regular/dense geometry flow through Chip, while this owner supplies the label
// and one of three bounded layouts: scrolling, wrapping, or Timeline's
// phone-scroll/`sm`-wrap response. It declares no client boundary, so link groups
// remain server-renderable and button groups inherit their caller's.
//
// ONE GAP, AND IT IS THE REACH FLOOR (#3938, app/globals.css): every layout spends
// `gap-3`. Dense used to tighten it to 6px, which would overlap the hit regions.

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
    /**
     * What a reader hears instead of the visible label, where they differ. There is
     * deliberately no `title` beside it: `lib/__tests__/raw-title-boundary.test.ts`
     * keeps production free of hover-only explanatory titles (#3375), and a hint only
     * a pointer can reach is what that ratchet exists to refuse.
     */
    accessibleLabel?: string;
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
              pressed={active}
              /* A stated accessible label wins; otherwise a custom `content` pill
                 falls back to its own label, which is the rule that was here. */
              accessibleLabel={
                o.accessibleLabel ?? (o.content ? o.label : undefined)
              }
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
