"use client";

import type { Dispatch, SetStateAction } from "react";
import { IconX } from "@tabler/icons-react";
import type { IntakeConditionOption } from "@/lib/types";
import {
  GOAL_PURPOSES,
  goalPurposeLabel,
  purposeIdentity,
  suggestGoalPurposes,
  type PurposeDraft,
  type PurposeDirection,
} from "@/lib/intake-purposes";

// The "What you take it for" control (issue #2857).
//
// An intake item had no structured why. A supplement's reason lived in `notes` as
// prose — "taken for eye health", "25-OH-D is 29 ng/mL, flagged LOW" — where nothing
// could read it, so a stack could not say why an item was in it or group itself by
// what it was for. These rows are how somebody states that once, in a shape the app
// can keep.
//
// DECLARED ONLY, SUGGESTED AT MOST (#559/#1505/#798). Every chip here is a tap the
// person makes. The composition feeder OFFERS the eye-health goal when the label
// carries lutein/zeaxanthin/astaxanthin (readable at all only since #2856) and writes
// nothing — the offer sits beside the chosen chips until it is taken or ignored.
//
// Informational: a purpose never changes dueness, reminders or any safety engine.

function draftKey(d: PurposeDraft): string {
  if (d.kind === "goal")
    return purposeIdentity({
      kind: "goal",
      goal_key: d.goalKey,
      condition_id: null,
      biomarker_key: null,
      direction: null,
    });
  if (d.kind === "condition")
    return purposeIdentity({
      kind: "condition",
      goal_key: null,
      condition_id: d.conditionId,
      biomarker_key: null,
      direction: null,
    });
  return purposeIdentity({
    kind: "biomarker",
    goal_key: null,
    condition_id: null,
    biomarker_key: d.biomarkerKey,
    direction: d.direction ?? null,
  });
}

// The chip's own words. The condition lookup runs over EVERY recorded condition, not
// only the ones the picker offers: a purpose declared while a condition was active
// outlives its resolution, and the id in the row is still the whole answer. Looking it
// up in the active list alone left the chip reading the literal word "condition" and
// its remove control reading "Remove condition" (#3650).
function chipLabel(
  d: PurposeDraft,
  conditions: readonly IntakeConditionOption[]
): string {
  if (d.kind === "goal") return goalPurposeLabel(d.goalKey);
  if (d.kind === "condition")
    return conditions.find((c) => c.id === d.conditionId)?.name ?? "condition";
  return d.direction ? `${d.direction} ${d.biomarkerKey}` : d.biomarkerKey;
}

