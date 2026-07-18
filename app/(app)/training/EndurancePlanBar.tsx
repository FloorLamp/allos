"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import NotesText from "@/components/NotesText";
import {
  createEndurancePlan,
  setEndurancePlanStatus,
  deleteEndurancePlan,
} from "./endurance-actions";

// The Training-overview endurance-plan bar (issue #839): a compact card listing the
// profile's ACTIVE event plans, each with its recomputed this-week trajectory (target vs
// actual volume, long-session status, weeks-to-event, and the honest feasibility line),
// plus a "＋ Add plan" form and complete/abandon/delete controls. Coaching-tier — no
// notifications. The plan/trajectory model is derived server-side (one computation, #221),
// so the numbers here match the recommendation arm + the long-session finding.

export interface EndurancePlanView {
  id: number;
  title: string;
  disciplineLabel: string;
  eventDate: string; // formatted long date
  weeksToEvent: number;
  feasible: boolean;
  message: string;
  targetVolume: string; // formatted distance
  actualVolume: string;
  progressPct: number; // 0–100
  longSession: string;
  longSessionDone: boolean;
  hasLongSession: boolean;
  notes: string | null;
}

export default function EndurancePlanBar({
  plans,
  distanceUnit,
}: {
  plans: EndurancePlanView[];
  distanceUnit: "km" | "mi";
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="card" data-testid="endurance-plan-bar">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Event plans
          </h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Training toward a race? Set the event and coaching builds a safe
            weekly volume trajectory — ramp, long session, and taper.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="btn-ghost flex items-center gap-1 text-sm"
          data-testid="endurance-add-toggle"
        >
          <IconPlus size={16} /> Add plan
        </button>
      </div>

      {plans.length > 0 && (
        <ul className="mt-4 space-y-3" data-testid="endurance-plan-list">
          {plans.map((p) => (
            <li
              key={p.id}
              data-testid="endurance-plan-card"
              className="rounded-lg border border-black/5 px-3 py-3 text-sm dark:border-white/10"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                  {p.disciplineLabel}
                </span>
                <span
                  className="font-medium text-slate-800 dark:text-slate-100"
                  data-testid="endurance-plan-title"
                >
                  {p.title}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {p.eventDate} ·{" "}
                  {p.weeksToEvent <= 0
                    ? "event week"
                    : `${p.weeksToEvent} week${p.weeksToEvent === 1 ? "" : "s"} to go`}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <StatusButton id={p.id} to="completed" label="Complete" />
                  <StatusButton id={p.id} to="abandoned" label="Abandon" />
                  <form
                    action={async (fd) => {
                      await deleteEndurancePlan(fd);
                    }}
                  >
                    <input type="hidden" name="id" value={p.id} />
                    <SubmitButton
                      pendingLabel="…"
                      className="btn-ghost p-1 text-slate-400 hover:text-rose-500"
                      aria-label={`Delete ${p.title}`}
                    >
                      <IconX size={16} />
                    </SubmitButton>
                  </form>
                </div>
              </div>

              <p
                className="mt-2 text-slate-700 dark:text-slate-200"
                data-testid="endurance-plan-target"
              >
                This week: <strong>{p.actualVolume}</strong> of{" "}
                <strong>{p.targetVolume}</strong> target
                {p.hasLongSession && (
                  <>
                    {" · "}long session {p.longSession}{" "}
                    {p.longSessionDone ? "✓ done" : "due"}
                  </>
                )}
              </p>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                <div
                  className="h-full rounded-full bg-sky-500"
                  style={{ width: `${p.progressPct}%` }}
                />
              </div>
              <p
                className={`mt-2 text-xs ${p.feasible ? "text-slate-500 dark:text-slate-400" : "text-amber-700 dark:text-amber-300"}`}
                data-testid="endurance-plan-message"
              >
                {p.message}
              </p>
              {p.notes && (
                <NotesText
                  notes={p.notes}
                  className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {plans.length === 0 && !showForm && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          No event plans. Add one to train toward a race.
        </p>
      )}

      {showForm && (
        <form
          action={async (fd) => {
            await createEndurancePlan(fd);
            setShowForm(false);
          }}
          className="mt-4 space-y-3 rounded-lg border border-black/5 p-3 dark:border-white/10"
          data-testid="endurance-form"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="section-label" htmlFor="endurance-discipline">
                Discipline
              </label>
              <select
                id="endurance-discipline"
                name="discipline"
                defaultValue="run"
                className="input mt-1 w-full"
                data-testid="endurance-discipline"
              >
                <option value="run">Run</option>
                <option value="ride">Ride</option>
                <option value="swim">Swim</option>
              </select>
            </div>
            <div>
              <label className="section-label" htmlFor="endurance-event-name">
                Event name (optional)
              </label>
              <input
                id="endurance-event-name"
                name="event_name"
                maxLength={120}
                placeholder="e.g. City Half Marathon"
                className="input mt-1 w-full"
                data-testid="endurance-event-name"
              />
            </div>
            <div>
              <label className="section-label" htmlFor="endurance-event-date">
                Event date
              </label>
              <input
                id="endurance-event-date"
                name="event_date"
                type="date"
                required
                className="input mt-1 w-full"
                data-testid="endurance-event-date"
              />
            </div>
            <div>
              <label className="section-label" htmlFor="endurance-distance">
                Target distance ({distanceUnit})
              </label>
              <input
                id="endurance-distance"
                name="target_distance"
                type="number"
                step="0.1"
                min="0"
                required
                placeholder="21.1"
                className="input mt-1 w-full"
                data-testid="endurance-distance"
              />
            </div>
            <div>
              <label className="section-label" htmlFor="endurance-time">
                Target time (optional, H:MM:SS)
              </label>
              <input
                id="endurance-time"
                name="target_time"
                placeholder="1:45:00"
                className="input mt-1 w-full"
                data-testid="endurance-time"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <SubmitButton pendingLabel="Saving…" data-testid="endurance-submit">
              Add plan
            </SubmitButton>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="btn-ghost"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function StatusButton({
  id,
  to,
  label,
}: {
  id: number;
  to: "completed" | "abandoned";
  label: string;
}) {
  return (
    <form
      action={async (fd) => {
        await setEndurancePlanStatus(fd);
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={to} />
      <SubmitButton
        pendingLabel="…"
        className="btn-ghost px-2 py-1 text-xs"
        data-testid={`endurance-set-${to}`}
      >
        {label}
      </SubmitButton>
    </form>
  );
}
