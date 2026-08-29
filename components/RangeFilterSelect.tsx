"use client";

import QueryParamSelect from "./QueryParamSelect";

// Remembers the last-chosen range filter, so it carries across the results browser
// and the per-document subpages within a session.
const STORAGE_KEY = "medical:range";

const OPTIONS = [
  { value: "nonoptimal", label: "Non-optimal" },
  { value: "oor", label: "Out of range only" },
] as const;

function known(v: string | null | undefined) {
  return OPTIONS.some((o) => o.value === v) ? (v as string) : null;
}

// Three-way "show" filter for a clinical readings table: All / Non-optimal / Out
// of range only. The URL write is QueryParamSelect's; what stays HERE is the
// PERSISTENCE POLICY #3748 keeps out of the primitive — this filter alone
// remembers its choice for the session, as the checkbox it replaced did, and that
// restore is the hydration-time self-navigation e2e/helpers.ts arms its click
// baseline lazily for.
export default function RangeFilterSelect({ value }: { value?: string }) {
  return (
    <QueryParamSelect
      param="range"
      label="Show"
      value={known(value) ?? ""} // an unrecognized `?range=` shows All, not nothing
      options={OPTIONS}
      restoreWhenUnset={() => known(sessionStorage.getItem(STORAGE_KEY))}
      onSelect={(next) => {
        if (next) sessionStorage.setItem(STORAGE_KEY, next);
        else sessionStorage.removeItem(STORAGE_KEY);
      }}
    />
  );
}
