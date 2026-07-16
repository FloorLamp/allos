"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  startImport,
  commitImportJob,
  discardImportJob,
  type ImportType,
  type ImportJob,
  type ImportResult,
} from "@/app/(app)/data/actions";
import { formatSeconds } from "@/lib/duration";
import { useToast } from "@/components/Toast";
import RelativeTime from "@/components/RelativeTime";
import { IconLoader2, IconAlertTriangle } from "@tabler/icons-react";
import type { ExtractedWorkout } from "@/lib/workout-extract";
import type { WeightUnit } from "@/lib/settings";
import ScrollFade from "@/components/ScrollFade";

// Lightweight client-side guess at what a paste/CSV contains, from its header
// row — used only to preselect the type toggle (the user can override).
function detectType(text: string): ImportType | null {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim());
  if (!firstLine) return null;
  const h = firstLine.toLowerCase();
  const hit = (kws: string[]) =>
    kws.reduce((n, k) => (h.includes(k) ? n + 1 : n), 0);
  const workout = hit([
    "exercise",
    "reps",
    "sets",
    "weight",
    "lift",
    "rpe",
    "1rm",
    "hold",
    "workout",
  ]);
  const bio = hit([
    "marker",
    "analyte",
    "result",
    "unit",
    "reference",
    "range",
    "lab",
    "cholesterol",
    "glucose",
    "hdl",
    "ldl",
    "a1c",
    "vitamin",
    "test",
  ]);
  if (workout === 0 && bio === 0) return null;
  return workout >= bio ? "workouts" : "biomarkers";
}

