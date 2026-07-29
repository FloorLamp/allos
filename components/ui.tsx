import Link from "next/link";
import { IconCaretUpFilled, IconCaretDownFilled } from "@tabler/icons-react";
import ActivityIcon from "@/components/ActivityIcon";
import { flagLabel, flagTone } from "@/lib/reference-range";
import type { AppRoute } from "@/lib/hrefs";

export function PageHeader({
  title,
  subtitle,
  action,
  compactBelowSm = false,
  actionAlign = "end",
  className = "",
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  // Give up the whole heading band below `sm` (issue #1485 F, following the #1413
  // dashboard precedent): the title goes `sr-only` and the subtitle is dropped, so
  // the phone spends nothing on read-once copy while AT still hears the page's one
  // h1. For a surface whose own chrome already answers "where am I" — Trends' F
  // context bar names the tab AND the window on the line above the charts — and
  // where the subtitle is orientation prose nobody reads twice. Off by default:
  // most pages have nothing else naming them, and a heading-less page is a real
  // loss there. Desktop is byte-identical either way.
  compactBelowSm?: boolean;
  actionAlign?: "start" | "end";
  className?: string;
}) {
  // Compact below `md` (issue #1416, section A/D): a phone gives the heading a
  // smaller share of a much shorter screen, so the title drops to text-xl and
  // the gap to the content below halves. Desktop is unchanged. One tokenized
  // change here reaches all ~50 pages that render this — the reason the ad-hoc
  // <h1> pages were converted rather than restyled in place.
  return (
    <div
      className={`flex ${
        actionAlign === "start" ? "items-start" : "items-end"
      } justify-between gap-4 md:mb-6 ${
        compactBelowSm ? "sm:mb-4" : "mb-4"
      } ${className}`}
    >
      <div>
        <h1
          className={`text-xl font-bold text-slate-900 md:text-2xl dark:text-slate-100 ${
            compactBelowSm ? "sr-only sm:not-sr-only" : ""
          }`}
        >
          {title}
        </h1>
        {subtitle && (
          <div
            className={`mt-1 text-sm text-slate-500 dark:text-slate-400 ${
              compactBelowSm ? "hidden sm:block" : ""
            }`}
          >
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
  href?: AppRoute;
}) {
  const inner = (
    <div className="card transition hover:shadow-md">
      <div className="section-label">{label}</div>
      <div className="mt-2 text-3xl font-bold text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {sub}
        </div>
      )}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

// The dashed "nothing here yet" panel. `action` is an optional typed link
// (#812): when the copy names a destination ("Log an activity…", "…in Settings →
// Profile"), pass the link instead of leaving the user to navigate by hand — the
// href is `AppRoute`, so a dead pathname is a `tsc` error (#285).
//
// `actions` is the SAME affordance for a surface fed by several independent
// sources (#1410): the Timeline fills from activities, body metrics and imported
// documents, and naming only one of them would be arbitrary. Pass one or the
// other — `action` is the single-destination shorthand, and a caller supplying
// both simply gets the singular one appended last. Every href stays `AppRoute`.
export function EmptyState({
  message,
  action,
  actions,
}: {
  message: string;
  action?: { href: AppRoute; label: string };
  actions?: ReadonlyArray<{ href: AppRoute; label: string }>;
}) {
  const links = [...(actions ?? []), ...(action ? [action] : [])];
  return (
    <div className="rounded-xl border border-dashed border-black/10 bg-white p-10 text-center text-sm text-slate-500 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400">
      {message}
      {links.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="btn btn-sm">
              {link.label} →
            </Link>
          ))}
        </div>
      )}
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
  switch (flagTone(flag)) {
    // Out of range, either direction (high/low/abnormal) → red.
    case "bad":
      return "font-semibold text-rose-600 dark:text-rose-400";
    // Outside the optimal band, either direction → amber.
    case "warn":
      return "font-semibold text-amber-600 dark:text-amber-400";
    default:
      return "";
  }
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
  // directional flag on the next reconcile). The caret is decorative (aria-hidden):
  // the sr-only flagLabel beside it is the text equivalent (WCAG 1.4.1, issue
  // #1220) — the caret's direction is a shape, but the red-vs-amber SEVERITY
  // (High vs Above optimal) was color-only, and the old icon-level aria-label
  // ("above target") flattened both to one phrase.
  const up = flag === "high" || flag === "non-optimal-high";
  const down = flag === "low" || flag === "non-optimal-low";
  return (
    <span className={medicalValueClass(flag)}>
      {value ?? "—"} {unit ?? ""}
      {up || down ? (
        <>
          {up ? (
            <IconCaretUpFilled
              aria-hidden
              className="ml-0.5 inline-block h-[0.85em] w-[0.85em] align-[-0.1em]"
            />
          ) : (
            <IconCaretDownFilled
              aria-hidden
              className="ml-0.5 inline-block h-[0.85em] w-[0.85em] align-[-0.1em]"
            />
          )}
          <span className="sr-only" data-testid="medical-flag-text">
            {flagLabel(flag)}
          </span>
        </>
      ) : null}
    </span>
  );
}

export function ActivityTypeIcon({
  type,
  title,
  sportNames,
}: {
  type: string;
  title?: string;
  // Structured component/sport names (e.g. Strava's canonical "Cycling"),
  // matched before the free-text title so an imported ride icons as a bike.
  sportNames?: string[];
}) {
  // Bare icon, matching the activity modal heading — no circle, no per-type color.
  return (
    <span
      title={title || type}
      aria-label={type}
      className="shrink-0 text-brand-600 dark:text-brand-400"
    >
      <ActivityIcon
        type={type}
        title={title}
        sportNames={sportNames}
        className="h-6 w-6"
      />
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
