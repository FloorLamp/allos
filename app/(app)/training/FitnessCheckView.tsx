"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import FitnessTestTimer from "@/components/activity-form/FitnessTestTimer";
import FitnessDomainBars from "@/components/FitnessDomainBars";
import { TONE_TILE } from "@/components/fitness-heat";
import type { WeightUnit } from "@/lib/settings";
import {
  BIG_LIFT_OPTIONS,
  type FitnessTestDef,
  type Vo2MethodDef,
} from "@/lib/fitness-battery";
import type { FitnessCheckModel } from "@/lib/fitness-check-model";
import { buildFitnessTiles, type FitnessTile } from "@/lib/fitness-tile";
import { saveFitnessTest, setFitnessCadence } from "./fitness-actions";

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
          onClose={() => setOpenKey(null)}
        />
      )}
    </PageContainer>
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
}: {
  tile: FitnessTile;
  def: FitnessTestDef;
  equipmentNames: string[];
  onOpen: () => void;
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
      className={`relative flex aspect-square flex-col justify-between rounded-xl border p-3 text-left transition hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-brand-500 ${
        TONE_TILE[tile.tone]
      } ${tile.stale ? "opacity-60 grayscale-[0.4]" : ""}`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="text-sm font-semibold leading-tight">
          {tile.label}
        </span>
        <span className="shrink-0 rounded bg-black/5 px-1 py-0.5 text-xs uppercase tracking-wide opacity-70 dark:bg-white/10">
          {DOMAIN_LABEL[tile.domain] ?? tile.domain}
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
  onClose,
}: {
  def: FitnessTestDef;
  tile: FitnessTile;
  vo2Methods: Vo2MethodDef[];
  weightUnit: WeightUnit;
  dateISO: string;
  equipmentNames: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [value, setValue] = useState("");
  const [method, setMethod] = useState<string>(vo2Methods[0]?.key ?? "watch");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [lift, setLift] = useState<string>(BIG_LIFT_OPTIONS[0]);

  const setField = (k: string, v: string) =>
    setFields((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    onClose();
    router.refresh();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
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
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold">{def.label}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:underline dark:text-slate-400"
            data-testid={`fitness-close-${def.key}`}
          >
            Close
          </button>
        </div>

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
              {def.inputKind === "seconds" && (
                <FitnessTestTimer
                  testId={`fitness-timer-${def.key}`}
                  onUse={(s) => setValue(String(s))}
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
      </div>
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
