"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import PageContainer from "@/components/PageContainer";
import FitnessTestTimer from "@/components/activity-form/FitnessTestTimer";
import { formatPercentile } from "@/lib/fitness-norms";
import type { WeightUnit } from "@/lib/settings";
import type { FitnessTestDef, Vo2MethodDef } from "@/lib/fitness-battery";
import type {
  FitnessCheckModel,
  FitnessTestResult,
} from "@/lib/fitness-check-model";
import { saveFitnessTest, setFitnessCadence } from "./fitness-actions";

const TIER_LABEL: Record<string, string> = {
  norms: "Percentile",
  standard: "Strength standard",
  evidence: "Evidence",
  body: "Body",
  "self-trend": "Your trend",
};

const DOMAIN_LABEL: Record<string, string> = {
  endurance: "Endurance",
  strength: "Strength",
  balance: "Balance",
  flexibility: "Flexibility",
  mobility: "Mobility",
  body: "Body composition",
};

// The core barbell lifts the big-lift test offers (all carry strength standards).
const BIG_LIFTS = [
  "Back Squat",
  "Front Squat",
  "Bench Press",
  "Deadlift",
  "Overhead Press",
];

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
  const byKey = new Map(model.results.map((r) => [r.key, r]));

  return (
    <PageContainer width="reading" data-testid="fitness-check">
      <div className="space-y-4">
        <header className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Fitness check</h2>
            <span
              data-testid="fitness-completion"
              className="text-sm text-slate-500 dark:text-slate-400"
            >
              {model.measuredCount} of {model.totalCount} measured
              {model.latestDate ? ` · last ${model.latestDate}` : ""}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            A guided battery you perform and enter in one session. Scores feed your
            existing fitness age and healthspan pillars — no new overall score.
            {senior ? " Showing the older-adult variant." : ""}
          </p>
          {model.headlineFitnessAge && (
            <p className="mt-2 text-sm">
              <span className="font-medium">Fitness age (from VO2):</span>{" "}
              {model.headlineFitnessAge.fitnessAge}
            </p>
          )}
          {!hasSexAndAge && (
            <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
              Set your sex and birthdate in Profile settings to see percentiles and
              fitness age.
            </p>
          )}
        </header>

        {model.domains.some((d) => d.percentile != null) && (
          <section className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <h3 className="mb-2 text-sm font-semibold">By domain</h3>
            <div className="space-y-2">
              {model.domains.map((d) => (
                <div key={d.domain} data-testid={`fitness-domain-${d.domain}`}>
                  <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
                    <span>{DOMAIN_LABEL[d.domain] ?? d.domain}</span>
                    <span>
                      {d.percentile != null
                        ? `${d.percentile}th pct`
                        : `${d.measuredCount}/${d.totalCount}`}
                    </span>
                  </div>
                  <div className="mt-0.5 h-2 rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className="h-2 rounded-full bg-brand-500"
                      style={{ width: `${d.percentile ?? 0}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <RetestCadence cadenceDays={cadenceDays} />

        <div className="space-y-3">
          {tests.map((def) => (
            <TestCard
              key={def.key}
              def={def}
              result={byKey.get(def.key)!}
              vo2Methods={vo2Methods}
              weightUnit={weightUnit}
              dateISO={dateISO}
              equipmentNames={equipmentNames}
            />
          ))}
        </div>
      </div>
    </PageContainer>
  );
}

function RetestCadence({ cadenceDays }: { cadenceDays: number }) {
  const router = useRouter();
  const [days, setDays] = useState(String(cadenceDays));
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700"
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
      {saved && <span className="text-emerald-600 dark:text-emerald-400">Saved</span>}
    </form>
  );
}

function TestCard({
  def,
  result,
  vo2Methods,
  weightUnit,
  dateISO,
  equipmentNames,
}: {
  def: FitnessTestDef;
  result: FitnessTestResult;
  vo2Methods: Vo2MethodDef[];
  weightUnit: WeightUnit;
  dateISO: string;
  equipmentNames: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Field state (only the fields this input kind uses are read on submit).
  const [value, setValue] = useState("");
  const [method, setMethod] = useState<string>(vo2Methods[0]?.key ?? "watch");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [lift, setLift] = useState(BIG_LIFTS[0]);

  const setField = (k: string, v: string) =>
    setFields((f) => ({ ...f, [k]: v }));

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
    setOpen(false);
    router.refresh();
  }

  return (
    <div
      className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"
      data-testid={`fitness-test-${def.key}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{def.label}</span>
          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {TIER_LABEL[def.tier] ?? def.tier}
          </span>
        </div>
        <ResultBadge result={result} />
      </div>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-2 text-sm text-brand-600 hover:underline dark:text-brand-400"
        data-testid={`fitness-test-toggle-${def.key}`}
      >
        {result.measured ? "Update" : "Record"} · {open ? "hide" : "how to"}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            {def.instructions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {def.interpretation && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {def.interpretation}
            </p>
          )}
          {missingEquipment && def.equipment && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              No {def.equipment.needs} in your equipment. {def.equipment.substitute}
            </p>
          )}

          <form onSubmit={submit} className="space-y-2">
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
                  <NumField label="VO2 Max (mL/kg/min)" k="watchValue" fields={fields} setField={setField} testKey={def.key} />
                )}
                {method === "cooper" && (
                  <NumField label="Distance (meters)" k="distanceMeters" fields={fields} setField={setField} testKey={def.key} />
                )}
                {method === "rockport" && (
                  <>
                    <NumField label="Walk time (minutes)" k="walkTimeMin" fields={fields} setField={setField} testKey={def.key} />
                    <NumField label="Finish heart rate (bpm)" k="walkHr" fields={fields} setField={setField} testKey={def.key} />
                  </>
                )}
                {method === "step" && (
                  <NumField label="Recovery heart rate (bpm)" k="stepRecoveryHr" fields={fields} setField={setField} testKey={def.key} />
                )}
              </div>
            )}

            {def.inputKind === "hrr" && (
              <>
                <NumField label="Peak heart rate (bpm)" k="peakHr" fields={fields} setField={setField} testKey={def.key} />
                <NumField label="Heart rate after 1 minute (bpm)" k="oneMinuteHr" fields={fields} setField={setField} testKey={def.key} />
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
                  {BIG_LIFTS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <NumField label={`Weight (${weightUnit})`} k="weight" fields={fields} setField={setField} testKey={def.key} />
                <NumField label="Reps" k="reps" fields={fields} setField={setField} testKey={def.key} />
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
      )}
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

function ResultBadge({ result }: { result: FitnessTestResult }) {
  if (!result.measured) {
    return (
      <span className="text-xs text-slate-400 dark:text-slate-500">not measured</span>
    );
  }
  return (
    <div className="text-right text-sm" data-testid={`fitness-result-${result.key}`}>
      <span className="font-medium">
        {result.value} {result.unit}
      </span>
      {result.percentile && (
        <span className="ml-2 text-slate-500 dark:text-slate-400">
          {formatPercentile(result.percentile)}
        </span>
      )}
      {result.standing && (
        <span className={`ml-2 ${result.standing.color}`}>{result.standing.label}</span>
      )}
      {result.delta != null && result.delta !== 0 && (
        <span
          className={`ml-2 ${
            result.improved
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
          data-testid={`fitness-delta-${result.key}`}
        >
          {result.delta > 0 ? "+" : ""}
          {result.delta} vs last
        </span>
      )}
    </div>
  );
}
