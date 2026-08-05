"use client";

import { useState, useTransition } from "react";
import { IconAdjustments } from "@tabler/icons-react";
import DateField from "@/components/DateField";
import type { WeightUnit, DistanceUnit } from "@/lib/settings";
import {
  CORRECTION_FIELDS,
  isCorrectionFieldId,
  type CorrectionFieldId,
  type RawCorrectionOp,
} from "@/lib/bulk-correction";
import type { CorrectionSourcesByField } from "@/lib/bulk-correction-db";
import {
  applyBulkCorrectionAction,
  previewBulkCorrection,
  undoBulkCorrectionAction,
  type BulkCorrectionPreviewResult,
  type BulkCorrectionRequest,
} from "@/app/(app)/data/bulk-correction-actions";

// Bulk corrections (issue #1603): fix a bad RUN of data — a miscalibrated scale,
// an import that landed pounds as kilograms — in one plan → preview → apply →
// undo flow instead of dozens of row-at-a-time edits. Client component so the
// preview (and its compare-and-set signature) can be held in state between the
// two server round-trips; every button renders the action's typed outcome, and
// any input change discards the stale preview so Apply can only submit exactly
// what was previewed.

// The manual bucket's <option> value (a real source string never starts with
// "__"). Maps to `source IS NULL` server-side.
const MANUAL_VALUE = "__manual__";

const OP_KINDS = [
  { kind: "add", label: "Add an offset" },
  { kind: "multiply", label: "Multiply by a factor" },
  { kind: "set", label: "Set every row to a value" },
] as const;

type OpKind = RawCorrectionOp["kind"];

