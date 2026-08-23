"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import Combobox from "@/components/Combobox";
import type { AnalyzeOption } from "@/lib/analyze-view";
import { useResettableState } from "@/components/useResettableState";
import type { AppRoute } from "@/lib/hrefs";

export type { AnalyzeOption };

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

// Combobox options are identities, not their visible text. An activity may quite
// legitimately be named "All training"; reserving that LABEL made choosing the
// activity route to the aggregate view instead. Keep the aggregate and every
// entity in separate keyed namespaces, then render their human labels with
// Combobox.labelFor.
const ALL_TRAINING_OPTION_ID = "summary:all-training";

export default function AnalyzePicker({
  options,
  value,
  allTrainingHref,
  appearance = "field",
}: {
  options: AnalyzeOption[];
  value: string;
  allTrainingHref: AppRoute;
  appearance?: "field" | "title";
}) {
  const router = useRouter();
  const [text, setText] = useResettableState(value, value);

  const rankedOptions = useMemo(
    () =>
      [...options].sort(
        (a, b) =>
          b.lastDate.localeCompare(a.lastDate) ||
          b.sessions - a.sessions ||
          a.label.localeCompare(b.label)
      ),
    [options]
  );
  const pickerOptions = useMemo(
    () => [
      {
        id: ALL_TRAINING_OPTION_ID,
        label: "All training",
        option: null,
      },
      ...rankedOptions.map((option, index) => ({
        id: `entity:${index}`,
        label: option.label,
        option,
      })),
    ],
    [rankedOptions]
  );
  const byId = useMemo(
    () => new Map(pickerOptions.map((option) => [option.id, option])),
    [pickerOptions]
  );

  return (
    <Combobox
      value={text}
      onChange={setText}
      onPick={(id) => {
        const picked = byId.get(id);
        if (!picked) return;
        // Combobox first writes the selected identity through onChange. Restore
        // the human label in the controlled field in the same event.
        setText(picked.label);
        if (!picked.option) {
          router.push(allTrainingHref);
          return;
        }
        router.push(picked.option.href);
      }}
      options={pickerOptions.map((option) => option.id)}
      labelFor={(id) => byId.get(id)?.label ?? id}
      searchTermsFor={(id) => {
        const picked = byId.get(id);
        return picked
          ? [picked.label, picked.option?.item ?? "", picked.option?.kind ?? ""]
          : [];
      }}
      placeholder="Choose an exercise or activity"
      ariaLabel="Exercise or activity"
      emptyLabel="No training item found"
      appearance={appearance}
      badgeFor={(id) => {
        const option = byId.get(id)?.option;
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
