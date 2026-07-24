"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import FitnessTestTimer from "@/components/activity-form/FitnessTestTimer";
import FitnessDomainBars from "@/components/FitnessDomainBars";
import { TONE_TILE } from "@/components/fitness-heat";
import {
  FitnessDomainGlyph,
  FitnessPictogram,
} from "@/components/fitness-pictograms";
import { useToast } from "@/components/Toast";
import { Notice } from "@/components/Notice";
import type { WeightUnit } from "@/lib/settings";
import {
  BIG_LIFT_OPTIONS,
  type FitnessTestDef,
  type Vo2MethodDef,
} from "@/lib/fitness-battery";
import type { FitnessCheckModel } from "@/lib/fitness-check-model";
import { buildFitnessTiles, type FitnessTile } from "@/lib/fitness-tile";
import type {
  FitnessOutcome,
  BatteryCompletionSummary,
} from "@/lib/fitness-outcome";
import {
  saveFitnessTest,
  setFitnessCadence,
  type SaveFitnessTestResult,
} from "./fitness-actions";

// Whether the viewer asked for reduced motion — gates the tile's landing sweep (#1307).
// Read after mount (SSR-safe); Playwright's reducedMotion context option flips it.
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

const DOMAIN_LABEL: Record<string, string> = {
  endurance: "Endurance",
  strength: "Strength",
  balance: "Balance",
  flexibility: "Flexibility",
  mobility: "Mobility",
  body: "Body",
};

export default function FitnessCheckView({
  tests,
  model,
  vo2Methods,
  cadenceDays,
  weightUnit,
  dateISO,
  senior,
  hasSexAndAge,
  equipmentNames,
}: {
  tests: FitnessTestDef[];
  model: FitnessCheckModel;
  vo2Methods: Vo2MethodDef[];
  cadenceDays: number;
  weightUnit: WeightUnit;
  dateISO: string;
  senior: boolean;
  hasSexAndAge: boolean;
  equipmentNames: string[];
}) {
  const byKey = new Map(tests.map((t) => [t.key, t]));
  const tiles = buildFitnessTiles(model.results);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openDef = openKey ? byKey.get(openKey) : null;
  const openTile = openKey
    ? (tiles.find((t) => t.key === openKey) ?? null)
    : null;
  const toast = useToast();
  const reduceMotion = usePrefersReducedMotion();
  // The battery-completion finale (#1307), shown once the last outstanding test lands, and
  // the just-saved test key that gets the landing sweep. Both set from the action's typed
  // result on save; the finale card is dismissible.
  const [finale, setFinale] = useState<BatteryCompletionSummary | null>(null);
  const [justSavedKey, setJustSavedKey] = useState<string | null>(null);

  // One handler for a successful save (#1305/#1307): toast the closure acknowledgment (the
  // first save of a new check), stash the completion finale, and mark the tile to animate.
  function onSaved(
    result: Extract<SaveFitnessTestResult, { ok: true }>,
    key: string
  ) {
    if (result.closureToast) toast(result.closureToast);
    setFinale(result.finale);
    setJustSavedKey(key);
  }

  return (
    <PageContainer width="full" data-testid="fitness-check">
      <div className="space-y-4">
        <header className="rounded-xl border border-black/10 p-4 dark:border-white/10">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Fitness check</h2>
            <span
              data-testid="fitness-completion"
              className="text-sm text-slate-500 dark:text-slate-400"
            >
              {model.measuredCount} of {model.totalCount} with a recent value
              {model.latestDate ? ` · last check ${model.latestDate}` : ""}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            An at-a-glance board of your whole battery — green is favorable, red
            wants attention, grey isn&apos;t measured yet. Tiles auto-count a
            recent value you synced or logged; tap any square to record or
            update it. Scores feed your existing fitness age and healthspan
            pillars.
            {senior ? " Showing the older-adult variant." : ""}
          </p>
          {model.headlineFitnessAge && (
            <p className="mt-2 text-sm" data-testid="fitness-age">
              <span className="font-medium">Fitness age (from VO2):</span>{" "}
              {model.headlineFitnessAge.fitnessAge}
            </p>
          )}
          {!hasSexAndAge && (
            <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
              Set your sex and birthdate in Profile settings to see percentiles
              and fitness age.
            </p>
          )}
        </header>

        {finale && (
          <CompletionCard finale={finale} onDismiss={() => setFinale(null)} />
        )}

        {model.domains.some((d) => d.percentile != null) && (
          <section className="rounded-xl border border-black/10 p-4 dark:border-white/10">
            <h3 className="mb-2 text-sm font-semibold">By domain</h3>
            <FitnessDomainBars domains={model.domains} />
          </section>
        )}

        <RetestCadence cadenceDays={cadenceDays} />

        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
          data-testid="fitness-grid"
        >
          {tiles.map((tile) => (
            <Tile
              key={tile.key}
              tile={tile}
              def={byKey.get(tile.key)!}
              equipmentNames={equipmentNames}
              onOpen={() => setOpenKey(tile.key)}
              // The landing sweep on the just-saved tile — the success cue on the element
              // that keeps the memory. Suppressed under prefers-reduced-motion (#1307).
              landing={tile.key === justSavedKey && !reduceMotion}
            />
          ))}
        </div>
      </div>

      {openDef && openTile && (
        <EntryModal
          def={openDef}
          tile={openTile}
          vo2Methods={vo2Methods}
          weightUnit={weightUnit}
          dateISO={dateISO}
          equipmentNames={equipmentNames}
          onSaved={onSaved}
          onClose={() => setOpenKey(null)}
        />
      )}
    </PageContainer>
  );
}

