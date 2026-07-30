"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconX } from "@tabler/icons-react";
import type {
  Betterness,
  OutcomeComparison,
  ProtocolComparison,
} from "@/lib/protocol-compare";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import SubmitButton from "@/components/SubmitButton";
import { useToast } from "@/components/Toast";
import { formatDateWithYear } from "@/lib/format-date";
import type { FormResult } from "@/lib/types";
import type { OutcomeOption } from "@/lib/queries/protocols";
import type { PanelId } from "@/lib/biomarker-panels";
import ProtocolOutcomePicker from "./ProtocolOutcomePicker";

// Round a window mean for display: 2 dp for small magnitudes, 1 dp otherwise.
function fmtStat(n: number | null): string {
  if (n == null) return "—";
  return Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(1);
}

const TONE: Record<Betterness, string> = {
  better: "text-emerald-600 dark:text-emerald-400",
  worse: "text-rose-600 dark:text-rose-400",
  unchanged: "text-slate-500 dark:text-slate-400",
  unknown: "text-slate-500 dark:text-slate-400",
};

function OutcomePanel({
  o,
  onRemove,
}: {
  o: OutcomeComparison;
  onRemove?: () => void;
}) {
  const unit = o.unit ? ` ${o.unit}` : "";
  return (
    <div
      className="card"
      data-testid={`protocol-outcome-${o.key}`}
      data-insufficient={o.insufficient ? "1" : "0"}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          {o.label}
        </h3>
        <div className="flex shrink-0 items-center gap-2">
          {!o.insufficient && (
            <span className={`text-sm font-medium ${TONE[o.betterness]}`}>
              {o.betterness === "better"
                ? "Improved"
                : o.betterness === "worse"
                  ? "Worsened"
                  : "No change"}
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              className="btn-ghost btn-sm h-8 w-8 !p-0"
              aria-label={`Remove ${o.label}`}
              title="Remove outcome"
              onClick={onRemove}
            >
              <IconX className="h-4 w-4" stroke={2} aria-hidden />
            </button>
          )}
        </div>
      </div>
      {o.insufficient ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {o.framing}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-ink-800">
              <div className="label">Before</div>
              <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                {fmtStat(o.baseline.mean)}
                <span className="ml-1 text-xs font-normal text-slate-400">
                  {unit.trim()}
                </span>
              </div>
              <div className="text-xs text-slate-400">
                {o.baseline.n} reading{o.baseline.n === 1 ? "" : "s"} · median{" "}
                {fmtStat(o.baseline.median)}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-ink-800">
              <div className="label">During</div>
              <div className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                {fmtStat(o.intervention.mean)}
                <span className="ml-1 text-xs font-normal text-slate-400">
                  {unit.trim()}
                </span>
              </div>
              <div className="text-xs text-slate-400">
                {o.intervention.n} reading
                {o.intervention.n === 1 ? "" : "s"} · median{" "}
                {fmtStat(o.intervention.median)}
              </div>
            </div>
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {o.framing}
          </p>
        </>
      )}
    </div>
  );
}

// The before/during panels for a protocol's comparison. Renders one panel per
// declared outcome; a metric with no readings in a window shows its
// "insufficient data" note rather than a fabricated number.
export default function ProtocolCompare({
  comparison,
  protocolId,
  selectedKeys,
  options,
  relevantPanelIds,
  updateAction,
}: {
  comparison: ProtocolComparison;
  protocolId: number;
  selectedKeys: string[];
  options: OutcomeOption[];
  relevantPanelIds: PanelId[];
  updateAction: (formData: FormData) => Promise<FormResult>;
}) {
  const formatPrefs = useFormatPrefs();
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draftKeys, setDraftKeys] = useState(selectedKeys);

  function openEditor() {
    setDraftKeys(selectedKeys);
    setEditing(true);
  }

  function removeOutcome(key: string) {
    setDraftKeys((keys) => keys.filter((selectedKey) => selectedKey !== key));
  }

  async function saveOutcomes(formData: FormData) {
    formData.set("id", String(protocolId));
    try {
      const result = await updateAction(formData);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      toast("Outcomes updated");
      setEditing(false);
      router.refresh();
    } catch {
      toast("Couldn't update outcomes. Try again.", { tone: "error" });
    }
  }

  return (
    <section className="space-y-4" data-testid="protocol-compare">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Outcomes
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            Before{" "}
            {formatDateWithYear(comparison.baselineWindow.start, formatPrefs)} –{" "}
            {formatDateWithYear(comparison.baselineWindow.end, formatPrefs)} ·
            During{" "}
            {formatDateWithYear(
              comparison.interventionWindow.start,
              formatPrefs
            )}{" "}
            –{" "}
            {formatDateWithYear(comparison.interventionWindow.end, formatPrefs)}
          </p>
        </div>
        {!editing && comparison.outcomes.length > 0 && (
          <button
            type="button"
            className="btn-ghost btn-sm shrink-0"
            onClick={openEditor}
          >
            Edit outcomes
          </button>
        )}
      </div>
      {comparison.outcomes
        .filter((outcome) => !editing || draftKeys.includes(outcome.key))
        .map((outcome) => (
          <OutcomePanel
            key={outcome.key}
            o={outcome}
            onRemove={editing ? () => removeOutcome(outcome.key) : undefined}
          />
        ))}
      {editing && (
        <form
          action={saveOutcomes}
          className="card space-y-4"
          data-testid="protocol-outcomes-form"
        >
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Add another measurement to compare before and during this
              protocol.
            </p>
            <ProtocolOutcomePicker
              options={options}
              selectedKeys={draftKeys}
              onChange={setDraftKeys}
              relevantPanels={new Set(relevantPanelIds)}
              externallyDisplayedKeys={
                new Set(comparison.outcomes.map((outcome) => outcome.key))
              }
            />
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-black/5 pt-3 sm:flex-row sm:justify-end dark:border-white/10">
            <button
              type="button"
              className="btn-ghost w-full sm:w-auto"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <SubmitButton
              className="btn w-full sm:w-auto"
              pendingLabel="Saving…"
            >
              Save outcomes
            </SubmitButton>
          </div>
        </form>
      )}
      {!editing && comparison.outcomes.length === 0 && (
        <div className="card flex flex-col items-start gap-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between dark:text-slate-400">
          <span>
            Choose the measurements you want to compare before and during this
            protocol.
          </span>
          <button
            type="button"
            className="btn btn-sm shrink-0"
            onClick={openEditor}
          >
            Choose outcomes
          </button>
        </div>
      )}
    </section>
  );
}
