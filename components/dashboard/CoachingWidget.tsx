import Link from "next/link";
import type { CoachingTone, Recommendation } from "@/lib/coaching";
import { coachingDedupeKey } from "@/lib/findings";
import SubmitButton from "@/components/SubmitButton";
import { snoozeCoaching } from "@/app/(app)/actions";
import WidgetHeader from "./WidgetHeader";

// Small accent dot color per tone, so the card reads at a glance: caution (ease
// off) amber, action (go do it) brand, positive emerald, neutral slate.
const TONE_DOT: Record<CoachingTone, string> = {
  caution: "bg-amber-500",
  action: "bg-brand-500",
  positive: "bg-emerald-500",
  neutral: "bg-slate-400",
};

// Rule-based coaching card (issue: deterministic coaching engine). Shows the top
// recommendation (title + detail + optional action) and, when present, a subtle
// secondary. Distinct from the AI "Today's insight" widget — this is derived
// purely from the profile's routine + recovery signals, no model calls.
export default function CoachingWidget({ recs }: { recs: Recommendation[] }) {
  const [top, ...rest] = recs;
  const secondary = rest[0];

  return (
    <div className="card">
      <WidgetHeader title="Coaching" href="/training" linkLabel="Training" />
      <p className="-mt-2 mb-3 text-xs text-slate-500 dark:text-slate-400">
        Based on your routine &amp; recovery
      </p>
      {top ? (
        <div>
          <div className="flex items-start gap-2">
            <span
              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[top.tone]}`}
              aria-hidden
            />
            <div>
              <p className="font-semibold text-slate-900 dark:text-slate-100">
                {top.title}
              </p>
              <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                {top.detail}
              </p>
              {top.target && (
                <p className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Suggested set: {top.target}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 pl-[18px]">
            {top.actionHref && (
              <Link href={top.actionHref} className="btn-ghost">
                {top.actionLabel ?? "Open"}
              </Link>
            )}
            {/* Snooze the top recommendation until tomorrow (findings bus, #39),
                surfacing the next-ranked one for the rest of the day. */}
            <form action={snoozeCoaching}>
              <input
                type="hidden"
                name="dedupe_key"
                value={coachingDedupeKey(top.id)}
              />
              <SubmitButton
                pendingLabel="…"
                data-testid="coaching-not-today"
                className="btn-ghost text-slate-500 dark:text-slate-400"
              >
                Not today
              </SubmitButton>
            </form>
          </div>
          {secondary && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-ink-800 dark:text-slate-400">
              <span className="font-medium">Next:</span> {secondary.title} —{" "}
              {secondary.detail}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No suggestion right now — log an activity to get started.
        </p>
      )}
    </div>
  );
}
