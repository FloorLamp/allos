import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getFrequencyTargetProgressForHome } from "@/lib/queries";
import { getProfileAge, getWeekMode } from "@/lib/settings";
import { isStrengthTrainingRelevant } from "@/lib/life-stage";
import {
  frequencyScopeLabel,
  isStrengthProgrammingScope,
} from "@/lib/frequency-targets";
import FrequencyTargets from "./FrequencyTargets";
import RoutinesSection from "./RoutinesSection";
import GoalsSection from "./GoalsSection";

// The Plan tab (#2892): Routines and Goals folded into one planning surface.
// Order is the planning story — the Weekly targets card first (#3474 renamed it
// from "Weekly routine": the section below is "Routines", a different model, and one
// word for two things on one screen is what the rename closes; this card is
// their ONE editing home; the chips that render on Overview and the Log strip
// link here), then structured routines, then outcome goals, then the equipment
// registry's door. The retired `?tab=routines` / `?tab=goals` names resolve to
// this tab at the parser (lib/training-tabs.ts), so every historic deep link —
// including Telegram messages that can never be rewritten — lands on the
// section it always meant, via the #routines / #goals anchors.
export default async function PlanSection() {
  const { profile } = await requireSession();
  const strengthTrainingAvailable = isStrengthTrainingRelevant(
    getProfileAge(profile.id)
  );
  // The SAME scoped read Overview renders (#2888): the editing home and the rendering
  // home must show one set. This card used to subtract `practice` and keep everything
  // else, which is how food habits got an edit control here that could not save them —
  // the Scope select below has no food option, so the submitted scope_kind was blank
  // and the action returned without writing. Membership is declared per scope in
  // CADENCE_SCOPES.home now, so no surface carries its own list.
  const targets = getFrequencyTargetProgressForHome(
    profile.id,
    "training"
  ).filter(
    ({ target }) =>
      strengthTrainingAvailable || !isStrengthProgrammingScope(target)
  );
  const weekMode = getWeekMode(profile.id);

  return (
    <div className="space-y-6">
      <section
        id="targets"
        className="card scroll-mt-[calc(5rem+env(safe-area-inset-top))]"
      >
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Weekly targets
        </h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          “Hit X at least N times per week.” Counts distinct training days{" "}
          {weekMode === "rolling"
            ? "over the last 7 days"
            : "in the current week"}
          . Click a target to edit it.
        </p>
        <FrequencyTargets
          strengthTrainingAvailable={strengthTrainingAvailable}
          items={targets.map((t) => ({
            id: t.target.id,
            scopeKind: t.target.scope_kind,
            scopeValue: t.target.scope_value,
            label: frequencyScopeLabel(
              t.target.scope_kind,
              t.target.scope_value
            ),
            count: t.count,
            perWeek: t.per_week,
            met: t.met,
            pace: t.pace,
          }))}
        />
      </section>

      {/* RoutinesManager's own root carries id="routines" + the scroll margin —
          no wrapper anchor here, or the page would emit a duplicate id. */}
      {strengthTrainingAvailable && <RoutinesSection />}

      <GoalsSection />

      {/* The equipment registry's door on every screen size (#2892) — the
          training header's Equipment link is desktop-only, so this card is the
          phone's way in. */}
      <section className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold text-slate-800 dark:text-slate-100">
              Equipment
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {strengthTrainingAvailable
                ? "Bikes, bars, and machines — the registry keeps usage history and per-gear defaults."
                : "Bikes, shoes, and recovery gear — the registry keeps usage history and per-gear defaults."}
            </p>
          </div>
          <Link
            href="/equipment"
            data-testid="plan-equipment-link"
            className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Open registry →
          </Link>
        </div>
      </section>
    </div>
  );
}
