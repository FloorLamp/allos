"use client";

import Combobox from "@/components/Combobox";

// Free-text supplement/brand autocomplete: the typed value is always kept, and
// an unmatched query offers an "Use '<query>'" row. `onPick` fires on selection
// so the form can auto-fill dosage/time from the catalog. Thin wrapper over the
// shared Combobox.
export default function SupplementCombobox(props: {
  value: string;
  onChange: (v: string) => void;
  onPick?: (v: string) => void;
  options: string[];
  placeholder?: string;
  name?: string;
  ariaLabel?: string;
}) {
  return <Combobox {...props} allowFreeText />;
}
