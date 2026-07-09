import Link from "next/link";
import { IconCaretUpFilled, IconCaretDownFilled } from "@tabler/icons-react";
import ActivityIcon from "@/components/ActivityIcon";
import { isNonOptimal } from "@/lib/reference-range";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
          {title}
        </h1>
        {subtitle && (
          <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {subtitle}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const inner = (
    <div className="card transition hover:shadow-md">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          {sub}
        </div>
      )}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-black/10 bg-white p-10 text-center text-sm text-slate-400 dark:border-white/10 dark:bg-ink-900 dark:text-slate-500">
      {message}
    </div>
  );
}

const typeColors: Record<string, string> = {
  strength:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  cardio: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  sport: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  active: "bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300",
  achieved: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  archived: "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400",
  vitals: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  lab: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  genomics:
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  biomarker: "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
  scan: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  prescription:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

export function Tag({ value }: { value: string }) {
  return (
    <span
      className={`badge ${typeColors[value] ?? "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"}`}
    >
      {value}
    </span>
  );
}

// A medical result's value + unit, colored and arrowed by its reference-range
// flag. Shared by the medical history table and the per-document subpage so
// out-of-range styling stays consistent in one place.
function medicalValueClass(flag: string | null): string {
  // Out of range, either direction (high/low/abnormal) → red.
  if (flag === "high" || flag === "low" || flag === "abnormal")
    return "font-semibold text-rose-600 dark:text-rose-400";
  // Outside the optimal band, either direction → amber.
  if (isNonOptimal(flag))
    return "font-semibold text-amber-600 dark:text-amber-400";
  return "";
}

export function MedicalValue({
  value,
  unit,
  flag,
}: {
  value: string | null;
  unit: string | null;
  flag: string | null;
}) {
  // Arrow direction: clinical high / above-optimal point up; low / below-optimal
  // point down. Legacy directionless "non-optimal" gets no arrow (re-derives to a
  // directional flag on the next reconcile).
  const up = flag === "high" || flag === "non-optimal-high";
  const down = flag === "low" || flag === "non-optimal-low";
  return (
    <span className={medicalValueClass(flag)}>
      {value ?? "—"} {unit ?? ""}
      {up ? (
        <IconCaretUpFilled className="ml-0.5 inline-block h-[0.85em] w-[0.85em] align-[-0.1em]" />
      ) : down ? (
        <IconCaretDownFilled className="ml-0.5 inline-block h-[0.85em] w-[0.85em] align-[-0.1em]" />
      ) : null}
    </span>
  );
}

export function ActivityTypeIcon({
  type,
  title,
}: {
  type: string;
  title?: string;
}) {
  // Bare icon, matching the activity modal heading — no circle, no per-type color.
  return (
    <span
      title={title || type}
      aria-label={type}
      className="shrink-0 text-brand-600 dark:text-brand-400"
    >
      <ActivityIcon type={type} title={title} className="h-6 w-6" />
    </span>
  );
}

const INTENSITY_BADGE: Record<string, string> = {
  easy: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  moderate: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  hard: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

export function IntensityBadge({ value }: { value: string }) {
  return (
    <span
      className={`badge capitalize ${
        INTENSITY_BADGE[value] ??
        "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
      }`}
    >
      {value}
    </span>
  );
}
