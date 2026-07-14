"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconPlus, IconMinus } from "@tabler/icons-react";
import type { FoodGroup, FoodGroupTier } from "@/lib/food-groups";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import { logFoodServing, undoFoodServing } from "./actions";

// One-tap food-group serving logger (issue #579), modeled on the dose-confirm one-tap
// bar (components/DoseStatusControl): optimistic local counts, a Server Action per tap,
// undo = decrement. Groups are shown by tier (encourage → neutral → limit) so the foods
// to eat more of lead; WITHIN each tier the server ranks the profile's staples first
// (frequency + recency, issue #591) — the `groups` prop arrives pre-ordered.

const TIER_ORDER: FoodGroupTier[] = ["encourage", "neutral", "limit"];
const TIER_LABEL: Record<FoodGroupTier, string> = {
  encourage: "Eat more",
  neutral: "Balance",
  limit: "Eat less",
};

export default function FoodLogBar({
  date,
  initial,
  groups,
}: {
  // The day being logged (YYYY-MM-DD, the acting profile's today).
  date: string;
  // slug → servings logged so far today.
  initial: Record<string, number>;
  // The full food-group catalog, pre-ordered by the server so a profile's staples
  // lead within each tier (frequency/recency, #591). Sectioned by tier here, which
  // preserves the incoming order within each tier.
  groups: FoodGroup[];
}) {
  const [counts, setCounts] = useState<Record<string, number>>(initial);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function bump(slug: string, delta: 1 | -1) {
    setCounts((c) => ({ ...c, [slug]: Math.max(0, (c[slug] ?? 0) + delta) }));
    const fd = new FormData();
    fd.set("group_key", slug);
    fd.set("date", date);
    if (delta === 1) await logFoodServing(fd);
    else await undoFoodServing(fd);
    startTransition(() => router.refresh());
  }

  return (
    <div data-testid="food-log-bar" className="space-y-5">
      {TIER_ORDER.map((tier) => {
        const tierGroups = groups.filter((g) => g.tier === tier);
        if (tierGroups.length === 0) return null;
        return (
          <div key={tier}>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {TIER_LABEL[tier]}
            </h3>
            <ul className="space-y-1.5">
              {tierGroups.map((g) => {
                const count = counts[g.slug] ?? 0;
                return (
                  <li
                    key={g.slug}
                    data-testid={`food-group-${g.slug}`}
                    className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-ink-900"
                  >
                    <FoodGroupIcon
                      slug={g.slug}
                      className="h-5 w-5 shrink-0 text-slate-400 dark:text-slate-500"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-800 dark:text-slate-100">
                        {g.name}
                      </p>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {g.serving}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid={`undo-${g.slug}`}
                      aria-label={`Remove a ${g.name} serving`}
                      disabled={count <= 0}
                      onClick={() => bump(g.slug, -1)}
                      className="tap-target flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
                    >
                      <IconMinus className="h-4 w-4" stroke={2} />
                    </button>
                    <span
                      data-testid={`count-${g.slug}`}
                      className="w-5 text-center text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-200"
                    >
                      {count}
                    </span>
                    <button
                      type="button"
                      data-testid={`log-${g.slug}`}
                      aria-label={`Add a ${g.name} serving`}
                      onClick={() => bump(g.slug, 1)}
                      className="tap-target flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700"
                    >
                      <IconPlus className="h-4 w-4" stroke={2} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
