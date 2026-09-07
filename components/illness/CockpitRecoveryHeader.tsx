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
// sentence about the person, the Illness · Day-N tag, ONE prose line folding the same
// three facts, and "Feeling better" — the action the state ripens toward — beside the
// countdown instead of at the card's bottom edge.
//
// THE NAME AND THE DAY TAG ALSO APPEAR ON THE ROW ABOVE, AND STAY (owner, 2026-09-06).
// The accordion row this body expands from renders the avatar, the name, the situation
// and "Day N" about 100px up, so the header restates both. A pass removed them as
// duplicates and was REVERTED: #4752 §1 approved a header that carries them, and that
// board is the specification. If the duplication is resolved it is resolved on the row,
// not by deleting what the blessed header was asked to say.
//
// Every string comes from `lib/illness-episode-format.ts`, over the SAME
// `EpisodeCollapsedStatus` the collapsed accordion line renders, so an expanded
// cockpit and its own one-line summary cannot disagree about the last dose.
export default function CockpitRecoveryHeader({
  name,
  status,
  recovery,
  action,
  temperatureIdentity,
  medicationIdentity,
}: {
  name: string;
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3
            data-testid="cockpit-headline"
            className="min-w-0 truncate text-base font-semibold text-slate-900 sm:text-lg dark:text-slate-50"
          >
            {cockpitRecoveryHeadline(name, recovery)}
          </h3>
          <span
            data-testid="cockpit-day-tag"
            className="badge bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
          >
            {status.dayLabel}
          </span>
          {status.worsening ? (
            <span className="text-xs font-medium text-rose-600 dark:text-rose-400">
              Worsening ↑
            </span>
          ) : null}
        </div>
        <p
          data-testid="cockpit-summary-line"
          // The minute-ages inside come from a render-time clock, exactly as the stat
          // grid's did — server and first client render can straddle a minute.
          suppressHydrationWarning
          className="mt-1 text-xs text-slate-600 dark:text-slate-300"
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
