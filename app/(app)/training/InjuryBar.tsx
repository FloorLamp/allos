"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import NotesText from "@/components/NotesText";
import DateField from "@/components/DateField";
import {
  REGION_SCOPES,
  type MovementPattern,
  type MuscleRegion,
} from "@/lib/lifts";
import {
  INJURY_MOVEMENT_PATTERNS,
  type InjuryLaterality,
  type InjuryStatus,
} from "@/lib/injury-model";
import {
  logInjury,
  setInjuryStatus,
  deleteInjury,
  activateInjurySituation,
} from "./injury-actions";

// The Training-overview injury bar (issue #838), the situations-bar shape: a compact card
// listing the profile's ACTIVE / RECOVERING injuries as chips (each with inline status
// controls + delete), a one-tap "＋ Log injury" form (label + affected-region chips +
// status), and — suggest-only (#560) — a "Mark the Injury situation active" bridge when no
// Injury situation is toggled on. Coaching-tier: no notifications, purely a read/log
// surface. The engine consumes the SAME injuries through the shared recommendation model,
// so the exclusion/tempering shown on the next-workout card and here always agree (#221).

export interface InjuryView {
  id: number;
  label: string;
  regions: MuscleRegion[];
  status: InjuryStatus;
  since: string | null;
  notes: string | null;
  // #2024 — the precision the user declared, so the chip names the constraint they wrote
  // rather than only the coarse region it falls back to.
  laterality: InjuryLaterality | null;
  movements: MovementPattern[];
  exercises: string[];
  loadFactor: number | null;
  reviewDate: string | null;
  // Whether the user's own review date has arrived. SUGGEST-ONLY: nothing about the
  // constraint changes until they act on it.
  reviewDue: boolean;
}

const MOVEMENT_LABEL: Record<MovementPattern, string> = {
  push: "Pushing",
  pull: "Pulling",
  legs: "Legs",
  core: "Core",
};

// The one-line "what does this constraint actually cover?" summary, at the level the user
// declared it (#2024's exercise → movement → region precedence). A constraint that named
// lifts says those lifts; one that named a pattern says the pattern; one that named
// neither still reads as its regions, exactly as before.
function scopeSummary(inj: InjuryView): string {
  const side =
    inj.laterality && inj.laterality !== "bilateral"
      ? `${inj.laterality} side · `
      : "";
  if (inj.exercises.length > 0) return `${side}${inj.exercises.join(", ")}`;
  if (inj.movements.length > 0)
    return `${side}${inj.movements.map((m) => MOVEMENT_LABEL[m]).join(", ")}`;
  return `${side}${inj.regions.join(", ")}`;
}

const STATUS_BADGE: Record<InjuryStatus, string> = {
  active: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  recovering:
    "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  resolved:
    "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
};

const STATUS_LABEL: Record<InjuryStatus, string> = {
  active: "Active",
  recovering: "Recovering",
  resolved: "Resolved",
};

