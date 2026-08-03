"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Combobox from "@/components/Combobox";
import { currentPathHref } from "@/lib/hrefs";
import {
  seriesPickerOptions,
  type SeriesPickerInput,
  type SeriesPickerOption,
} from "@/lib/series-picker-options";

// The Compare picker for the Trends hub: two series
// pickers (A + B) plus a "normalize" toggle, writing their choices into the
// cmpA / cmpB / cmpn query params on the current path (preserving the shared
// date window + active tab). Server components read the params back and build the
// overlay. Path-/param-agnostic so it round-trips through the hub's URL.
//
// #1675 replaced the two flat alphabetical `<select>`s with the shared Combobox over
// the SAME relevance-ranked option list the ★ picker uses. Empty query = the ranked,
// group-headed view; typing = the app-wide fuzzy search. The params, the overlay, and
// the age gates that decide MEMBERSHIP are unchanged — only the order and the search.
export interface CompareOptionGroup {
  metrics: SeriesPickerInput[];
  biomarkers: SeriesPickerInput[];
}

// Clearing a series is a real choice, not the absence of one, so it is a row in the
// list rather than only the input's ✕.
const NONE_LABEL = "— none —";

function SeriesPicker({
  id,
  label,
  options,
  selectedKey,
  onSelect,
}: {
  id: string;
  label: string;
  options: SeriesPickerOption[];
  selectedKey?: string;
  onSelect: (key: string | undefined) => void;
}) {
  const selected = options.find((o) => o.key === selectedKey);
  const [query, setQuery] = useState(selected?.label ?? "");
  // The URL is the source of truth: a back/forward step, or the sibling picker's
  // router.replace, re-renders this with a new `selectedKey` and the input must follow.
  useEffect(() => {
    setQuery(selected?.label ?? "");
  }, [selected?.label]);

  const byLabel = useMemo(
    () => new Map(options.map((o) => [o.label, o])),
    [options]
  );

  return (
    <div className="min-w-[10rem] flex-1">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <Combobox
        id={id}
        ariaLabel={label}
        value={query}
        onChange={setQuery}
        options={[NONE_LABEL, ...options.map((o) => o.label)]}
        groupFor={(option) => byLabel.get(option)?.group ?? null}
        onPick={(picked) => {
          if (picked === NONE_LABEL) onSelect(undefined);
          else onSelect(byLabel.get(picked)?.key);
        }}
        // A query typed but never picked is not a selection — restore the label of
        // whatever the URL still says, so the field never shows a series it isn't
        // plotting.
        onInputBlur={() => setQuery(selected?.label ?? "")}
        placeholder="Search metrics and biomarkers"
        emptyLabel="No matching series"
        selectOnFocus
      />
    </div>
  );
}

export default function CompareControls({
  options,
  a,
  b,
  normalized,
}: {
  options: CompareOptionGroup;
  a?: string;
  b?: string;
  normalized: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rows = useMemo(
    () => seriesPickerOptions([...options.metrics, ...options.biomarkers]),
    [options]
  );

  function setParam(key: string, value: string | undefined) {
    const sp = new URLSearchParams(searchParams.toString());
    if (value) sp.set(key, value);
    else sp.delete(key);
    const s = sp.toString();
    router.replace(currentPathHref(s ? `${pathname}?${s}` : pathname), {
      scroll: false,
    });
  }

  return (
    <div className="card flex flex-wrap items-end gap-3">
      <SeriesPicker
        id="cmp-a"
        label="Series A"
        options={rows}
        selectedKey={a}
        onSelect={(key) => setParam("cmpA", key)}
      />
      <SeriesPicker
        id="cmp-b"
        label="Series B"
        options={rows}
        selectedKey={b}
        onSelect={(key) => setParam("cmpB", key)}
      />
      {/* #1493 B. This toggle is the one control here you tap rather than pick from,
          and its label box was ~28px tall (a 16px box plus its text), well under the
          ~44px touch-target floor the rest of the app holds itself to. `min-h-11`
          gives it the floor on every viewport without moving anything: the row already
          wraps under the pickers on a phone, and on desktop the card's `items-end`
          keeps it on the baseline it always had. */}
      <label
        data-testid="compare-normalize"
        className="flex min-h-11 items-center gap-2 pb-2 text-sm text-slate-600 dark:text-slate-300"
      >
        <input
          type="checkbox"
          checked={normalized}
          onChange={(e) => setParam("cmpn", e.target.checked ? "1" : undefined)}
          className="h-4 w-4"
        />
        Normalize (0–100%)
      </label>
    </div>
  );
}