export default function ImportClient({
  units,
}: {
  units: { weightUnit: WeightUnit };
}) {
  const router = useRouter();
  const toast = useToast();
  const [type, setType] = useState<ImportType>("workouts");
  const [typeTouched, setTypeTouched] = useState(false);
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggested = useMemo(() => detectType(text), [text]);
  // Apply the autodetected type until the user picks one themselves.
  const effectiveType = typeTouched ? type : (suggested ?? type);

  function onText(v: string) {
    setText(v);
    setError(null);
  }

  function pickType(t: ImportType) {
    setType(t);
    setTypeTouched(true);
  }

  // Kick off a background extraction job. Returns immediately; the job then shows
  // below as "Extracting…" and the app-wide poller toasts when it's ready.
  async function startExtract() {
    if (!text.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const r = await startImport(effectiveType, text);
      if (!r.ok) {
        setError(r.error);
        toast(r.error, { tone: "error", duration: null });
        return;
      }
      setText("");
      toast("Extraction started — you’ll be notified when it’s ready.");
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not start.";
      setError(message);
      toast(message, { tone: "error", duration: null });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Paste a CSV or a plain workout / lab log and the AI reads it into
        reviewable rows. To import a spreadsheet or CSV <em>file</em>, use the
        File Upload tab.
      </p>
      {/* Type selector */}
      <div>
        <label className="label">What are you importing?</label>
        <div className="grid grid-cols-2 gap-2">
          {(["workouts", "biomarkers"] as const).map((t) => {
            const active = effectiveType === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => pickType(t)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize transition ${
                  active
                    ? "border-brand-500 bg-brand-500 text-white"
                    : "border-black/10 bg-white text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-300 dark:hover:bg-ink-800"
                }`}
              >
                {t}
              </button>
            );
          })}
        </div>
        {!typeTouched && suggested && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Auto-detected from the header row — tap to override.
          </p>
        )}
      </div>

      {/* Paste */}
      <div>
        <label className="label">Paste CSV or a workout / lab log</label>
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={10}
          placeholder={
            effectiveType === "workouts"
              ? "date,exercise,weight,reps\n2026-06-01,Bench Press,80kg,5\n..."
              : "date,test,result,unit,reference\n2026-06-01,LDL,90,mg/dL,<100\n..."
          }
          className="input font-mono text-xs"
        />
      </div>

      {error && (
        <p className="text-sm text-rose-500 dark:text-rose-400">{error}</p>
      )}

      <button
        type="button"
        onClick={startExtract}
        disabled={!text.trim() || starting}
        className="btn disabled:cursor-not-allowed disabled:opacity-50"
      >
        {starting ? "Starting…" : "Extract with AI"}
      </button>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Extraction runs in the background — you can leave this page and you’ll
        be notified when it’s ready to review.
      </p>
    </div>
  );
}

// The paste-flow review/commit/discard surface: one card per in-flight or
// ready-to-review import job. Rendered below the upload card on the Import page
// so it stays visible regardless of which upload tab is active.
export function ImportJobList({
  jobs,
  unit,
}: {
  jobs: ImportJob[];
  unit: WeightUnit;
}) {
  if (jobs.length === 0) return null;
  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <ImportJobCard key={job.id} job={job} unit={unit} />
      ))}
    </div>
  );
}

// A single async import job: shows its status, and for a 'ready' job lets the
// user expand the extracted preview table and save it (or discard).
function ImportJobCard({ job, unit }: { job: ImportJob; unit: WeightUnit }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<null | "save" | "discard">(null);

  async function save() {
    setPending("save");
    try {
      const r = await commitImportJob(job.id);
      if (!r.ok) {
        toast(r.error, { tone: "error", duration: null });
        return;
      }
      toast(r.message);
      router.refresh();
    } catch {
      // commitImportJob deliberately RETHROWS after reverting the job to 'ready'
      // (good server design) — without this catch the spinner just cleared and
      // the user retried blind (issue #477). Toast the failure; the job row still
      // carries its honest 'ready' state.
      toast("Couldn't save this import. Please try again.", {
        tone: "error",
        duration: null,
      });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  async function discard() {
    setPending("discard");
    try {
      await discardImportJob(job.id);
      router.refresh();
    } catch {
      toast("Couldn't discard this import. Please try again.", {
        tone: "error",
        duration: null,
      });
    } finally {
      setPending(null);
    }
  }

  const label = job.type === "workouts" ? "Workouts" : "Biomarkers";

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-slate-800 dark:text-slate-100">
            {label} import
          </span>
          {job.status === "processing" && (
            <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
              <IconLoader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              Extracting…
            </span>
          )}
          {job.status === "ready" && job.summary && (
            <span className="text-slate-500 dark:text-slate-400">
              {job.summary}
            </span>
          )}
          {(job.status === "failed" || job.status === "skipped") && (
            <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
              <IconAlertTriangle className="h-4 w-4" />
              Extraction {job.status}
            </span>
          )}
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <RelativeTime
            value={job.created_at}
            className="text-slate-500 dark:text-slate-400"
          />
        </div>

        <div className="flex items-center gap-2">
          {job.status === "ready" && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="btn-ghost text-sm"
            >
              {open ? "Hide" : "Review"}
            </button>
          )}
          {job.status !== "processing" && (
            <button
              type="button"
              onClick={discard}
              disabled={pending !== null}
              className="btn-ghost text-sm disabled:opacity-50"
            >
              {pending === "discard" ? "Discarding…" : "Discard"}
            </button>
          )}
        </div>
      </div>

      {(job.status === "failed" || job.status === "skipped") && job.error && (
        <p className="text-sm text-rose-500 dark:text-rose-400">{job.error}</p>
      )}

      {job.status === "ready" && open && job.result && (
        <div className="space-y-3 border-t border-black/10 pt-3 dark:border-white/10">
          {job.result.type === "workouts" ? (
            <WorkoutPreview preview={job.result} unit={unit} />
          ) : (
            <BiomarkerPreview preview={job.result} />
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={save}
              disabled={pending !== null}
              className="btn disabled:opacity-50"
            >
              {pending === "save" ? "Saving…" : "Save to your log"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkoutPreview({
  preview,
  unit,
}: {
  preview: Extract<ImportResult, { type: "workouts" }>;
  unit: WeightUnit;
}) {
  const total = preview.workouts.reduce((n, w) => n + w.sets.length, 0);
  if (preview.workouts.length === 0)
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No workouts found in that input.
      </p>
    );

  // Render one set: a hold time, a per-side "L … · R …", or plain weight × reps.
  const setText = (s: ExtractedWorkout["sets"][number]) => {
    const u = s.weight_unit ?? unit;
    const side = (w: number | null, r: number | null) =>
      `${w != null ? `${w}${u} × ` : ""}${r ?? "–"}`;
    if (s.weight_right != null || s.reps_right != null)
      return `L ${side(s.weight, s.reps)} · R ${side(s.weight_right, s.reps_right)}`;
    if (s.duration_sec != null) return formatSeconds(s.duration_sec);
    return side(s.weight, s.reps);
  };
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
        {preview.workouts.length} workout
        {preview.workouts.length === 1 ? "" : "s"} · {total} set
        {total === 1 ? "" : "s"}
      </h2>
      <ScrollFade className="mt-2">
        <table className="w-full text-left text-sm">
          <thead className="section-label">
            <tr>
              <th className="py-1 pr-3">Date</th>
              <th className="py-1 pr-3">Exercise</th>
              <th className="py-1 pr-3">Set</th>
              <th className="py-1 pr-3">Equipment</th>
              <th className="py-1 pr-3">Notes</th>
            </tr>
          </thead>
          <tbody className="text-slate-600 dark:text-slate-300">
            {preview.workouts.map((w, i) =>
              w.sets.map((s, j) => (
                <tr
                  key={`${i}-${j}`}
                  className={
                    // Group workouts visually: a divider begins each one, and the
                    // date/notes print only on its first set row (like the source).
                    j === 0
                      ? "border-t border-black/10 dark:border-white/10"
                      : ""
                  }
                >
                  <td className="whitespace-nowrap py-1 pr-3 align-top text-slate-500 dark:text-slate-400">
                    {j === 0 ? w.date || "(no date)" : ""}
                  </td>
                  <td className="py-1 pr-3 align-top">{s.exercise}</td>
                  <td className="py-1 pr-3 align-top tabular-nums">
                    {setText(s)}
                  </td>
                  <td className="py-1 pr-3 align-top text-slate-500 dark:text-slate-400">
                    {s.equipment ?? ""}
                  </td>
                  <td className="py-1 pr-3 align-top text-slate-500 dark:text-slate-400">
                    {j === 0 ? (w.notes ?? "") : ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollFade>
    </div>
  );
}

function BiomarkerPreview({
  preview,
}: {
  preview: Extract<ImportResult, { type: "biomarkers" }>;
}) {
  if (preview.results.length === 0)
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No biomarkers found in that input.
      </p>
    );
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
        {preview.results.length} reading
        {preview.results.length === 1 ? "" : "s"}
      </h2>
      <ScrollFade className="mt-2">
        <table className="w-full text-left text-sm">
          <thead className="section-label">
            <tr>
              <th className="py-1 pr-3">Name</th>
              <th className="py-1 pr-3">Value</th>
              <th className="py-1 pr-3">Unit</th>
              <th className="py-1 pr-3">Reference</th>
              <th className="py-1 pr-3">Flag</th>
            </tr>
          </thead>
          <tbody className="text-slate-600 dark:text-slate-300">
            {preview.results.map((r, i) => (
              <tr
                key={i}
                className="border-t border-black/5 dark:border-white/10"
              >
                <td className="py-1 pr-3">{r.name}</td>
                <td className="py-1 pr-3 tabular-nums">{r.value ?? "–"}</td>
                <td className="py-1 pr-3">{r.unit ?? ""}</td>
                <td className="py-1 pr-3">{r.reference_range ?? ""}</td>
                <td className="py-1 pr-3">{r.flag ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollFade>
    </div>
  );
}
