"use client";

import { useState } from "react";
import Link from "next/link";
import Button from "@/components/Button";
import InlineError from "@/components/InlineError";
import type { AppRoute } from "@/lib/hrefs";
import {
  linkEventActivity,
  setEndurancePlanStatus,
  unlinkEventActivity,
} from "../../endurance-actions";

// One activity as the event page lists it, formatted server-side (distances in the
// login's unit, the time as H:MM:SS) so this component owns only the two links.
export interface EventActivityView {
  id: number;
  href: AppRoute;
  title: string;
  // "10.2 km · 42:10 · race" — whatever the row has, joined.
  meta: string;
  linked: boolean;
  // Already another event's result, same day. Linking it here MOVES it, because a
  // session is the result of at most one event — so the row says so and the button
  // says "Move here" rather than offering it as if it were free.
  linkedElsewhere: boolean;
}

// The event page's two lists (#3285 item 2): the RESULT — the activities linked to
// the event — and the rest of the day, each one a tap from linking. The event
// completes against its result: Complete sits beside the linked list, not in the
// header, because the result is what a person checks before marking the day done.
//
// An ABANDONED event takes no result: the person said it did not happen for them, so
// the day still lists what they logged but nothing offers to make one of those its
// result. The auto-link and `linkEventActivityCore` refuse the same thing, so this is
// the offer matching the rule rather than the rule. Unlink stays, so a result attached
// before the event was abandoned can still be taken off.
export default function EventActivities({
  planId,
  status,
  dayLabel,
  activities,
  canWrite,
}: {
  planId: number;
  status: "active" | "completed" | "abandoned";
  dayLabel: string;
  activities: EventActivityView[];
  canWrite: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const linked = activities.filter((a) => a.linked);
  const unlinked = activities.filter((a) => !a.linked);

  async function run(
    action: (
      fd: FormData
    ) => Promise<{ ok: true } | { ok: false; error: string }>,
    fd: FormData
  ) {
    setError(null);
    const res = await action(fd);
    if (!res.ok) setError(res.error);
  }

  return (
    <div className="space-y-6">
      <section className="card" data-testid="event-result">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Result
          </h2>
          {canWrite && status === "active" && (
            <div className="flex items-center gap-1">
              <form action={(fd) => run(setEndurancePlanStatus, fd)}>
                <input type="hidden" name="id" value={planId} />
                <input type="hidden" name="status" value="completed" />
                <Button
                  type="submit"
                  pendingLabel="…"
                  data-testid="event-set-completed"
                >
                  Complete
                </Button>
              </form>
              <form action={(fd) => run(setEndurancePlanStatus, fd)}>
                <input type="hidden" name="id" value={planId} />
                <input type="hidden" name="status" value="abandoned" />
                <Button type="submit" pendingLabel="…">
                  Abandon
                </Button>
              </form>
            </div>
          )}
        </div>
        {linked.length > 0 ? (
          <ul className="mt-3 space-y-2" data-testid="event-linked-list">
            {linked.map((a) => (
              <ActivityRow key={a.id} activity={a}>
                {canWrite && (
                  <form action={(fd) => run(unlinkEventActivity, fd)}>
                    <input type="hidden" name="activity_id" value={a.id} />
                    <Button
                      type="submit"
                      pendingLabel="…"
                      aria-label={`Unlink ${a.title}`}
                    >
                      Unlink
                    </Button>
                  </form>
                )}
              </ActivityRow>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            {status === "abandoned"
              ? "No result — this event was abandoned."
              : unlinked.length > 0
                ? "No activity linked yet. Link one from the day below."
                : "No activity linked yet."}
          </p>
        )}
      </section>

      <section className="card" data-testid="event-day">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Logged on {dayLabel}
        </h2>
        {unlinked.length > 0 ? (
          <ul className="mt-3 space-y-2" data-testid="event-day-list">
            {unlinked.map((a) => (
              <ActivityRow key={a.id} activity={a}>
                {canWrite && status !== "abandoned" && (
                  <form action={(fd) => run(linkEventActivity, fd)}>
                    <input type="hidden" name="id" value={planId} />
                    <input type="hidden" name="activity_id" value={a.id} />
                    <Button
                      type="submit"
                      pendingLabel="…"
                      aria-label={
                        a.linkedElsewhere
                          ? `Move ${a.title} here`
                          : `Link ${a.title}`
                      }
                    >
                      {a.linkedElsewhere ? "Move here" : "Link"}
                    </Button>
                  </form>
                )}
              </ActivityRow>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            {linked.length > 0
              ? "Everything logged that day is linked."
              : "Nothing logged that day yet."}
          </p>
        )}
      </section>
      <InlineError data-testid="event-error">{error}</InlineError>
    </div>
  );
}

function ActivityRow({
  activity,
  children,
}: {
  activity: EventActivityView;
  children: React.ReactNode;
}) {
  return (
    <li
      className="subpanel-inset-sm flex flex-wrap items-center gap-2 rounded-lg border border-black/5 px-3 py-2 text-sm dark:border-white/10"
      data-testid="event-activity"
    >
      <Link
        href={activity.href}
        className="font-medium text-slate-800 hover:underline dark:text-slate-100"
      >
        {activity.title}
      </Link>
      {activity.meta && (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {activity.meta}
        </span>
      )}
      {activity.linkedElsewhere && (
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="event-activity-elsewhere"
        >
          Result of another event that day
        </span>
      )}
      <div className="ml-auto">{children}</div>
    </li>
  );
}
