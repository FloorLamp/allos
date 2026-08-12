"use client";

import { useMemo, useState } from "react";
import { IconPencil, IconPlus, IconX } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";
import NotesText from "@/components/NotesText";
import DateField from "@/components/DateField";
import Combobox from "@/components/Combobox";
import {
  baseLiftName,
  exerciseDisplayName,
  exerciseHistoryKey,
  REGION_SCOPES,
  type MovementPattern,
  type MuscleId,
  type MuscleRegion,
} from "@/lib/lifts";
import {
  INJURY_MOVEMENT_PATTERNS,
  MOVEMENT_PATTERN_LABEL,
  scopeChange,
  scopeSummary,
  type InjuryLaterality,
  type InjuryStatus,
} from "@/lib/injury-model";
import {
  logInjury,
  updateInjury,
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
//
// #2297 — a chip's constraint can be CORRECTED in place. An injury is understood
// gradually: it is logged broadly on day one because that is all you know, and a week
// later you know it is only overhead work. The edit form is the SAME fields the log form
// writes (one `InjuryScopeFields`, including #2199's exercise picker) rather than a second
// vocabulary for the same concepts, and it edits the SCOPE only — the lifecycle (status,
// start date) keeps the paths it already has.

export interface InjuryView {
  id: number;
  label: string;
  regions: MuscleRegion[];
  // The optional finer muscle list. Not editable here (the form's vocabulary is regions),
  // but carried so an edit can round-trip it instead of dropping it.
  muscles: MuscleId[];
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

// The load-preference options the form offers, as submitted values. "" ⇒ the app's
// disclosed 60% fallback.
const LOAD_FACTOR_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Use our default (60%)" },
  { value: "0.4", label: "40% of your usual target" },
  { value: "0.5", label: "50%" },
  { value: "0.7", label: "70%" },
  { value: "0.8", label: "80%" },
  { value: "0.9", label: "90%" },
];

// The options with the CURRENT value guaranteed present: a stored preference that isn't
// one of the offered steps (a legacy or hand-set fraction) must still be selectable, or
// re-saving an edit would silently drop the user's own setting back to the app default.
function loadFactorOptions(
  current: string
): { value: string; label: string }[] {
  if (!current || LOAD_FACTOR_OPTIONS.some((o) => o.value === current))
    return LOAD_FACTOR_OPTIONS;
  return [
    ...LOAD_FACTOR_OPTIONS,
    {
      value: current,
      label: `${Math.round(Number(current) * 100)}% (your setting)`,
    },
  ];
}

export default function InjuryBar({
  injuries,
  liftOptions,
  suggestActivateSituation,
}: {
  injuries: InjuryView[];
  // The frequency-ranked lift list the activity form, GoalForm and the routine builder
  // already consume (#1676) — catalog base names plus the profile's own custom lifts,
  // ordered by what this person actually trains.
  liftOptions: string[];
  suggestActivateSituation: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  // Which chip's scope is open for correction (#2297). One at a time: the edit form is a
  // full-width panel inside the chip, so two open at once would bury the list.
  const [editingId, setEditingId] = useState<number | null>(null);
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
                <button
                  type="button"
                  onClick={() =>
                    setEditingId((v) => (v === inj.id ? null : inj.id))
                  }
                  className="btn-ghost p-1 text-slate-400 hover:text-brand-600 dark:hover:text-brand-400"
                  aria-label={`Edit ${inj.label}`}
                  title="Edit what this covers"
                  data-testid="injury-edit-toggle"
                >
                  <IconPencil size={16} />
                </button>
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
              {editingId === inj.id && (
                <EditInjuryForm
                  injury={inj}
                  liftOptions={liftOptions}
                  onDone={() => setEditingId(null)}
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
        <LogInjuryForm
          liftOptions={liftOptions}
          onDone={() => setShowForm(false)}
        />
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

// ── The scope form, written once and bound by both writes (#2297) ────────────

// The declaration the form holds while it is being written: the same fields `logInjury`
// and `updateInjury` read, as form-shaped values (a select's "" for "not specified", the
// picker's user-facing lift NAMES — the actions canonicalize at the boundary).
interface ScopeDraft {
  label: string;
  regions: MuscleRegion[];
  movements: MovementPattern[];
  exercises: string[];
  laterality: InjuryLaterality | "";
  loadFactor: string;
  reviewDate: string;
}

function blankDraft(): ScopeDraft {
  return {
    label: "",
    regions: [],
    movements: [],
    exercises: [],
    laterality: "",
    loadFactor: "",
    reviewDate: "",
  };
}

// A saved injury as the form holds it. Stored exercise identities render back in the
// catalog's own casing, exactly as the chip shows them, so the picker's chips read like
// what the user picked rather than the lowercase key they are stored as.
function draftOf(inj: InjuryView): ScopeDraft {
  return {
    label: inj.label,
    regions: inj.regions,
    movements: inj.movements,
    exercises: inj.exercises.map(exerciseDisplayName),
    laterality: inj.laterality ?? "",
    loadFactor: inj.loadFactor != null ? String(inj.loadFactor) : "",
    reviewDate: inj.reviewDate ?? "",
  };
}

function toggle<T>(xs: readonly T[], v: T): T[] {
  return xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v];
}

// Every field of the injury SCOPE, written once. The log form and the edit form differ in
// what they submit alongside it (a new row's status; an existing row's id and untouched
// lifecycle) and in nothing else — a correction offers exactly the vocabulary the original
// declaration did.
function InjuryScopeFields({
  idPrefix,
  liftOptions,
  draft,
  onChange,
  children,
}: {
  // DOM ids must stay unique when the log form and an edit form are open together.
  idPrefix: string;
  liftOptions: string[];
  draft: ScopeDraft;
  onChange: (patch: Partial<ScopeDraft>) => void;
  // The status control, rendered between the side and the load preference. Only the log
  // form has one: an existing injury's status is the chip's own lifecycle buttons.
  children?: React.ReactNode;
}) {
  return (
    <>
      <div>
        <label className="section-label" htmlFor={`${idPrefix}-label`}>
          What&apos;s hurt?
        </label>
        <input
          id={`${idPrefix}-label`}
          name="label"
          required
          maxLength={120}
          placeholder="e.g. Right shoulder"
          className="input mt-1 w-full"
          data-testid="injury-label-input"
          value={draft.label}
          onChange={(e) => onChange({ label: e.target.value })}
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
                checked={draft.regions.includes(r)}
                onChange={() => onChange({ regions: toggle(draft.regions, r) })}
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
          Pick patterns if only some movements are affected. Naming movements
          keeps the rest of the region in your suggestions.
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
                checked={draft.movements.includes(m)}
                onChange={() =>
                  onChange({ movements: toggle(draft.movements, m) })
                }
              />
              {MOVEMENT_PATTERN_LABEL[m]}
            </label>
          ))}
        </div>
      </fieldset>
      <InjuryExercisePicker
        liftOptions={liftOptions}
        picked={draft.exercises}
        onPicked={(exercises) => onChange({ exercises })}
      />
      <div>
        <label className="section-label" htmlFor={`${idPrefix}-laterality`}>
          Side (optional)
        </label>
        <select
          id={`${idPrefix}-laterality`}
          name="laterality"
          className="input mt-1 w-full"
          data-testid="injury-laterality"
          value={draft.laterality}
          onChange={(e) =>
            onChange({ laterality: e.target.value as InjuryLaterality | "" })
          }
        >
          <option value="">Not specified</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
          <option value="bilateral">Both sides</option>
        </select>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Recorded and shown. Suggestions are picked per exercise, not per side,
          so on a two-sided lift we say the constraint applies to the whole lift
          rather than pretending we worked around it.
        </p>
      </div>
      {children}
      <div>
        <label className="section-label" htmlFor={`${idPrefix}-load-factor`}>
          While recovering, ease to (optional)
        </label>
        <select
          id={`${idPrefix}-load-factor`}
          name="loadFactor"
          className="input mt-1 w-full"
          data-testid="injury-load-factor-input"
          value={draft.loadFactor}
          onChange={(e) => onChange({ loadFactor: e.target.value })}
        >
          {loadFactorOptions(draft.loadFactor).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Our 60% is a conservative default, not a recommendation about your
          recovery. Your setting always wins.
        </p>
      </div>
      <div>
        <label className="section-label" htmlFor={`${idPrefix}-review-date`}>
          Remind me to revisit (optional)
        </label>
        <DateField
          id={`${idPrefix}-review-date`}
          name="reviewDate"
          data-testid="injury-review-date"
          value={draft.reviewDate}
          onChange={(v) => onChange({ reviewDate: v })}
        />
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          We&apos;ll ask whether it&apos;s still current. We never change it for
          you.
        </p>
      </div>
    </>
  );
}

// The one-tap quick-log form: the shared scope fields plus the STATUS a new injury is born
// with (an existing one's status is the chip's lifecycle buttons, never restated here).
function LogInjuryForm({
  liftOptions,
  onDone,
}: {
  liftOptions: string[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<ScopeDraft>(blankDraft);
  const patch = (p: Partial<ScopeDraft>) => setDraft((d) => ({ ...d, ...p }));

  return (
    <form
      action={async (fd) => {
        await logInjury(fd);
        onDone();
      }}
      className="mt-4 space-y-3 rounded-lg border border-black/5 p-3 dark:border-white/10"
      data-testid="injury-form"
    >
      <InjuryScopeFields
        idPrefix="injury"
        liftOptions={liftOptions}
        draft={draft}
        onChange={patch}
      >
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
            <option value="active">Active — set the affected work aside</option>
            <option value="recovering">
              Recovering — ease back at lighter loads
            </option>
          </select>
        </div>
      </InjuryScopeFields>
      <div className="flex items-center gap-2">
        <SubmitButton pendingLabel="Saving…" data-testid="injury-submit">
          Log injury
        </SubmitButton>
        <button type="button" onClick={onDone} className="btn-ghost">
          Cancel
        </button>
      </div>
    </form>
  );
}

// How many changed lifts the disclosure names before it counts the rest.
const CHANGE_PREVIEW = 6;

function previewNames(names: string[]): string {
  const shown = names.slice(0, CHANGE_PREVIEW).join(", ");
  const rest = names.length - CHANGE_PREVIEW;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

// Correcting an existing injury's SCOPE (#2297) — the gap #2199 surfaced: every level of
// the scope model was settable at log time and none of them was changeable afterwards, so
// a constraint logged broadly on day one stayed broad, and the only ways out were to keep
// excluding lifts that are fine or to delete and re-log (losing the start date and the
// history).
//
// What it edits is the DECLARATION: the label, the regions/movements/lifts, the side, the
// recovery load preference and the review date. What it does NOT edit is the LIFECYCLE —
// the status has the chip's own Recovering/Resolve buttons, and `since` is history rather
// than a correction (narrowing a scope says "I understand this better now"; moving a start
// date says the injury began on a different day, which is a different gesture with
// different consequences for everything dated against it). Both, plus the fine muscle list
// and the notes this form has no control for, are round-tripped verbatim so a scope
// correction cannot quietly rewrite them — `updateInjury` writes the whole row, so a field
// the form omits is a field the form CLEARS.
function EditInjuryForm({
  injury,
  liftOptions,
  onDone,
}: {
  injury: InjuryView;
  liftOptions: string[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<ScopeDraft>(() => draftOf(injury));
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<ScopeDraft>) => setDraft((d) => ({ ...d, ...p }));

  // What saving would change, over the lifts this profile actually trains, resolved
  // through the same precedence the engine applies. Narrowing re-permits lifts the
  // constraint was excluding — the user's intent, but shown rather than assumed (the
  // disclosure answer #2199 gave the precedence override, not a second pattern).
  const change = useMemo(
    () =>
      scopeChange(
        injury,
        {
          regions: draft.regions,
          movements: draft.movements,
          exercises: draft.exercises,
          laterality: draft.laterality || null,
          muscles: injury.muscles,
        },
        liftOptions
      ),
    [injury, draft, liftOptions]
  );

  return (
    <form
      action={async (fd) => {
        const res = await updateInjury(fd);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onDone();
      }}
      className="mt-2 w-full space-y-3 rounded-lg border border-black/5 p-3 dark:border-white/10"
      data-testid="injury-edit-form"
    >
      <input type="hidden" name="id" value={injury.id} />
      {/* The lifecycle, the start date, the notes and the fine muscles are NOT
          round-tripped here (#2359). `updateInjury` sends a partial and the write
          core leaves an unnamed column alone, so this form carries only what it
          edits — and a column added to the injury row later cannot be silently
          cleared by a scope edit that never heard of it. */}
      <InjuryScopeFields
        idPrefix={`injury-edit-${injury.id}`}
        liftOptions={liftOptions}
        draft={draft}
        onChange={patch}
      />
      {(change.released.length > 0 || change.added.length > 0) && (
        <p
          className="text-xs text-slate-600 dark:text-slate-300"
          data-testid="injury-edit-change"
        >
          Saving changes what this covers.{" "}
          {change.released.length > 0 && (
            <span data-testid="injury-edit-released">
              Back in your suggestions: {previewNames(change.released)}.{" "}
            </span>
          )}
          {change.added.length > 0 && (
            <span data-testid="injury-edit-added">
              Newly set aside: {previewNames(change.added)}.
            </span>
          )}
        </p>
      )}
      {error && (
        <p
          className="text-xs text-rose-600 dark:text-rose-400"
          data-testid="injury-edit-error"
        >
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <SubmitButton pendingLabel="Saving…" data-testid="injury-edit-submit">
          Save changes
        </SubmitButton>
        <button type="button" onClick={onDone} className="btn-ghost">
          Cancel
        </button>
      </div>
    </form>
  );
}

// The FINEST level of the #2024 precedence — "these lifts", not "this pattern" or "this
// region" (issue #2199). Its two siblings above are chip groups because their vocabularies
// are 7 and 4 entries; the lift vocabulary is the whole catalog plus this profile's custom
// lifts, so it is the SAME search-and-chip shape every other exercise picker in the app
// uses: the shared Combobox over the frequency-ranked `liftOptions` (as in the routine
// builder's slot candidates), picks accumulating as removable chips (as in the protocol
// outcome picker), and one hidden `exercises` input per chip — the multi-valued field
// `logInjury`/`updateInjury` already read.
//
// A pick is collapsed to its BASE name before it becomes a chip, because that is the
// identity the constraint is stored and matched under: `exerciseHistoryKey` folds
// "Dumbbell Curl" onto "curl", so a chip reading "Dumbbell Curl" would promise a precision
// the engine cannot keep. The chip says "Curl" — the lift the constraint actually covers.
//
// The picks live in the owning form's draft (#2297) so an edit can start from what was
// saved and the change disclosure can read the pending value.
function InjuryExercisePicker({
  liftOptions,
  picked,
  onPicked,
}: {
  liftOptions: string[];
  picked: string[];
  onPicked: (picked: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const pickedKeys = new Set(picked.map(exerciseHistoryKey));
  const available = liftOptions.filter(
    (name) => !pickedKeys.has(exerciseHistoryKey(name))
  );
  // The vocabulary this profile already has: the catalog plus their own logged customs.
  // A typed name outside it is genuinely new, and the free-text row says so.
  const knownKeys = new Set(liftOptions.map(exerciseHistoryKey));

  function add(raw: string) {
    const name = baseLiftName(raw.trim()).trim();
    const key = exerciseHistoryKey(name);
    setQuery("");
    if (!key || pickedKeys.has(key)) return;
    onPicked([...picked, name]);
  }

  return (
    <fieldset data-testid="injury-exercise-picker">
      <legend className="section-label">
        Narrow it further (optional) — specific lifts
      </legend>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        Search the lifts you log. This is the most precise level: name a lift
        and only that lift is affected — the rest of the movement, and the rest
        of the region, stay in your suggestions.
      </p>
      {picked.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {picked.map((name) => (
            <span
              key={name}
              data-testid="injury-exercise-chip"
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300"
            >
              <span className="truncate">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                title="Remove lift"
                onClick={() => onPicked(picked.filter((x) => x !== name))}
                className="text-brand-500 hover:text-rose-500"
              >
                <IconX className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* The submitted field. Names, not keys: the action canonicalizes through
          exerciseHistoryKey at the request boundary, so the form never has to. */}
      {picked.map((name) => (
        <input key={name} type="hidden" name="exercises" value={name} />
      ))}
      <div className="mt-1.5">
        <Combobox
          value={query}
          onChange={setQuery}
          onPick={add}
          options={available}
          allowFreeText
          ariaLabel="Add an affected lift"
          placeholder="Search or type a lift…"
          // The row shows the COLLAPSED name, so a typed "Dumbbell Curl" reads back as
          // the "Curl" the constraint will actually be recorded against before the user
          // commits to it — never a variant the identity can't keep apart.
          freeTextLabel={(q) => {
            const name = baseLiftName(q.trim()).trim();
            return knownKeys.has(exerciseHistoryKey(name)) ? (
              <>Use “{name}”</>
            ) : (
              <>Use “{name}” (custom lift)</>
            );
          }}
        />
      </div>
      {picked.length > 0 && (
        <p
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
          data-testid="injury-exercise-precedence"
        >
          While specific lifts are named, they are what the constraint covers.
          The regions and movements above still describe the injury; they
          aren&apos;t applied on their own.
        </p>
      )}
    </fieldset>
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
