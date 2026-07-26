import { requireSession } from "@/lib/auth";
import { getSportByActivity } from "@/lib/queries";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { formatMinutes } from "@/lib/duration";
import { formatLongDate } from "@/lib/format-date";
import type { FitnessWindow } from "@/lib/trends-fitness";
import { EmptyState } from "@/components/ui";

// Trends → Fitness → **Sport** (#1492): what the window's duration-only work
// looked like, per sport.
//
// Sports carry no distance or load, so there is no trend line to draw — the honest
// windowed answer is a summary per sport (sessions, total time, longest session).
// Same computation as /training's, windowed: `getSportByActivity` grew
// `since`/`until` (#221). The full-history SportExplorer stays a "do" surface on
// /training.
export default async function FitnessSportSection({
  window,
}: {
  window: FitnessWindow;
}) {
  const { login, profile } = await requireSession();
  const prefs = getDisplayFormatPrefs(login.id);
  const sports = getSportByActivity(
    profile.id,
    prefs,
    10,
    window.from ?? undefined,
    window.to
  );

  return (
    <section id="sport" className="scroll-mt-28" data-testid="fitness-sport">
      <div className="card">
        <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
          Sport
        </h2>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Sessions and time per sport in this window.
        </p>
        {sports.length === 0 ? (
          <EmptyState
            message="No sport logged in this window. Widen the range, or log a match, pickup game, or climb."
            action={{ href: "/training?tab=log", label: "Go to Log" }}
          />
        ) : (
          <ul className="space-y-2" data-testid="fitness-sport-rows">
            {sports.map((s) => (
              <li
                key={s.sport}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 dark:bg-ink-900"
              >
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {s.sport}
                </span>
                <span className="text-sm tabular-nums text-slate-600 dark:text-slate-300">
                  {s.sessions} {s.sessions === 1 ? "session" : "sessions"} ·{" "}
                  {formatMinutes(s.totalDurationMin || null)}
                </span>
                <span className="w-full text-xs text-slate-500 dark:text-slate-400">
                  Longest {formatMinutes(s.longestDurationMin || null)} on{" "}
                  {formatLongDate(s.longestDurationDate, prefs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
