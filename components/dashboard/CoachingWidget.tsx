import Link from "next/link";
import type { CoachingTone, Recommendation } from "@/lib/coaching";
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
      <p className="-mt-2 mb-3 text-xs text-slate-400 dark:text-slate-500">
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
          {top.actionHref && (
            <div className="mt-3 pl-[18px]">
              <Link href={top.actionHref} className="btn-ghost">
                {top.actionLabel ?? "Open"}
              </Link>
            </div>
          )}
          {secondary && (
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-400 dark:border-ink-800 dark:text-slate-500">
              <span className="font-medium">Next:</span> {secondary.title} —{" "}
              {secondary.detail}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No suggestion right now — log an activity to get started.
        </p>
      )}
    </div>
  );
}