export default function PurposesEditor({
  rows,
  setRows,
  name,
  ingredientNames,
  conditions = [],
  biomarkers = [],
  fid,
}: {
  rows: PurposeDraft[];
  setRows: Dispatch<SetStateAction<PurposeDraft[]>>;
  // The item's name and label composition — the suggestion's only inputs.
  name: string;
  ingredientNames: readonly string[];
  // The profile's own recorded conditions, the same list the #1052 indication picker
  // reads — ALL of them, with their status. Empty when nothing is recorded, and the
  // condition row simply does not show.
  conditions?: IntakeConditionOption[];
  // Canonical biomarker names this profile actually has results for
  // (getUsedCanonicalNames). Not the whole vocabulary: a reason names an analyte the
  // person has seen a number for.
  biomarkers?: string[];
  fid: string | number;
}) {
  const chosen = new Set(rows.map(draftKey));
  // What the picker OFFERS: only active conditions — nobody files a new reason against
  // something they have marked resolved. The labels above read the full list.
  const activeConditions = conditions.filter((c) => c.status === "active");
  function add(d: PurposeDraft) {
    setRows((rs) =>
      rs.some((r) => draftKey(r) === draftKey(d)) ? rs : [...rs, d]
    );
  }
  function removeAt(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }

  const suggested = suggestGoalPurposes({
    name,
    ingredientNames,
    declared: rows
      .filter(
        (r): r is Extract<PurposeDraft, { kind: "goal" }> => r.kind === "goal"
      )
      .map((r) => ({
        kind: "goal" as const,
        goal_key: r.goalKey,
        condition_id: null,
        biomarker_key: null,
        direction: null,
      })),
  });

  return (
    <div className="sm:col-span-2" data-testid="purposes-editor">
      <div className="mb-1 section-label">What you take it for (optional)</div>
      <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
        Your own reason. It shows on the item and never changes reminders or
        safety checks.
      </p>

      {rows.length > 0 && (
        <ul data-testid="purpose-chips" className="mb-2 flex flex-wrap gap-1.5">
          {rows.map((r, i) => (
            <li key={draftKey(r)}>
              <span className="inline-flex items-center gap-1 rounded-full border border-(--border) px-2.5 py-1 text-sm">
                {chipLabel(r, conditions)}
                <button
                  type="button"
                  data-testid={`purpose-remove-${i}`}
                  aria-label={`Remove ${chipLabel(r, conditions)}`}
                  onClick={() => removeAt(i)}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  <IconX className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {suggested.length > 0 && (
        <div
          data-testid="purpose-suggestions"
          className="mb-2 flex flex-wrap items-center gap-1.5"
        >
          <span className="text-xs text-slate-500 dark:text-slate-400">
            From what&apos;s in it:
          </span>
          {suggested.map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`purpose-suggest-${key}`}
              onClick={() => add({ kind: "goal", goalKey: key })}
              data-fact-chip="solo"
              className="rounded-full border border-dashed border-(--border) px-2.5 text-sm"
            >
              + {goalPurposeLabel(key)}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {GOAL_PURPOSES.map((g) => {
          const key = draftKey({ kind: "goal", goalKey: g.key });
          if (chosen.has(key)) return null;
          return (
            <button
              key={g.key}
              type="button"
              data-testid={`purpose-goal-${g.key}`}
              onClick={() => add({ kind: "goal", goalKey: g.key })}
              data-fact-chip="solo"
              className="rounded-full border border-(--border) px-2.5 text-sm transition hover:bg-(--ghost-hover)"
            >
              {g.label}
            </button>
          );
        })}
      </div>

      {activeConditions.length > 0 && (
        <div className="mt-2">
          <label
            htmlFor={`purpose-condition-${fid}`}
            className="mb-1 block text-xs text-slate-500 dark:text-slate-400"
          >
            A condition you track
          </label>
          <select
            id={`purpose-condition-${fid}`}
            data-testid="purpose-condition"
            value=""
            onChange={(e) => {
              const id = Number(e.target.value);
              if (Number.isInteger(id) && id > 0)
                add({ kind: "condition", conditionId: id });
              e.target.value = "";
            }}
            className="input"
          >
            <option value="">Add a condition…</option>
            {activeConditions
              .filter(
                (c) =>
                  !chosen.has(
                    draftKey({ kind: "condition", conditionId: c.id })
                  )
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
      )}

      {biomarkers.length > 0 && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 grow">
            <label
              htmlFor={`purpose-biomarker-${fid}`}
              className="mb-1 block text-xs text-slate-500 dark:text-slate-400"
            >
              A result you&apos;re acting on
            </label>
            <select
              id={`purpose-biomarker-${fid}`}
              data-testid="purpose-biomarker"
              value=""
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) return;
                // The direction rides in the option value so one control states both,
                // and it stays OPTIONAL: "25-OH-D" alone is a complete reason. Low and
                // high are both real starts (#2754), so neither is the default.
                // Split on the FIRST "|" only: a canonical biomarker name carries
                // spaces and commas ("Vitamin D, 25-Hydroxy" is ONE name), so a space
                // separator would truncate the very analyte the issue's own example
                // names.
                const sep = raw.indexOf("|");
                const dir = raw.slice(0, sep);
                const key = raw.slice(sep + 1);
                add({
                  kind: "biomarker",
                  biomarkerKey: key,
                  direction: (dir || null) as PurposeDirection | null,
                });
                e.target.value = "";
              }}
              className="input"
            >
              <option value="">Add a biomarker…</option>
              {biomarkers.map((b) => (
                <optgroup key={b} label={b}>
                  <option value={`|${b}`}>{b}</option>
                  <option value={`low|${b}`}>low {b}</option>
                  <option value={`high|${b}`}>high {b}</option>
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
