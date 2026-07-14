"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconPlus, IconMinus, IconChevronDown } from "@tabler/icons-react";
import type { FoodGroup, FoodGroupTier } from "@/lib/food-groups";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import { logFoodServing, undoFoodServing } from "./actions";

// One-tap food-group serving logger (issue #579), modeled on the dose-confirm one-tap
// bar (components/DoseStatusControl): optimistic local counts, a Server Action per tap,
// undo = decrement. Groups are shown by tier (encourage → neutral → limit) so the foods
// to eat more of lead; WITHIN each tier the server ranks the profile's staples first
// (frequency + recency, issue #591) — the `groups` prop arrives pre-ordered.
//
// The row order is FROZEN for the life of this mount: the server re-ranks by
// recency-decayed frequency on every read, so the router.refresh() after a tap would
// otherwise reorder the list under the user's finger — jarring right where they just
// tapped. Tapping a row's label expands the (normally truncated) serving detail so it's
// readable on a narrow phone without leaving the page.

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
  // Slugs whose serving detail is expanded (tap-to-read on mobile). Purely local.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [, startTransition] = useTransition();
  const router = useRouter();

  // Capture the initial slug order once, then re-sort every subsequent `groups`
  // (same catalog, re-ranked by the server after a log) back into it. This holds
  // the list steady across router.refresh() so a serving never makes its row jump;
  // the order only changes when the component remounts — i.e. the user navigates
  // away and back, exactly the "fixed until you leave" behavior we want.
  const frozenOrder = useRef<string[] | null>(null);
  if (frozenOrder.current === null) {
    frozenOrder.current = groups.map((g) => g.slug);
  }
  const orderedGroups = useMemo(() => {
    const idx = new Map(frozenOrder.current!.map((s, i) => [s, i]));
    // Stable sort by the frozen index; any slug not seen at mount (shouldn't
    // happen — the catalog is fixed) sorts last in its incoming order.
    return groups
      .map((g, i) => ({ g, i }))
      .sort((a, b) => {
        const ai = idx.get(a.g.slug) ?? Number.MAX_SAFE_INTEGER;
        const bi = idx.get(b.g.slug) ?? Number.MAX_SAFE_INTEGER;
        return ai - bi || a.i - b.i;
      })
      .map((x) => x.g);
  }, [groups]);

  async function bump(slug: string, delta: 1 | -1) {
    setCounts((c) => ({ ...c, [slug]: Math.max(0, (c[slug] ?? 0) + delta) }));
    const fd = new FormData();
    fd.set("group_key", slug);
    fd.set("date", date);
    if (delta === 1) await logFoodServing(fd);
    else await undoFoodServing(fd);
    startTransition(() => router.refresh());
  }

  function toggleDetail(slug: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  // Live total of servings logged today, summed from the same optimistic count
  // state the rows use so the header ticks up on the same tap (no refresh lag).
  const dayTotal = useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + n, 0),
    [counts]
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Log today
        </h2>
        <span
          data-testid="food-day-total"
          className="shrink-0 text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
        >
          {dayTotal} {dayTotal === 1 ? "serving" : "servings"} today
        </span>
      </div>
      <div data-testid="food-log-bar" className="space-y-5">
        {TIER_ORDER.map((tier) => {
          const tierGroups = orderedGroups.filter((g) => g.tier === tier);
          if (tierGroups.length === 0) return null;
          return (
            <div key={tier}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {TIER_LABEL[tier]}
              </h3>
              <ul className="space-y-1.5">
                {tierGroups.map((g) => {
                  const count = counts[g.slug] ?? 0;
                  const isExpanded = expanded.has(g.slug);
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
                      {/* Tapping the label toggles the full serving detail — the
                        description is truncated to one line by default so the row
                        fits a phone, and expands in place on tap so it's readable
                        without navigating away. */}
                      <button
                        type="button"
                        data-testid={`detail-${g.slug}`}
                        onClick={() => toggleDetail(g.slug)}
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? "Hide" : "Show"} serving detail for ${g.name}`}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-slate-800 dark:text-slate-100">
                            {g.name}
                          </span>
                          <span
                            className={`block text-xs text-slate-500 dark:text-slate-400 ${
                              isExpanded ? "" : "truncate"
                            }`}
                          >
                            {g.serving}
                          </span>
                        </span>
                        <IconChevronDown
                          className={`h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform dark:text-slate-600 ${
                            isExpanded ? "rotate-180" : ""
                          }`}
                          stroke={2}
                        />
                      </button>
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
    </div>
  );
}
