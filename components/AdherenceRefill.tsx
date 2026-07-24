import Link from "next/link";
import { IconFlame } from "@tabler/icons-react";
import {
  adherenceSummary,
  type AdherenceDot,
} from "@/lib/supplement-adherence";
import {
  daysOfSupplyForItem,
  isLowSupply,
  refillBasisLabel,
  runOutDateStr,
  type DoseRate,
} from "@/lib/refill";
import { SUPPLIES_HREF } from "@/lib/hrefs";
import { formatMonthDay } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

// The refill "≈N days of supply left" badge (#38/#301), shared by the supplement
// ROW and the medication CARD so both surface the same estimate identically
// (#747 med-card parity). daysOfSupplyForItem is the ONE computation the dashboard
// Low-supply widget also formats over (#301); this is a pure formatter over its
// result. Only shown when the item opts into quantity tracking (quantity_on_hand
// set) — daysOfSupplyForItem returns null otherwise, and this renders nothing.
export function RefillBadge({
  quantityOnHand,
  qtyPerDose,
  refillRate,
  doseCount,
  todayStr,
}: {
  quantityOnHand: number | null;
  qtyPerDose: number;
  refillRate: DoseRate | null;
  doseCount: number;
  // When provided (#852 item 3), the badge also shows the projected run-out DATE
  // ("runs out ~Aug 3") — a date is what you tell the pharmacy. Omitted on surfaces
  // (supplement rows) that keep the compact days-left form.
  todayStr?: string;
}) {
  const formatPrefs = useFormatPrefs();
  const daysLeft = daysOfSupplyForItem(
    quantityOnHand,
    qtyPerDose,
    refillRate,
    doseCount
  );
  if (daysLeft === null) return null;
  const lowSupply = isLowSupply(daysLeft);
  const refillBasis = refillBasisLabel(refillRate?.basis ?? "schedule");
  const runOut = todayStr ? runOutDateStr(todayStr, daysLeft) : null;
  return (
    <span
      data-testid="refill-days-left"
      className={`badge whitespace-nowrap ${
        lowSupply
          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          : "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
      }`}
      title={
        runOut
          ? `Runs out around ${formatMonthDay(runOut, formatPrefs)} — ${refillBasis}`
          : `Estimated days of supply remaining — ${refillBasis}`
      }
    >
      {lowSupply ? "Low · " : ""}≈{daysLeft} day{daysLeft === 1 ? "" : "s"} left
      {/* The projected run-out DATE alongside the days-left duration (#852 item 3) —
          a date is what you tell the pharmacy. Shown only where todayStr is threaded
          (the medication row + card); the supplement row keeps the compact form. */}
      {runOut && (
        <span className="hidden sm:inline" data-testid="refill-run-out">
          {" "}
          · runs out ~{formatMonthDay(runOut, formatPrefs)}
        </span>
      )}
      <span className="ml-1 hidden font-normal opacity-70 sm:inline">
        · {refillBasis}
      </span>
    </span>
  );
}

// The shared-bottle chip (#1374). REPLACES the per-item RefillBadge when the item
// draws from a pool — a linked item has no private count, and the honest number is the
// POOLED one ("≈9 days across everyone"), because this member's doses are only part of
// the drain. Shared by the supplement row and the medication row/card so all three read
// the same computation. Renders nothing when the item isn't pooled.
export function SharedSupplyChip({
  pool,
}: {
  pool: {
    supplyId: number;
    name: string;
    daysLeft: number | null;
    memberCount: number;
    low: boolean;
  } | null;
}) {
  if (!pool) return null;
  const across = pool.memberCount > 1 ? " across everyone" : "";
  const days =
    pool.daysLeft == null
      ? "shared bottle"
      : pool.daysLeft <= 0
        ? `out of supply${across}`
        : `≈${pool.daysLeft} day${pool.daysLeft === 1 ? "" : "s"}${across}`;
  return (
    <Link
      href={SUPPLIES_HREF}
      data-testid="shared-supply-chip"
      className={`badge whitespace-nowrap ${
        pool.low
          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          : "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
      }`}
      title={`Shared supply — ${pool.name}, drawn from by ${pool.memberCount} tracked item${
        pool.memberCount === 1 ? "" : "s"
      }`}
    >
      {pool.low ? "Low · " : ""}Shared · {days}
    </Link>
  );
}

// Recent-adherence summary line — a streak + percentage + skipped count over the
// last 14 days (#313), shared by the supplement ROW and the medication CARD
// (#747 parity). adherenceSummary is the shared computation; this is a pure
// formatter. Renders nothing when there's nothing to report (no due day counted
// and no deliberate skip).
export function AdherenceSummaryLine({ strip }: { strip: AdherenceDot[] }) {
  const adherence = adherenceSummary(strip);
  if (!(adherence.pct !== null || adherence.skippedDays > 0)) return null;
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 text-xs"
      title="Adherence over the last 14 days"
    >
      {adherence.streak >= 2 && (
        <>
          <span className="flex items-center gap-1 font-medium text-slate-600 dark:text-slate-300">
            <IconFlame
              className="h-3.5 w-3.5 text-brand-500 dark:text-brand-400"
              aria-hidden="true"
            />
            {adherence.streak}-day streak
          </span>
          <span
            aria-hidden="true"
            className="text-slate-300 dark:text-slate-600"
          >
            ·
          </span>
        </>
      )}
      {adherence.pct !== null && (
        <span className="text-slate-500 dark:text-slate-400">
          {Number.isInteger(adherence.takenDays + adherence.partialDays * 0.5)
            ? adherence.takenDays + adherence.partialDays * 0.5
            : (adherence.takenDays + adherence.partialDays * 0.5).toFixed(1)}
          /{adherence.applicableDays} due days followed · {adherence.pct}%
        </span>
      )}
      {adherence.skippedDays > 0 && (
        <>
          {adherence.pct !== null && (
            <span
              aria-hidden="true"
              className="text-slate-300 dark:text-slate-600"
            >
              ·
            </span>
          )}
          <span className="text-amber-600 dark:text-amber-400">
            {adherence.skippedDays} skipped
          </span>
        </>
      )}
    </div>
  );
}