export default function InjuryBar({
  injuries,
  suggestActivateSituation,
}: {
  injuries: InjuryView[];
  suggestActivateSituation: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const current = injuries.filter((i) => i.status !== "resolved");

  return (
    <div className="card" data-testid="injury-bar">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-slate-800 dark:text-slate-100">
            Injuries
          </h3>
          {/* Conditional card (#1496): on the doing-first Overview the explainer
              renders only when there IS something (or the form is open). With no
              injury logged the card collapses to its title + "Log injury" — the
              affordance stays (it's the only door to the first injury) but it no
              longer costs a paragraph of vertical space above the real content. */}
          {(current.length > 0 || showForm) && (
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Log a tweak so coaching trains around it. Active regions are set
              aside (and named on your suggestion); recovering ones ease back.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="btn-ghost flex items-center gap-1 text-sm"
          data-testid="injury-add-toggle"
        >
          <IconPlus size={16} /> Log injury
        </button>
      </div>

      {current.length > 0 && (
        <ul className="mt-4 space-y-2" data-testid="injury-list">
          {current.map((inj) => (
            <li
              key={inj.id}
              data-testid="injury-chip"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-black/5 px-3 py-2 text-sm dark:border-white/10"
            >
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[inj.status]}`}
              >
                {STATUS_LABEL[inj.status]}
              </span>
              <span className="font-medium text-slate-800 dark:text-slate-100">
                {inj.label}
              </span>
              <span
                className="text-xs text-slate-500 dark:text-slate-400"
                data-testid="injury-scope"
              >
                {scopeSummary(inj)}
              </span>
              {inj.status === "recovering" && inj.loadFactor != null && (
                <span
                  className="text-xs text-slate-500 dark:text-slate-400"
                  data-testid="injury-load-factor"
                >
                  easing to {Math.round(inj.loadFactor * 100)}% (your setting)
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {inj.status === "active" && (
                  <StatusButton
                    id={inj.id}
                    to="recovering"
                    label="Recovering"
                  />
                )}
                {inj.status !== "resolved" && (
                  <StatusButton id={inj.id} to="resolved" label="Resolve" />
                )}
                <form
                  action={async (fd) => {
                    await deleteInjury(fd);
                  }}
                >
                  <input type="hidden" name="id" value={inj.id} />
                  <SubmitButton
                    pendingLabel="…"
                    className="btn-ghost p-1 text-slate-400 hover:text-rose-500"
                    aria-label={`Delete ${inj.label}`}
                  >
                    <IconX size={16} />
                  </SubmitButton>
                </form>
              </div>
              {inj.notes && (
                <NotesText
                  notes={inj.notes}
                  className="w-full text-xs text-slate-500 dark:text-slate-400"
                />
              )}
              {/* The review-date affordance (#2024): SUGGEST-ONLY. Reaching the date the
                  user set changes nothing — no status transition, no relaxed load, no
                  expiry. It asks; the buttons above are the only writes. */}
              {inj.reviewDue && (
                <p
                  className="w-full text-xs text-slate-600 dark:text-slate-300"
                  data-testid="injury-review-prompt"
                >
                  You set {inj.reviewDate} to revisit this — still current?
                  Nothing has changed on its own.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {current.length === 0 && !showForm && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
          No injuries logged. Training is unrestricted.
        </p>
      )}

      {showForm && (
        <form
          action={async (fd) => {
            await logInjury(fd);
            setShowForm(false);
          }}
          className="mt-4 space-y-3 rounded-lg border border-black/5 p-3 dark:border-white/10"
          data-testid="injury-form"
        >
          <div>
            <label className="section-label" htmlFor="injury-label">
              What&apos;s hurt?
            </label>
            <input
              id="injury-label"
              name="label"
              required
              maxLength={120}
              placeholder="e.g. Right shoulder"
              className="input mt-1 w-full"
              data-testid="injury-label-input"
            />
          </div>
          <fieldset>
            <legend className="section-label">Affected regions</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {REGION_SCOPES.map((r) => (
                <label
                  key={r}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border border-black/10 px-2.5 py-1 text-sm dark:border-white/15"
                >
                  <input
                    type="checkbox"
                    name="regions"
                    value={r}
                    data-testid={`injury-region-${r}`}
                  />
                  {r}
                </label>
              ))}
            </div>
          </fieldset>
          {/* The #2024 precision — all OPTIONAL. Leaving every field alone records
              exactly the region-scoped constraint this form always recorded; filling one
              in narrows the constraint to what the user actually means, so one sore
              movement stops deleting a whole region of suggestions. Nothing here is a
              diagnosis, a severity, or a prohibition: it is the user saying what they
              want left alone. */}
          <fieldset>
            <legend className="section-label">
              Narrow it (optional) — movements
            </legend>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Pick patterns if only some movements are affected. Naming
              movements keeps the rest of the region in your suggestions.
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {INJURY_MOVEMENT_PATTERNS.map((m) => (
                <label
                  key={m}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border border-black/10 px-2.5 py-1 text-sm dark:border-white/15"
                >
                  <input
                    type="checkbox"
                    name="movements"
                    value={m}
                    data-testid={`injury-movement-${m}`}
                  />
                  {MOVEMENT_LABEL[m]}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label className="section-label" htmlFor="injury-laterality">
              Side (optional)
            </label>
            <select
              id="injury-laterality"
              name="laterality"
              defaultValue=""
              className="input mt-1 w-full"
              data-testid="injury-laterality"
            >
              <option value="">Not specified</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="bilateral">Both sides</option>
            </select>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Recorded and shown. Suggestions are picked per exercise, not per
              side, so on a two-sided lift we say the constraint applies to the
              whole lift rather than pretending we worked around it.
            </p>
          </div>
          <div>
            <label className="section-label" htmlFor="injury-status">
              Status
            </label>
            <select
              id="injury-status"
              name="status"
              defaultValue="active"
              className="input mt-1 w-full"
            >
              <option value="active">
                Active — set the affected work aside
              </option>
              <option value="recovering">
                Recovering — ease back at lighter loads
              </option>
            </select>
          </div>
          <div>
            <label className="section-label" htmlFor="injury-load-factor">
              While recovering, ease to (optional)
            </label>
            <select
              id="injury-load-factor"
              name="loadFactor"
              defaultValue=""
              className="input mt-1 w-full"
              data-testid="injury-load-factor-input"
            >
              <option value="">Use our default (60%)</option>
              <option value="0.4">40% of your usual target</option>
              <option value="0.5">50%</option>
              <option value="0.7">70%</option>
              <option value="0.8">80%</option>
              <option value="0.9">90%</option>
            </select>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Our 60% is a conservative default, not a recommendation about your
              recovery. Your setting always wins.
            </p>
          </div>
          <div>
            <label className="section-label" htmlFor="injury-review-date">
              Remind me to revisit (optional)
            </label>
            <DateField
              id="injury-review-date"
              name="reviewDate"
              data-testid="injury-review-date"
            />
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              We&apos;ll ask whether it&apos;s still current. We never change it
              for you.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SubmitButton pendingLabel="Saving…" data-testid="injury-submit">
              Log injury
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

      {suggestActivateSituation && current.length > 0 && (
        <form
          action={async () => {
            await activateInjurySituation();
          }}
          className="mt-3"
        >
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Have injury-specific supplements?{" "}
            <SubmitButton
              pendingLabel="…"
              className="btn-ghost inline p-0 text-xs underline"
            >
              Turn on the &ldquo;Injury&rdquo; situation
            </SubmitButton>
          </p>
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
  to: InjuryStatus;
  label: string;
}) {
  return (
    <form
      action={async (fd) => {
        await setInjuryStatus(fd);
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={to} />
      <SubmitButton
        pendingLabel="…"
        className="btn-ghost px-2 py-1 text-xs"
        data-testid={`injury-set-${to}`}
      >
        {label}
      </SubmitButton>
    </form>
  );
}
