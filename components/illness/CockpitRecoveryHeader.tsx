import type { ReactNode } from "react";
import {
  cockpitRecoveryFraction,
  cockpitRecoveryHeadline,
  cockpitSummaryParts,
  type CockpitRecovery,
  type EpisodeCollapsedStatus,
} from "@/lib/illness-episode-format";

/** A dashboard candidate's on-element identity (#531/#3138). */
export interface CockpitFactIdentity {
  candidateId: string;
  factKey: string;
  groupKey: string;
}

// THE HEADER IS THE STATUS (#4752 item 1). The cockpit used to open with three stat
// headings — Last temperature, Last Meds, Fever status — spread across a monitor,
// while the fact a caregiver came for (how far into the fever-free clock this child
// is) sat at footnote weight on the right-hand end. It leads now: the ring, the
// recovery statement, ONE prose line folding the same three facts, and "Feeling
// better" — the action the state ripens toward — beside the countdown instead of at
// the card's bottom edge.
//
// IT NAMES NOBODY AND DATES NOTHING (#3238, applied one layer in). The accordion row
// this body expands from is always directly above it and already renders the avatar,
// the person's name, the situation and "Day N" — and it suppresses its OWN temperature
// and last-dose clauses while expanded for exactly this reason. The header did not get
// the same treatment, so an expanded cockpit opened "Dune / Illness ⌄ / Day 1" and then,
// two lines down, "Dune" beside a rose "Illness · Day 1" badge: the person named twice
// and the day stated twice, in one card, within about 100px. Both are gone; what is
// left is what the row above does not say.
//
// Every string comes from `lib/illness-episode-format.ts`, over the SAME
// `EpisodeCollapsedStatus` the collapsed accordion line renders, so an expanded
// cockpit and its own one-line summary cannot disagree about the last dose.
export default function CockpitRecoveryHeader({
  status,
  recovery,
  action,
  temperatureIdentity,
  medicationIdentity,
}: {
  status: EpisodeCollapsedStatus;
  recovery: CockpitRecovery | null;
  /** "Feeling better", when the viewer may end this episode. */
  action?: ReactNode;
  // THE TWO CLAUSES THAT ARE ALSO CANDIDATES (#3138). The last temperature and the
  // last dose place in Now inside this episode's group, and the canvas exempts them
  // from its row check precisely because the cockpit draws them — so their identity
  // rides on the clause here, exactly as it rode on the stat grid this replaced.
  temperatureIdentity?: CockpitFactIdentity | null;
  medicationIdentity?: CockpitFactIdentity | null;
}) {
  const fraction = cockpitRecoveryFraction(recovery);
  const headline = cockpitRecoveryHeadline(recovery);
  // The top line of the header can be empty — no clock to state, nothing worsening —
  // and an empty flex row still costs its `gap-y-1` above the summary. Render it only
  // when it has something in it.
  const hasTopLine = headline != null || status.worsening;
  const identityFor = (key: string) =>
    key === "temperature"
      ? status.temperature
        ? temperatureIdentity
        : null
      : key === "medication"
        ? status.lastMeds
          ? medicationIdentity
          : null
        : null;
  return (
    <header
      data-testid="cockpit-recovery-header"
      className="flex flex-wrap items-center gap-x-4 gap-y-3"
    >
      {fraction != null && recovery?.clearedForHours != null ? (
        <RecoveryRing
          fraction={fraction}
          hours={recovery.clearedForHours}
          met={recovery.met}
          label={recovery.label}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        {hasTopLine ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {headline != null ? (
              <h3
                data-testid="cockpit-headline"
                className="min-w-0 truncate text-base font-semibold text-slate-900 sm:text-lg dark:text-slate-50"
              >
                {headline}
              </h3>
            ) : null}
            {status.worsening ? (
              <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
                Worsening ↑
              </span>
            ) : null}
          </div>
        ) : null}
        <p
          data-testid="cockpit-summary-line"
          // The minute-ages inside come from a render-time clock, exactly as the stat
          // grid's did — server and first client render can straddle a minute.
          suppressHydrationWarning
          className={
            hasTopLine
              ? "mt-1 text-xs text-slate-600 dark:text-slate-300"
              : "text-xs text-slate-600 dark:text-slate-300"
          }
        >
          {cockpitSummaryParts(status, recovery).map((part, index) => {
            const identity = identityFor(part.key);
            return (
              <span key={part.key}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                <span
                  data-testid={`cockpit-summary-${part.key}`}
                  data-candidate-id={identity?.candidateId}
                  data-fact-key={identity?.factKey}
                  data-group-key={identity?.groupKey}
                >
                  {part.text}
                </span>
              </span>
            );
          })}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

// The countdown as a ring: a stroked circle whose dash offset is the cleared
// fraction, with the hours inside it. `aria-hidden` on the drawing and the shared
// compact clause as the accessible text, so a screen reader hears the sentence the
// summary line also carries rather than a number with no unit.
function RecoveryRing({
  fraction,
  hours,
  met,
  label,
}: {
  fraction: number;
  hours: number;
  met: boolean;
  label: string;
}) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const tone = met ? "text-emerald-500" : "text-rose-500";
  return (
    <div
      data-testid="cockpit-recovery-ring"
      data-fraction={fraction.toFixed(2)}
      className="relative h-12 w-12 shrink-0 sm:h-14 sm:w-14"
    >
      <svg viewBox="0 0 52 52" className="h-full w-full -rotate-90">
        <circle
          cx="26"
          cy="26"
          r={radius}
          fill="none"
          strokeWidth="5"
          className="stroke-black/10 dark:stroke-white/15"
        />
        <circle
          cx="26"
          cy="26"
          r={radius}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className={`stroke-current ${tone}`}
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200"
      >
        {hours}h
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}
