"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

// The Compare picker for the Trends hub: two series
// dropdowns (A + B) plus a "normalize" toggle, writing their choices into the
// cmpA / cmpB / cmpn query params on the current path (preserving the shared
// date window + active tab). Server components read the params back and build the
// overlay. Path-/param-agnostic so it round-trips through the hub's URL.
export interface CompareOptionGroup {
  metrics: { key: string; label: string }[];
  biomarkers: { key: string; label: string }[];
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

  function setParam(key: string, value: string | undefined) {
    const sp = new URLSearchParams(searchParams.toString());
    if (value) sp.set(key, value);
    else sp.delete(key);
    const s = sp.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  }

  const renderOptions = () => (
    <>
      <option value="">— none —</option>
      {options.metrics.length > 0 && (
        <optgroup label="Metrics">
          {options.metrics.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </optgroup>
      )}
      {options.biomarkers.length > 0 && (
        <optgroup label="Biomarkers">
          {options.biomarkers.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  return (
    <div className="card flex flex-wrap items-end gap-3">
      <div className="min-w-[10rem] flex-1">
        <label htmlFor="cmp-a" className="label">
          Series A
        </label>
        <select
          id="cmp-a"
          className="input w-full"
          value={a ?? ""}
          onChange={(e) => setParam("cmpA", e.target.value || undefined)}
        >
          {renderOptions()}
        </select>
      </div>
      <div className="min-w-[10rem] flex-1">
        <label htmlFor="cmp-b" className="label">
          Series B
        </label>
        <select
          id="cmp-b"
          className="input w-full"
          value={b ?? ""}
          onChange={(e) => setParam("cmpB", e.target.value || undefined)}
        >
          {renderOptions()}
        </select>
      </div>
      <label className="flex items-center gap-2 pb-2 text-sm text-slate-600 dark:text-slate-300">
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
