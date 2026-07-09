"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Combobox from "@/components/Combobox";

export interface AnalyzeOption {
  kind: "strength" | "cardio" | "sport";
  item: string;
  label: string;
  href: string;
}

const BADGE_CLASS: Record<AnalyzeOption["kind"], string> = {
  strength:
    "badge shrink-0 bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  cardio:
    "badge shrink-0 bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  sport:
    "badge shrink-0 bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
};

const KIND_LABEL: Record<AnalyzeOption["kind"], string> = {
  strength: "Strength",
  cardio: "Cardio",
  sport: "Sport",
};

export default function AnalyzePicker({
  options,
  value,
}: {
  options: AnalyzeOption[];
  value: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(value);
  const byLabel = useMemo(
    () => new Map(options.map((o) => [o.label, o])),
    [options]
  );

  useEffect(() => setText(value), [value]);

  return (
    <Combobox
      value={text}
      onChange={setText}
      onPick={(label) => {
        const option = byLabel.get(label);
        if (option) router.push(option.href);
      }}
      options={options.map((o) => o.label)}
      placeholder="Choose an exercise or activity"
      ariaLabel="Exercise or activity"
      emptyLabel="No training item found"
      badgeFor={(label) => {
        const option = byLabel.get(label);
        if (!option) return null;
        return (
          <span className={BADGE_CLASS[option.kind]}>
            {KIND_LABEL[option.kind]}
          </span>
        );
      }}
    />
  );
}
