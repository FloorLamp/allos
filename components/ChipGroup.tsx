import type { ReactNode } from "react";
import Chip, { type ChipDensity } from "@/components/Chip";

export type ChipGroupOption<T extends string | number> = {
  value: T;
  label: string;
  content?: ReactNode;
  disabled?: boolean;
  title?: string;
  testId?: string;
  data?: Readonly<
    Record<`data-${string}`, string | number | boolean | undefined>
  >;
};

// The composition for an ordinary, single-choice option group. It owns the
// repeated Chip wiring so callers provide domain options, not local Chip maps.
export default function ChipGroup<T extends string | number>({
  label,
  options,
  value,
  onSelect,
  density = "regular",
  testId,
}: {
  label: string;
  options: readonly ChipGroupOption<T>[];
  value: T | null;
  onSelect: (value: T) => void;
  density?: ChipDensity;
  testId?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className={`flex flex-wrap items-center ${density === "dense" ? "gap-1.5" : "gap-2"}`}
    >
      {options.map((option) => (
        <Chip
          key={option.value}
          role="filter"
          density={density}
          pressed={option.value === value}
          accessibleLabel={option.content ? option.label : undefined}
          disabled={option.disabled}
          title={option.title}
          testId={option.testId}
          data={option.data}
          onClick={() => onSelect(option.value)}
        >
          {option.content ?? option.label}
        </Chip>
      ))}
    </div>
  );
}
