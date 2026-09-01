"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";
import { updateMetricReading } from "@/app/(app)/trends/reading-actions";

// THE BODY DOMAIN'S ONE ROW CONTROL (#4424 ruling 3), named by
// `LOG_MANIFEST.body.pieces.rowControl`. Ruling 3 calls a one-field inline edit
// row-control-grade and names this very cell as the example: "the readings-table value
// cell". It was drawn twice — once inside `MetricReadingsTable`'s row and once as a
// second small form in `/history`'s `case "body"` — both posting `updateMetricReading`
// with the same three fields, so a fix to one could silently miss the other.
//
// A READING'S VALUE IS THE WHOLE OF WHAT THIS CORRECTS. Re-dating a reading is a
// record-level move and belongs to the form, which is why this stays one field and
// why the surrounding row (date, source, flag) is left standing by both mounts: the
// reader can see what they are changing.
//
// THE SUBJECT IS OPTIONAL AND SPELLED ONCE (ruling 4): absent means the acting
// profile, present posts `profile_id` and is re-gated server-side by
// `gateItemProfile` — the spelling `HistoricalDoseForm` already uses on the same rows.
//
// THE VERDICT BELONGS TO THE CONTROL, not to its hosts. One control writing one row
// answers with one sentence; two hosts each rounding the same outcome their own way is
// how "Reading updated." and "Corrected." came to describe the same write.

export default function ReadingValueControl({
  kind,
  target,
  value: initial,
  weightUnit,
  subjectProfileId,
  onSaved,
  onCancel,
}: {
  /** The PAGE (#2032): the display unit to convert back from, and what to revalidate. */
  kind: string;
  /** The ROW, as `store:id:measure` — which physical record is written. */
  target: string;
  /** The row's value in the unit it printed in, which is the unit it is edited in. */
  value: number;
  /**
   * The unit that value was PRINTED in (#630, #3853), posted as `weight_unit` so a
   * correction converts by the unit the row showed rather than by the pref re-read at
   * write time — a flip in another tab would otherwise land a number 2.2046x out.
   * The action reads it only on the WEIGHT page, where it is a real `WeightUnit`;
   * every other metric is charted in the unit it is stored in, so its label ("bpm",
   * "%") passes through and `submittedWeightUnit` ignores it. Hence `string`: this is
   * the row's printed unit, and only one page's rows spell a weight unit.
   */
  weightUnit?: string;
  subjectProfileId?: number;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState(String(initial));
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("target", target);
    fd.set("value", value);
    if (weightUnit) fd.set("weight_unit", weightUnit);
    if (subjectProfileId != null) {
      fd.set("profile_id", String(subjectProfileId));
    }
    setBusy(true);
    try {
      const res = await updateMetricReading(fd);
      if (!res.ok) {
        toast(res.error ?? "Couldn't save that reading.", { tone: "error" });
        return;
      }
      toast("Reading updated.");
      // The chart above the readings table and the record's feed are both
      // server-rendered from these rows; the action marked them stale.
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className="flex items-center gap-1"
      data-testid="reading-value-control"
    >
      <input
        className="input w-24 py-1 text-sm"
        type="number"
        step="any"
        inputMode="decimal"
        aria-label="Reading value"
        value={value}
        autoFocus
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={() => void save()}
      >
        Save
      </button>
      <button
        type="button"
        className="btn-ghost btn-sm"
        disabled={busy}
        onClick={onCancel}
      >
        Cancel
      </button>
    </span>
  );
}
