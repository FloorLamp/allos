"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import Button from "@/components/Button";
import Combobox from "@/components/Combobox";
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

// The per-event trajectory block. Present only for an event with the cardio pair
// (#3285) — a lifting meet has nothing to project — so the card renders its header,
// its date and its controls either way and this section is what varies. ONE view
// type with an optional half, not a second card shape.
export interface EnduranceTrajectoryView {
  weeksToEvent: number;
  feasible: boolean;
  message: string;
  targetVolume: string; // formatted distance
  actualVolume: string;
  progressPct: number; // 0–100
  longSession: string;
  longSessionDone: boolean;
  hasLongSession: boolean;
}

export interface EndurancePlanView {
  id: number;
  title: string;
  // The badge: the discipline for a cardio plan, else the open event kind (#3285).
  badge: string;
  eventDate: string; // formatted long date
  weeksToEvent: number;
  trajectory: EnduranceTrajectoryView | null;
  notes: string | null;
}

export default function EndurancePlanBar({
  plans,
  distanceUnit,
  kindSuggestions,
}: {
  plans: EndurancePlanView[];
  distanceUnit: "km" | "mi";
  kindSuggestions: readonly string[];
}) {
  const [showForm, setShowForm] = useState(false);
  // The Combobox is controlled, so the kind lives here. Reset with the form so a
  // cancelled entry does not carry its word into the next one.
  const [kind, setKind] = useState("race");

  return (
    <div className="card" data-testid="endurance-plan-bar">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Event plans
          </h3>
          {/* Conditional card (#1496), same shape as the injury bar: the explainer
              renders only with a live plan (or an open form); otherwise the card is
              its title + "Add plan", so an empty state costs one row, not a block. */}
          {(plans.length > 0 || showForm) && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Racing, competing, or on a meet card? Record the event and its
              date. Add a discipline and a distance and coaching builds a safe
              weekly volume trajectory — ramp, long session, and taper.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="btn-ghost flex items-center gap-1 text-sm"
          data-testid="endurance-add-toggle"
        >
          <IconPlus size={16} /> Add event
        </button>
      </div>

      {plans.length > 0 && (
        <ul className="mt-4 space-y-3" data-testid="endurance-plan-list">
          {plans.map((p) => (
            <li
              key={p.id}
              data-testid="endurance-plan-card"
              className="subpanel-inset-sm rounded-lg border border-black/5 px-3 py-3 text-sm dark:border-white/10"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-500/15 dark:text-sky-300">
                  {p.badge}
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
                    <Button
                      type="submit"
                      pendingLabel="…"
                      aria-label={`Delete ${p.title}`}
                    >
                      <IconX size={16} />
                    </Button>
                  </form>
                </div>
              </div>

              {p.trajectory && (
                <>
                  <p
                    className="mt-2 text-slate-700 dark:text-slate-200"
                    data-testid="endurance-plan-target"
                  >
                    This week: <strong>{p.trajectory.actualVolume}</strong> of{" "}
                    <strong>{p.trajectory.targetVolume}</strong> target
                    {p.trajectory.hasLongSession && (
                      <>
                        {" · "}long session {p.trajectory.longSession}{" "}
                        {p.trajectory.longSessionDone ? "✓ done" : "due"}
                      </>
                    )}
                  </p>
                  <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                    <div
                      className="h-full rounded-full bg-sky-500"
                      style={{ width: `${p.trajectory.progressPct}%` }}
                    />
                  </div>
                  <p
                    className={`mt-2 text-xs ${p.trajectory.feasible ? "text-slate-500 dark:text-slate-400" : "text-amber-700 dark:text-amber-300"}`}
                    data-testid="endurance-plan-message"
                  >
                    {p.trajectory.message}
                  </p>
                </>
              )}
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
          No events. Add a race, a competition or a meet to track it here.
        </p>
      )}

      {showForm && (
        <form
          action={async (fd) => {
            await createEndurancePlan(fd);
            setShowForm(false);
            setKind("race");
          }}
          className="subpanel-inset-sm mt-4 space-y-3 rounded-lg border border-black/5 p-3 dark:border-white/10"
          data-testid="endurance-form"
        >
          {/* The unit the distance field is LABELLED with, carried with the value
              (#630, #3942) — the pref is per-login, so another tab can flip it
              between this render and Save. */}
          <input type="hidden" name="distance_unit" value={distanceUnit} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="section-label" htmlFor="endurance-kind">
                Kind
              </label>
              {/* The kind is stored as free TEXT (#3285), so this is a create-on-type
                  Combobox rather than a select: the suggestions are the common words
                  and a club with a fifth one just types it. The native autocomplete
                  element the #1176/#1177 guard bans would have been the obvious reach
                  and the wrong one — prefix-only matching is exactly the wrong
                  affordance for a vocabulary the user is allowed to extend. */}
              <Combobox
                id="endurance-kind"
                value={kind}
                onChange={setKind}
                options={[...kindSuggestions]}
                allowFreeText
                name="kind"
                ariaLabel="Kind"
                placeholder="e.g. race, meet, tournament"
                freeTextLabel={(q) => <>Use “{q}”</>}
              />
            </div>
            <div>
              <label className="section-label" htmlFor="endurance-discipline">
                Discipline (optional)
              </label>
              <select
                id="endurance-discipline"
                name="discipline"
                defaultValue="run"
                className="input mt-1 w-full"
                data-testid="endurance-discipline"
              >
                <option value="">None — not a distance event</option>
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
              Add event
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
      <Button
        type="submit"
        pendingLabel="…"
        data-testid={`endurance-set-${to}`}
      >
        {label}
      </Button>
    </form>
  );
}