// The battery-completion finale (#1307) — factual, from the model's fitness age + per-test
// deltas. No confetti-science; the numbers are the celebration. Dismissible.
function CompletionCard({
  finale,
  onDismiss,
}: {
  finale: BatteryCompletionSummary;
  onDismiss: () => void;
}) {
  const parts: string[] = [];
  if (finale.improved > 0) parts.push(`${finale.improved} improved`);
  if (finale.declined > 0) parts.push(`${finale.declined} declined`);
  if (finale.fresh > 0) parts.push(`${finale.fresh} new`);
  return (
    <Notice
      tone="emerald"
      testid="fitness-completion-summary"
      title="Check complete"
      action={
        <button
          type="button"
          onClick={onDismiss}
          data-testid="fitness-completion-dismiss"
          className="text-xs font-medium hover:underline"
        >
          Dismiss
        </button>
      }
    >
      <p aria-live="polite">
        {finale.fitnessAge != null && (
          <span data-testid="fitness-completion-age">
            Fitness age <strong>{finale.fitnessAge}</strong>
            {finale.priorFitnessAge != null &&
            finale.priorFitnessAge !== finale.fitnessAge
              ? ` (was ${finale.priorFitnessAge})`
              : ""}
          </span>
        )}
        {finale.fitnessAge != null && parts.length > 0 ? " · " : ""}
        {parts.join(" · ")}
      </p>
    </Notice>
  );
}

function RetestCadence({ cadenceDays }: { cadenceDays: number }) {
  const router = useRouter();
  const [days, setDays] = useState(String(cadenceDays));
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-xl border border-black/10 p-3 text-sm dark:border-white/10"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData();
        fd.set("days", days);
        const r = await setFitnessCadence(fd);
        if (r.ok) {
          setSaved(true);
          router.refresh();
        }
      }}
    >
      <label htmlFor="fitness-cadence">Remind me to re-check every</label>
      <input
        id="fitness-cadence"
        name="days"
        type="number"
        min={1}
        value={days}
        onChange={(e) => {
          setDays(e.target.value);
          setSaved(false);
        }}
        className="input w-20"
      />
      <span>days</span>
      <button type="submit" className="btn-secondary h-9 px-3">
        Save
      </button>
      {saved && (
        <span className="text-emerald-600 dark:text-emerald-400">Saved</span>
      )}
    </form>
  );
}

