"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { fmtDistance } from "@/lib/units";
import type { DistanceUnit } from "@/lib/settings";
import type { Activity, ActivityType } from "@/lib/types";
import { saveActivity, deleteActivity } from "../journal/actions";

// The restricted-profile activity log (issue #489). A minor profile is blocked
// from the adult fitness apparatus (strength e1RM/standards, fitness-age, coaching,
// workout recommendation) but tracking a sport/cardio practice is age-neutral, so
// this lightweight surface lets them log and review those sessions. It posts to the
// SAME saveActivity/deleteActivity write path as the full editor — the type-aware
// gate there (isActivityTypeAllowed) is the authority — but only ever offers the
// two duration-based types, so nothing here can create a strength row.
export default function ActivityLogPanel({
  activities,
  distanceUnit,
  defaultDate,
}: {
  activities: Activity[];
  distanceUnit: DistanceUnit;
  defaultDate: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(formData: FormData) {
    setError(null);
    const type = String(formData.get("type") ?? "") as ActivityType;
    const title = String(formData.get("title") ?? "").trim();
    const date = String(formData.get("date") ?? "").trim();
    const distance = String(formData.get("distance") ?? "").trim();
    const durationMin = String(formData.get("duration_min") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    if (!title) {
      setError("Give the session a name (e.g. Soccer practice).");
      return;
    }
    // Shape the payload exactly like the full editor's: one duration-based part
    // whose distance is in the user's unit (saveActivity converts to km).
    const fd = new FormData();
    fd.set("type", type);
    fd.set("title", title);
    fd.set("date", date);
    if (notes) fd.set("notes", notes);
    fd.set(
      "components",
      JSON.stringify([
        {
          name: title,
          type,
          distance: distance ? Number(distance) : null,
          duration_min: durationMin ? Number(durationMin) : null,
        },
      ])
    );
    const outcome = await saveActivity(fd);
    if (!outcome.ok) {
      setError(
        outcome.reason === "invalid"
          ? "Check the date and name and try again."
          : "Couldn't save this session. Try again."
      );
      return;
    }
    toast("Session logged");
    formRef.current?.reset();
    router.refresh();
  }

  async function remove(formData: FormData) {
    await deleteActivity(formData);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <form
        ref={formRef}
        action={handle}
        className="card space-y-3"
        data-testid="activity-log-form"
      >
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Log a session
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Track a sport, practice, or cardio session by duration — no fitness
            scores or 1-rep-max framing.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="label" htmlFor="a-type">
              Type
            </label>
            <select
              id="a-type"
              name="type"
              defaultValue="sport"
              className="input"
            >
              <option value="sport">Sport / practice</option>
              <option value="cardio">Cardio</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="a-title">
              What did you do?
            </label>
            <input
              id="a-title"
              type="text"
              name="title"
              placeholder="Soccer practice"
              className="input"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="a-date">
              Date
            </label>
            <DateField
              id="a-date"
              name="date"
              defaultValue={defaultDate}
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="a-duration">
              Duration (min)
            </label>
            <input
              id="a-duration"
              type="number"
              step="1"
              min="0"
              name="duration_min"
              className="input"
            />
          </div>

          <div>
            <label className="label" htmlFor="a-distance">
              Distance ({distanceUnit})
            </label>
            <input
              id="a-distance"
              type="number"
              step="0.01"
              min="0"
              name="distance"
              className="input"
            />
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <label className="label" htmlFor="a-notes">
              Notes
            </label>
            <input
              id="a-notes"
              type="text"
              name="notes"
              placeholder="Optional"
              className="input"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}
        <SubmitButton pendingLabel="Saving…">Log session</SubmitButton>
      </form>

      <div className="card" data-testid="activity-log-list">
        <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
          Recent sessions
        </h2>
        {activities.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No sessions logged yet.
          </p>
        ) : (
          <ul className="divide-y divide-black/5 dark:divide-white/5">
            {activities.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                    {a.title}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {a.date}
                    {" · "}
                    {a.type === "cardio" ? "Cardio" : "Sport"}
                    {a.duration_min != null ? ` · ${a.duration_min} min` : ""}
                    {a.distance_km != null
                      ? ` · ${fmtDistance(a.distance_km, distanceUnit)}`
                      : ""}
                  </div>
                </div>
                <form action={remove}>
                  <input type="hidden" name="id" value={a.id} />
                  <button
                    type="submit"
                    className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-400"
                  >
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
