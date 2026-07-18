"use client";

import { useState } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import NotesText from "@/components/NotesText";
import { REGION_SCOPES, type MuscleRegion } from "@/lib/lifts";
import type { InjuryStatus } from "@/lib/injury-model";
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
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Log a tweak so coaching trains around it. Active regions are set
            aside (and named on your suggestion); recovering ones ease back.
          </p>
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
              {inj.regions.length > 0 && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {inj.regions.join(", ")}
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
              <option value="active">Active — set the region aside</option>
              <option value="recovering">
                Recovering — ease back at lighter loads
              </option>
            </select>
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