// One square tile — colored by favorability, carrying the value + tier-appropriate overlay
// marker, the provenance/stale chip (#1129), the rough-guide tag (#1135), and an
// equipment-missing hint. Tapping opens the entry modal.
function Tile({
  tile,
  def,
  equipmentNames,
  onOpen,
  landing = false,
}: {
  tile: FitnessTile;
  def: FitnessTestDef;
  equipmentNames: string[];
  onOpen: () => void;
  landing?: boolean;
}) {
  const missingEquipment =
    def.equipment != null &&
    !equipmentNames.some((n) => n.includes(def.equipment!.needs.toLowerCase()));

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`fitness-tile-${tile.key}`}
      data-tone={tile.tone}
      data-basis={tile.basis}
      data-landing={landing ? "true" : undefined}
      className={`relative flex aspect-square flex-col justify-between rounded-xl border p-3 text-left transition-[background-color,border-color,color,transform] duration-500 hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
        TONE_TILE[tile.tone]
      } ${tile.stale ? "opacity-60 grayscale-[0.4]" : ""} ${
        landing ? "fitness-tile-land" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="flex min-w-0 items-start gap-1.5">
          {/* Decorative per-test figure (#1253) — currentColor, so the tile's tone
              and the stale treatment color it; the text label stays the name. */}
          <FitnessPictogram
            testKey={tile.key}
            className="h-6 w-6 shrink-0 opacity-80 sm:h-7 sm:w-7"
          />
          <span className="text-sm font-semibold leading-tight">
            {tile.label}
          </span>
        </div>
        {/* Below sm the chip collapses to its glyph + a title, with the text kept
            for AT (sr-only) — the 2-col tiles are too narrow for glyph AND text. */}
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded bg-black/5 px-1 py-0.5 text-xs uppercase tracking-wide opacity-70 dark:bg-white/10"
          title={DOMAIN_LABEL[tile.domain] ?? tile.domain}
        >
          <FitnessDomainGlyph domain={tile.domain} className="h-3 w-3" />
          <span className="sr-only sm:not-sr-only">
            {DOMAIN_LABEL[tile.domain] ?? tile.domain}
          </span>
        </span>
      </div>

      <div className="min-w-0">
        {tile.measured ? (
          <>
            <div className="truncate text-lg font-bold leading-none">
              {tile.value}
              <span className="ml-1 text-xs font-normal opacity-70">
                {tile.unit}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="font-medium">{tile.overlay}</span>
              {tile.deltaArrow && tile.delta != null && (
                <span
                  data-testid={`fitness-delta-${tile.key}`}
                  className={
                    tile.deltaArrow === "up"
                      ? "text-emerald-700 dark:text-emerald-300"
                      : "text-rose-700 dark:text-rose-300"
                  }
                >
                  {tile.deltaArrow === "up" ? "▲" : "▼"}
                  {tile.delta > 0 ? "+" : ""}
                  {tile.delta}
                </span>
              )}
            </div>
            {tile.roughGuide && (
              <span
                data-testid={`fitness-rough-${tile.key}`}
                className="mt-1 inline-block rounded bg-black/10 px-1 py-0.5 text-xs dark:bg-white/15"
              >
                rough guide
              </span>
            )}
            {tile.provenance && (
              <div
                data-testid={`fitness-provenance-${tile.key}`}
                className="mt-1 truncate text-xs opacity-75"
              >
                {tile.provenance.label}
                {tile.provenance.ageDays != null && tile.provenance.ageDays > 0
                  ? ` · ${tile.provenance.ageDays}d ago`
                  : ""}
                {tile.stale ? " · re-check" : ""}
              </div>
            )}
          </>
        ) : (
          <div
            className="text-xs opacity-70"
            data-testid={`fitness-unmeasured-${tile.key}`}
          >
            {missingEquipment ? "no equipment" : "not measured"}
          </div>
        )}
      </div>
    </button>
  );
}

// The entry modal (desktop dialog / mobile sheet): instructions + the tier's input(s) +
// the equipment substitute + the current provenance, over the unchanged saveFitnessTest
// write path.
function EntryModal({
  def,
  tile,
  vo2Methods,
  weightUnit,
  dateISO,
  equipmentNames,
  onSaved,
  onClose,
}: {
  def: FitnessTestDef;
  tile: FitnessTile;
  vo2Methods: Vo2MethodDef[];
  weightUnit: WeightUnit;
  dateISO: string;
  equipmentNames: string[];
  onSaved: (
    result: Extract<SaveFitnessTestResult, { ok: true }>,
    key: string
  ) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState("");
  const [method, setMethod] = useState<string>(vo2Methods[0]?.key ?? "watch");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [lift, setLift] = useState<string>(BIG_LIFT_OPTIONS[0]);
  // The in-place outcome moment (#1307): on a successful save the form is replaced by the
  // computed outcome (percentile/band/delta) until the user taps Done, which refreshes the
  // board and closes. A null-outcome save (a self-trend residue) closes straight away.
  const [outcome, setOutcome] = useState<FitnessOutcome | null>(null);
  const [saved, setSaved] = useState(false);

  function done() {
    onClose();
    router.refresh();
  }

  const setField = (k: string, v: string) =>
    setFields((f) => ({ ...f, [k]: v }));

  // After a countdown timer ends, flip focus to the result input the user now fills (reps /
  // distance / recovery HR) — scoped to this open modal by its data-testid (#1275).
  const focusTestId = (tid: string) => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLInputElement>(`[data-testid="${tid}"]`)
        ?.focus();
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes; once an outcome is showing, closing also refreshes the board.
      if (e.key === "Escape") {
        if (saved) done();
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, saved]);

  const missingEquipment =
    def.equipment != null &&
    !equipmentNames.some((n) => n.includes(def.equipment!.needs.toLowerCase()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const fd = new FormData();
    fd.set("testKey", def.key);
    fd.set("date", dateISO);
    if (def.inputKind === "vo2") {
      fd.set("method", method);
      for (const [k, v] of Object.entries(fields)) if (v) fd.set(k, v);
    } else if (def.inputKind === "hrr") {
      for (const [k, v] of Object.entries(fields)) if (v) fd.set(k, v);
    } else if (def.inputKind === "e1rm") {
      fd.set("lift", lift);
      fd.set("weight", fields.weight ?? "");
      fd.set("reps", fields.reps ?? "");
    } else {
      fd.set("value", value);
    }
    const r = await saveFitnessTest(fd);
    setPending(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    // Fire the parent's toast/finale/animation immediately, then present the in-place
    // outcome moment. A save with no measurable outcome (self-trend) closes straight away.
    onSaved(r, def.key);
    if (r.outcome) {
      setOutcome(r.outcome);
      setSaved(true);
    } else {
      done();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={saved ? done : onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={def.label}
        data-testid={`fitness-entry-${def.key}`}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-black/10 bg-white p-4 shadow-xl dark:border-white/10 dark:bg-slate-900 sm:rounded-2xl"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {/* The same figure as the tile — one keyed lookup, no second mapping. */}
            <FitnessPictogram
              testKey={def.key}
              className="h-8 w-8 shrink-0 text-slate-500 dark:text-slate-400"
            />
            <h3 className="text-base font-semibold">{def.label}</h3>
          </div>
          <button
            type="button"
            onClick={saved ? done : onClose}
            className="text-sm text-slate-500 hover:underline dark:text-slate-400"
            data-testid={`fitness-close-${def.key}`}
          >
            Close
          </button>
        </div>

        {saved && outcome ? (
          <OutcomePanel outcome={outcome} onDone={done} testKey={def.key} />
        ) : (
          renderForm()
        )}
      </div>
    </div>
  );

  // Rendered inline (a plain function, not a `<Component/>`) so the timer + input state
  // never remount on a parent re-render — a new component identity each render would reset
  // the field-test timer mid-run.
  function renderForm() {
    return (
      <>
        {tile.measured && tile.provenance && (
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Current: {tile.value} {tile.unit} · {tile.provenance.label}
            {tile.provenance.date ? ` (${tile.provenance.date})` : ""}
            {tile.stale ? " — re-check due" : ""}
          </p>
        )}
        {tile.roughGuide && tile.selfNormCitation && (
          <p
            className="mb-2 text-xs italic text-slate-500 dark:text-slate-400"
            data-testid={`fitness-rough-note-${def.key}`}
          >
            Rough guide only — no validated norms. {tile.selfNormCitation}
          </p>
        )}

        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
          {def.instructions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        {def.interpretation && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {def.interpretation}
          </p>
        )}
        {missingEquipment && def.equipment && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            No {def.equipment.needs} in your equipment.{" "}
            {def.equipment.substitute}
          </p>
        )}

        <form onSubmit={submit} className="mt-3 space-y-2">
          {def.inputKind === "vo2" && (
            <div className="space-y-2">
              <select
                aria-label="VO2 method"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="input"
                data-testid={`fitness-vo2-method-${def.key}`}
              >
                {vo2Methods.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              {method === "watch" && (
                <NumField
                  label="VO2 Max (mL/kg/min)"
                  k="watchValue"
                  fields={fields}
                  setField={setField}
                  testKey={def.key}
                />
              )}
              {method === "cooper" && (
                <NumField
                  label="Distance (meters)"
                  k="distanceMeters"
                  fields={fields}
                  setField={setField}
                  testKey={def.key}
                />
              )}
              {method === "rockport" && (
                <>
                  <NumField
                    label="Walk time (minutes)"
                    k="walkTimeMin"
                    fields={fields}
                    setField={setField}
                    testKey={def.key}
                  />
                  <NumField
                    label="Finish heart rate (bpm)"
                    k="walkHr"
                    fields={fields}
                    setField={setField}
                    testKey={def.key}
                  />
                </>
              )}
              {method === "step" && (
                <NumField
                  label="Recovery heart rate (bpm)"
                  k="stepRecoveryHr"
                  fields={fields}
                  setField={setField}
                  testKey={def.key}
                />
              )}
              {/* Field-test timers (#1275): the Cooper run (720s) / Queens step (180s)
                  count DOWN then focus their result input; the Rockport mile counts UP and
                  fills the walk-time minutes. The watch value has no timing. */}
              {(() => {
                const md = vo2Methods.find((m) => m.key === method);
                if (!md) return null;
                const isRockport = md.key === "rockport";
                if (md.timerWindow == null && !isRockport) return null;
                return (
                  <FitnessTestTimer
                    testId={`fitness-timer-${def.key}-${md.key}`}
                    label={`${def.label} · ${md.label}`}
                    testKey={def.key}
                    window={md.timerWindow}
                    onFinish={(s) => {
                      if (isRockport) {
                        setField(
                          "walkTimeMin",
                          String(Math.round((s / 60) * 100) / 100)
                        );
                        focusTestId(`fitness-field-${def.key}-walkHr`);
                      } else if (md.key === "cooper") {
                        focusTestId(`fitness-field-${def.key}-distanceMeters`);
                      } else if (md.key === "step") {
                        focusTestId(`fitness-field-${def.key}-stepRecoveryHr`);
                      }
                    }}
                  />
                );
              })()}
            </div>
          )}

          {def.inputKind === "hrr" && (
            <>
              <NumField
                label="Peak heart rate (bpm)"
                k="peakHr"
                fields={fields}
                setField={setField}
                testKey={def.key}
              />
              <NumField
                label="Heart rate after 1 minute (bpm)"
                k="oneMinuteHr"
                fields={fields}
                setField={setField}
                testKey={def.key}
              />
            </>
          )}

          {def.inputKind === "e1rm" && (
            <>
              <select
                aria-label="Lift"
                value={lift}
                onChange={(e) => setLift(e.target.value)}
                className="input"
                data-testid={`fitness-lift-${def.key}`}
              >
                {BIG_LIFT_OPTIONS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <NumField
                label={`Weight (${weightUnit})`}
                k="weight"
                fields={fields}
                setField={setField}
                testKey={def.key}
              />
              <NumField
                label="Reps"
                k="reps"
                fields={fields}
                setField={setField}
                testKey={def.key}
              />
            </>
          )}

          {(def.inputKind === "reps" ||
            def.inputKind === "seconds" ||
            def.inputKind === "number") && (
            <>
              <label className="block text-sm">
                <span className="text-slate-600 dark:text-slate-300">
                  {def.label} ({def.unit})
                </span>
                <input
                  name="value"
                  type="number"
                  step="any"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="input mt-0.5"
                  data-testid={`fitness-value-${def.key}`}
                />
              </label>
              {/* Count-up timer for the hold/balance tests: Finish fills the seconds. */}
              {def.inputKind === "seconds" && (
                <FitnessTestTimer
                  testId={`fitness-timer-${def.key}`}
                  label={def.label}
                  testKey={def.key}
                  onFinish={(s) => setValue(String(s))}
                />
              )}
              {/* Countdown timer for the fixed-window rep tests (chair stand, arm curl,
                  2-minute step): auto-ends, then focuses the reps input to fill (#1275). */}
              {def.inputKind === "reps" && def.timerWindow != null && (
                <FitnessTestTimer
                  testId={`fitness-timer-${def.key}`}
                  label={def.label}
                  testKey={def.key}
                  window={def.timerWindow}
                  onFinish={() => focusTestId(`fitness-value-${def.key}`)}
                />
              )}
            </>
          )}

          {error && (
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={pending}
            className="btn disabled:opacity-50"
            data-testid={`fitness-submit-${def.key}`}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </form>
      </>
    );
  }
}

// The in-place outcome moment (#1307): the percentile/band/delta the save earned, shown
// before the board is refreshed. A formatter over the tile VM — never a second computation
// (#221). aria-live so it's announced; Done refreshes the grid and closes.
function OutcomePanel({
  outcome,
  onDone,
  testKey,
}: {
  outcome: FitnessOutcome;
  onDone: () => void;
  testKey: string;
}) {
  return (
    <div className="mt-2 space-y-3" data-testid={`fitness-outcome-${testKey}`}>
      <Notice tone="emerald">
        <div aria-live="polite">
          <div className="text-lg font-bold">
            {outcome.label}{" "}
            <span className="font-semibold">{outcome.valueText}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span
              className="font-medium"
              data-testid={`fitness-outcome-marker-${testKey}`}
            >
              {outcome.marker}
            </span>
            {outcome.deltaText && (
              <span
                data-testid={`fitness-outcome-delta-${testKey}`}
                className={
                  outcome.deltaArrow === "up"
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-rose-700 dark:text-rose-300"
                }
              >
                {outcome.deltaArrow === "up"
                  ? "↑ "
                  : outcome.deltaArrow === "down"
                    ? "↓ "
                    : ""}
                {outcome.deltaText}
              </span>
            )}
            {outcome.roughGuide && (
              <span className="rounded bg-black/10 px-1 py-0.5 text-xs dark:bg-white/15">
                rough guide
              </span>
            )}
          </div>
        </div>
      </Notice>
      <button
        type="button"
        onClick={onDone}
        className="btn"
        data-testid={`fitness-outcome-done-${testKey}`}
      >
        Done
      </button>
    </div>
  );
}

function NumField({
  label,
  k,
  fields,
  setField,
  testKey,
}: {
  label: string;
  k: string;
  fields: Record<string, string>;
  setField: (k: string, v: string) => void;
  testKey: string;
}) {
  return (
    <label className="block text-sm">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <input
        type="number"
        step="any"
        value={fields[k] ?? ""}
        onChange={(e) => setField(k, e.target.value)}
        className="input mt-0.5"
        data-testid={`fitness-field-${testKey}-${k}`}
      />
    </label>
  );
}
