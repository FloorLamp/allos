"use client";

import { useEffect, useMemo, useState } from "react";
import Combobox from "./Combobox";
import {
  seriesPickerOptions,
  SERIES_PICKER_GROUP_ORDER,
  type SeriesPickerInput,
} from "@/lib/series-picker-options";

// The ★ picker's control (#1675). It replaces a flat alphabetical `<select>` over
// metrics + ~200 analytes with the shared Combobox: an empty query is the RELEVANCE
// view (retest-due / flagged first, then metrics, then the profile's own markers,
// then the A–Z body), and typing fuzzy-searches everything.
//
// The flagged trade in #1675 was that SaveTrendPicker is a no-JS server-action form
// and the Combobox is client-side. This resolves it by PROGRESSIVE ENHANCEMENT rather
// than by a <noscript> block (the repo has none, and a noscript control inside a form
// posts a second `key` field): the server renders the same grouped `<select>` it always
// did, and only a mounted client swaps in the combobox. With scripting off the form
// still posts a real series key through the same `toggleSavedItem` action; with
// scripting on the hidden input carries the picked key to that same action.
export default function SaveTrendKeyPicker({
  rows,
}: {
  rows: SeriesPickerInput[];
}) {
  const options = useMemo(() => seriesPickerOptions(rows), [rows]);
  const byLabel = useMemo(
    () => new Map(options.map((o) => [o.label, o])),
    [options]
  );
  const [enhanced, setEnhanced] = useState(false);
  const [label, setLabel] = useState("");
  useEffect(() => setEnhanced(true), []);

  const picked = byLabel.get(label.trim());
  const star = (
    <button
      type="submit"
      disabled={enhanced && !picked}
      className="btn-ghost inline-flex items-center gap-1 py-1.5 disabled:opacity-50"
    >
      <span aria-hidden>☆</span>
      Star
    </button>
  );

  if (!enhanced) {
    return (
      <>
        <label
          htmlFor="star-trend"
          className="text-slate-500 dark:text-slate-400"
        >
          Add to your overview:
        </label>
        <select
          id="star-trend"
          name="key"
          defaultValue={options[0]?.key}
          className="input h-9 max-w-[16rem] py-1"
        >
          {SERIES_PICKER_GROUP_ORDER.map((group) => {
            const rowsInGroup = options.filter((o) => o.group === group);
            if (rowsInGroup.length === 0) return null;
            return (
              <optgroup key={group} label={group}>
                {rowsInGroup.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        {star}
      </>
    );
  }

  return (
    <>
      <label
        htmlFor="star-trend"
        className="text-slate-500 dark:text-slate-400"
      >
        Add to your overview:
      </label>
      {/* The posted field. The combobox itself is unnamed so a half-typed query can
          never be submitted as a key — only a real pick reaches the action. */}
      <input type="hidden" name="key" value={picked?.key ?? ""} />
      <div className="w-full max-w-[16rem]">
        <Combobox
          id="star-trend"
          ariaLabel="Add to your overview"
          value={label}
          onChange={setLabel}
          options={options.map((o) => o.label)}
          groupFor={(option) => byLabel.get(option)?.group ?? null}
          placeholder="Search metrics and biomarkers"
          emptyLabel="No matching metric or biomarker"
        />
      </div>
      {star}
    </>
  );
}
