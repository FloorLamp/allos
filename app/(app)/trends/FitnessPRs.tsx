import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getCardioByActivity,
  getStrengthByExercise,
  type CardioStat,
} from "@/lib/queries";
import { getDisplayFormatPrefs, getUnitPrefs } from "@/lib/settings";
import {
  recentCardioPRs,
  recentPRs,
  type CardioPR,
  type PR,
} from "@/lib/coaching";
import { formatMinutes } from "@/lib/duration";
import { formatRelativeDate } from "@/lib/format-date";
import { fmtDistance, fmtKmh, fmtWeight } from "@/lib/units";
import type { DistanceUnit, WeightUnit } from "@/lib/settings";
import {
  selectWindowPRs,
  windowPrDays,
  WINDOW_PR_LIMIT,
  type FitnessWindow,
  type WindowPR,
} from "@/lib/trends-fitness";
import PrCard from "@/components/PrCard";

const CARDIO_KIND_LABEL: Record<CardioPR["kind"], string> = {
  distance: "longest",
  speed: "fastest",
  duration: "longest time",
};

function strengthValue(p: PR, wu: WeightUnit): string {
  if (p.kind === "weight") return `${fmtWeight(p.weightKg, wu)} top`;
  return p.bodyweight
    ? `BW × ${p.reps}`
    : `${fmtWeight(p.weightKg, wu)} × ${p.reps}`;
}

function cardioValue(p: CardioPR, du: DistanceUnit): string {
  if (p.kind === "distance") return fmtDistance(p.distanceKm, du);
  if (p.kind === "speed") return fmtKmh(p.speedKmh, du);
  return formatMinutes(p.durationMin);
}

// Trends → Fitness → "PRs this window" (#1492).
//
// The compact replacement for the 14-row Recent-PRs + Recent-cardio-PRs pair the
// tab used to stack above every chart: the top three records SET inside the shared
// window, across both disciplines, with the full list one link away on /training —
// the movers treatment (#1485/#1490).
//
// Same PR ENGINES as everywhere else, windowed (#221): `recentPRs` /
// `recentCardioPRs` already answer "records set within N days of a day", so the
// window is expressed as (end = the window's last day, withinDays = its length).
// The stats they read stay LIFETIME stats on purpose — a record is a record
// against your whole history; the window decides only WHEN it was set. Ranking and
// the top-3 cut are the pure `selectWindowPRs`.
export default async function FitnessPRs({
  window,
}: {
  window: FitnessWindow;
}) {
  const { login, profile } = await requireSession();
  const todayStr = today(profile.id);
  const units = getUnitPrefs(login.id);
  const wu = units.weightUnit;
  const du = units.distanceUnit;
  const days = windowPrDays(window);
  const cardio: CardioStat[] = getCardioByActivity(
    profile.id,
    du,
    getDisplayFormatPrefs(login.id)
  );
  const { items, total } = selectWindowPRs(
    recentPRs(getStrengthByExercise(profile.id), window.to, days),
    recentCardioPRs(cardio, window.to, days),
    WINDOW_PR_LIMIT
  );

  if (items.length === 0) return null;

  const row = (item: WindowPR) =>
    item.source === "strength"
      ? {
          name: item.pr.exercise,
          value: strengthValue(item.pr, wu),
          meta: formatRelativeDate(item.date, todayStr),
        }
      : {
          name: item.pr.activity,
          value: cardioValue(item.pr, du),
          meta: `${CARDIO_KIND_LABEL[item.pr.kind]} · ${formatRelativeDate(
            item.date,
            todayStr
          )}`,
        };

  return (
    <PrCard
      testId="fitness-window-prs"
      title="🏆 PRs this window"
      items={items.map(row)}
      action={
        <Link
          href="/training?tab=analyze"
          data-testid="fitness-prs-show-all"
          className="shrink-0 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          {total > items.length ? `Show all ${total} →` : "Show all →"}
        </Link>
      }
    />
  );
}
