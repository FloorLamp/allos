"use client";

import QueryParamSelect from "./QueryParamSelect";
import type { MedicalCategory } from "@/lib/types";

// Category dropdown for a clinical observations table, over the standard clinical-
// observation categories. Offering the caller's fixed set (rather than only the
// categories present in the current view) keeps the control consistent with the
// readings table wherever it's used. (The import-detail document view no longer
// uses this control — its category filter collapsed into the results-browser tab
// strip, #271, which is also why the offered set is now required rather than
// defaulted: one caller passes it, and the default had no reader left.)
export default function CategoryFilterSelect({
  value,
  categories,
}: {
  value?: string;
  categories: readonly MedicalCategory[];
}) {
  return (
    <QueryParamSelect
      param="category"
      label="Category"
      value={value}
      // Categories are stored lowercase and were displayed through a `capitalize`
      // class. The owner renders one option label for every caller, so the casing
      // becomes the label itself — a class here would be the styling seam #3748
      // closes, and `capitalize` on the shared select would retitle the panel
      // names next door.
      options={categories.map((c) => ({
        value: c,
        label: c[0].toUpperCase() + c.slice(1),
      }))}
    />
  );
}