export default function BulkCorrectionCard({
  sources,
  initialField,
  units,
}: {
  sources: CorrectionSourcesByField;
  /** Pre-selected field from a contextual "Fix a range…" link, or null. */
  initialField: CorrectionFieldId | null;
  units: { weightUnit: WeightUnit; distanceUnit: DistanceUnit };
}) {
  const [field, setField] = useState<CorrectionFieldId>(
    initialField ?? "weight"
  );
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [opKind, setOpKind] = useState<OpKind>("add");
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<BulkCorrectionPreviewResult | null>(
    null
  );
  const [applied, setApplied] = useState<{
    undoId: number;
    message: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const spec = CORRECTION_FIELDS[field];
  const fieldSources = sources[field];
  // A changed selection invalidates the previewed plan (its signature signs the
  // exact rows), so every input change funnels through here.
  function resetPreview(): void {
    setPreview(null);
    setApplied(null);
    setNotice(null);
  }

  function onFieldChange(next: string): void {
    if (!isCorrectionFieldId(next)) return;
    setField(next);
    setSource("");
    setOpKind("add");
    setAmount("");
    resetPreview();
  }

  function onSourceChange(value: string): void {
    setSource(value);
    // Prefill the range with the picked source's full span — the common case is
    // "this whole device run is wrong"; narrowing is an edit away.
    const opt = fieldSources.find(
      (s) => (s.source ?? MANUAL_VALUE) === value
    );
    if (opt) {
      setFrom(opt.minDate);
      setTo(opt.maxDate);
    }
    resetPreview();
  }

  function request(): BulkCorrectionRequest | null {
    if (source === "" || from === "" || to === "") return null;
    const needsAmount = opKind !== "unit-preset";
    const parsed = Number(amount);
    if (needsAmount && (amount.trim() === "" || !Number.isFinite(parsed)))
      return null;
    return {
      field,
      from,
      to,
      source: source === MANUAL_VALUE ? null : source,
      op: { kind: opKind, value: needsAmount ? parsed : null },
    };
  }

  function onPreview(): void {
    const req = request();
    if (!req) {
      setNotice("Pick a source, a date range, and an amount first.");
      return;
    }
    setNotice(null);
    setApplied(null);
    startTransition(async () => {
      setPreview(await previewBulkCorrection(req));
    });
  }

  function onApply(): void {
    const req = request();
    if (!req || !preview?.ok) return;
    startTransition(async () => {
      const res = await applyBulkCorrectionAction({
        ...req,
        signature: preview.signature,
      });
      if (res.ok) {
        setPreview(null);
        setApplied({ undoId: res.undoId, message: res.message });
      } else {
        // A drifted plan is stale by definition — drop it so the only way
        // forward is a fresh preview of the current rows.
        if (res.error === "drift") setPreview(null);
        setNotice(res.message);
      }
    });
  }

  function onUndo(): void {
    if (!applied) return;
    const undoId = applied.undoId;
    startTransition(async () => {
      const res = await undoBulkCorrectionAction(undoId);
      setApplied(null);
      setNotice(res.message);
    });
  }

  // The op's number input label, in the login's display unit where the field
  // converts (the action converts at the boundary; this only names the unit).
  const displayUnit =
    field === "weight"
      ? units.weightUnit
      : field === "distance"
        ? units.distanceUnit
        : spec.unit;
  const amountLabel =
    opKind === "add"
      ? `Offset (${displayUnit}, negative subtracts)`
      : opKind === "multiply"
        ? "Factor"
        : `New value (${displayUnit})`;

  return (
    // A power tool used a few times a year, so it collapses to ONE summary line at
    // the bottom of Review (#1880 item 6). A ?fix= deep-link (initialField) opens it
    // pre-selected — a native <details>, so the toggle needs no hydration.
    <details
      id="bulk-correction"
      className="card scroll-mt-4"
      data-testid="bulk-correction-card"
      open={initialField != null}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-2"
        data-testid="bulk-correction-toggle"
      >
        <IconAdjustments className="h-5 w-5 text-brand-600 dark:text-brand-400" stroke={1.75} />
        <span className="font-semibold text-slate-800 dark:text-slate-100">
          Fix a run of data
        </span>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          — correct a whole stretch at once (miscalibrated scale, lb-as-kg
          import)
        </span>
      </summary>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Correct a whole stretch at once — a miscalibrated scale, an import that
        landed pounds as kilograms. Pick the rows, preview every change, then
        apply. Corrections can be undone for 24 hours.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
            Field
          </span>
          <select
            className="input w-full"
            data-testid="bulk-correction-field"
            value={field}
            onChange={(e) => onFieldChange(e.target.value)}
          >
            {Object.values(CORRECTION_FIELDS).map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
            Source
          </span>
          <select
            className="input w-full"
            data-testid="bulk-correction-source"
            value={source}
            onChange={(e) => onSourceChange(e.target.value)}
          >
            <option value="">Choose a source…</option>
            {fieldSources.map((s) => (
              <option
                key={s.source ?? MANUAL_VALUE}
                value={s.source ?? MANUAL_VALUE}
              >
                {s.source ?? "Manual entries"} ({s.count})
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
              From
            </span>
            <DateField
              value={from}
              onChange={(v) => {
                setFrom(v);
                resetPreview();
              }}
              inputClassName="w-full"
              data-testid="bulk-correction-from"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
              To
            </span>
            <DateField
              value={to}
              onChange={(v) => {
                setTo(v);
                resetPreview();
              }}
              inputClassName="w-full"
              data-testid="bulk-correction-to"
            />
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
            Correction
          </span>
          <select
            className="input w-full"
            data-testid="bulk-correction-op"
            value={opKind}
            onChange={(e) => {
              setOpKind(e.target.value as OpKind);
              resetPreview();
            }}
          >
            {OP_KINDS.map((o) => (
              <option key={o.kind} value={o.kind}>
                {o.label}
              </option>
            ))}
            {spec.preset && (
              <option value="unit-preset">{spec.preset.label}</option>
            )}
          </select>
        </label>

        {opKind !== "unit-preset" && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">
              {amountLabel}
            </span>
            <input
              type="number"
              step="any"
              className="input w-full"
              data-testid="bulk-correction-amount"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                resetPreview();
              }}
            />
          </label>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-sm"
          data-testid="bulk-correction-preview"
          onClick={onPreview}
          disabled={pending}
        >
          Preview changes
        </button>
        {preview?.ok && (
          <button
            type="button"
            className="btn btn-sm"
            data-testid="bulk-correction-apply"
            onClick={onApply}
            disabled={pending}
          >
            Apply to {preview.count} {preview.count === 1 ? "row" : "rows"}
          </button>
        )}
        {applied && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            data-testid="bulk-correction-undo"
            onClick={onUndo}
            disabled={pending}
          >
            Undo this correction
          </button>
        )}
      </div>

      {notice && (
        <p
          className="mt-3 text-sm text-slate-600 dark:text-slate-300"
          data-testid="bulk-correction-notice"
        >
          {notice}
        </p>
      )}

      {applied && (
        <p
          className="mt-3 text-sm font-medium text-emerald-700 dark:text-emerald-400"
          data-testid="bulk-correction-applied"
        >
          {applied.message}
        </p>
      )}

      {preview &&
        (preview.ok ? (
          <div
            className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
            data-testid="bulk-correction-preview-panel"
          >
            <p
              className="text-sm font-medium text-slate-800 dark:text-slate-100"
              data-testid="bulk-correction-summary"
            >
              {preview.summaryLine}
              {preview.unchanged > 0 && (
                <span className="font-normal text-slate-500 dark:text-slate-400">
                  {" "}
                  ({preview.unchanged} already correct, left alone)
                </span>
              )}
            </p>
            {preview.lockNote && (
              <p
                className="mt-1 text-sm text-amber-700 dark:text-amber-400"
                data-testid="bulk-correction-lock-note"
              >
                {preview.lockNote}
              </p>
            )}
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <th className="th">Date</th>
                  <th className="th">Now</th>
                  <th className="th">After</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr
                    key={i}
                    className="border-t border-black/5 text-slate-700 dark:border-white/5 dark:text-slate-200"
                  >
                    <td className="td">{row.date}</td>
                    <td className="td">{row.before}</td>
                    <td className="td">{row.after}</td>
                  </tr>
                ))}
                </tbody>
              </table>
            </div>
            {preview.count > preview.sample.length && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Showing the first {preview.sample.length} of {preview.count}{" "}
                changes.
              </p>
            )}
          </div>
        ) : (
          <p
            className="mt-3 text-sm text-slate-600 dark:text-slate-300"
            data-testid="bulk-correction-preview-error"
          >
            {preview.message}
          </p>
        ))}
    </details>
  );
}
