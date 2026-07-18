"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DIETARY_PRESETS,
  DIETARY_PRESET_LABELS,
  expandPreset,
  presetForExcluded,
  type DietaryPreset,
} from "@/lib/dietary-preferences";
import { saveDietaryPreferences } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";

// Dietary preferences card (issue #975) — the PROFILE-scoped excluded food-group set. A
// preset picker pre-fills the set; the open multi-select lets you tighten it or add
// individual dislikes; the preset label DERIVES from the set, so editing after picking a
// preset drops it to "custom". These are PREFERENCES: suggestions filter/substitute
// against them and the one-tap bar demotes them, but logging is never blocked and no
// computed intake ever changes. Saves on change, like the other profile cards.

interface GroupOption {
  slug: string;
  name: string;
  tier: "encourage" | "neutral" | "limit";
}

const TIER_ORDER: GroupOption["tier"][] = ["encourage", "neutral", "limit"];
const TIER_LABEL: Record<GroupOption["tier"], string> = {
  encourage: "Eat more",
  neutral: "Balance",
  limit: "Eat less",
};

export default function DietaryPreferencesForm({
  excluded,
  groups,
}: {
  // The profile's currently-excluded food-group slugs.
  excluded: string[];
  // The full catalog (slug + name + tier) for the multi-select.
  groups: GroupOption[];
}) {
  const router = useRouter();
  const [set, setSet] = useState<Set<string>>(new Set(excluded));
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  const currentPreset = presetForExcluded([...set]);

  function persist(next: Set<string>) {
    setSet(next);
    const fd = new FormData();
    for (const slug of next) fd.append("excluded", slug);
    runSave(async () => {
      await saveDietaryPreferences(fd);
      router.refresh();
    });
  }

  function pickPreset(preset: DietaryPreset) {
    persist(new Set(expandPreset(preset)));
  }

  function toggle(slug: string) {
    const next = new Set(set);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    persist(next);
  }

  return (
    <div
      className="card max-w-lg space-y-4"
      data-testid="dietary-preferences-form"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Dietary preferences
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <div>
        <label className="label" htmlFor="dietary-preset">
          Pattern
        </label>
        <select
          id="dietary-preset"
          data-testid="dietary-preset"
          className="input"
          value={currentPreset}
          onChange={(e) => {
            const v = e.target.value;
            if (v !== "custom") pickPreset(v as DietaryPreset);
          }}
        >
          {DIETARY_PRESETS.map((p) => (
            <option key={p} value={p}>
              {DIETARY_PRESET_LABELS[p]}
            </option>
          ))}
          {/* "Custom" is a derived state, never a pick — shown only when the set
              diverges from every preset. */}
          {currentPreset === "custom" && <option value="custom">Custom</option>}
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Pick a pattern to pre-fill the list, then tighten it below.
          Preferences reorder and substitute food suggestions — they never block
          logging what you actually ate, and they never change a computed
          intake.
        </p>
      </div>

      <fieldset className="space-y-3">
        <legend className="label mb-1">Never suggest</legend>
        {TIER_ORDER.map((tier) => {
          const inTier = groups.filter((g) => g.tier === tier);
          if (inTier.length === 0) return null;
          return (
            <div key={tier}>
              <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                {TIER_LABEL[tier]}
              </p>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {inTier.map((g) => (
                  <label
                    key={g.slug}
                    className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                  >
                    <input
                      type="checkbox"
                      data-testid={`dietary-exclude-${g.slug}`}
                      checked={set.has(g.slug)}
                      onChange={() => toggle(g.slug)}
                      className="h-4 w-4 rounded border-black/20 dark:border-white/20"
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}
