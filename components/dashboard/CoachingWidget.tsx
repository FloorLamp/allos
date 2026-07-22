import Link from "next/link";
import type { CoachingTone, Recommendation } from "@/lib/coaching";
import { canAcknowledgeRest } from "@/lib/coaching";
import { coachingDedupeKey } from "@/lib/findings";
import SubmitButton from "@/components/SubmitButton";
import { snoozeCoaching, acknowledgeRest } from "@/app/(app)/actions";
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
      <WidgetHeader title="Coaching" href="/training" />
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
              {/* Concurrent under-recovery signals (#1148): every firing reason is
                  shown BEFORE a snooze can suppress them, so a dismissal is informed
                  and can't silently bury a signal the user never saw. */}
              {top.also?.length ? (
                <p
                  className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                  data-testid="coaching-also"
                >
                  <span className="font-medium">Also:</span>{" "}
                  {top.also.join("; ")}.
                </p>
              ) : null}
              {top.target && (
                <p className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  Suggested set: {top.target}
                </p>
              )}
              {/* Calm injury/condition context (#666/#838) riding alongside — the SAME
                  notes the Training overview renders (one computation, #221). */}
              {top.notes?.map((note, i) => (
                <p
                  key={i}
                  className="mt-1 text-xs text-amber-700 dark:text-amber-300"
                >
                  {note}
                </p>
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 pl-[18px]">
            {top.actionHref && (
              <Link href={top.actionHref} className="btn-ghost">
                {top.actionLabel ?? "Open"}
              </Link>
            )}
            {/* "Training anyway" (#1150): a declaration of intent on a LIVE rest card
                — records a per-day acknowledgment (NOT a dismissal) and transforms this
                card into calm recovery-aware training guidance instead of hiding it. Only
                on an un-acknowledged rest rec; train/cardio cards show only Snooze. */}
            {canAcknowledgeRest(top) && (
              <form action={acknowledgeRest}>
                <input
                  type="hidden"
                  name="reason_ids"
                  value={(top.firingReasonIds ?? []).join(",")}
                />
                <SubmitButton
                  pendingLabel="…"
                  data-testid="coaching-training-anyway"
                  className="btn-ghost text-slate-500 dark:text-slate-400"
                >
                  Training anyway
                </SubmitButton>
              </form>
            )}
            {/* Snooze the top recommendation until tomorrow (findings bus, #39;
                renamed from "Not today" in #1150). Applies to ALL coaching rec types. */}
            <form action={snoozeCoaching}>
              <input
                type="hidden"
                name="dedupe_key"
                value={coachingDedupeKey(top.id)}
              />
              <SubmitButton
                pendingLabel="…"
                data-testid="coaching-snooze"
                className="btn-ghost text-slate-500 dark:text-slate-400"
              >
                Snooze
              </SubmitButton>
            </form>
          </div>
          {secondary && (
            <p className="mt-3 border-t border-black/5 pt-3 text-xs text-slate-500 dark:border-white/5 dark:text-slate-400">
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
