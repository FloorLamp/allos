"use client";

import Combobox from "./Combobox";

// Autocomplete over the known activities, with an opt-in "add as new" row for
// free-text names (`allowFreeText` + `onPick`, which fires only on an explicit
// selection). Thin wrapper over the shared Combobox (modal-safe Escape); all
// props except the three it pins pass straight through, so new Combobox
// capabilities don't require a parallel edit here.
export default function ActivityCombobox(
  props: Omit<
    React.ComponentProps<typeof Combobox>,
    "ariaLabel" | "emptyLabel" | "closeStopsPropagation"
  >
) {
  return (
    <Combobox
      {...props}
      ariaLabel="Activity"
      emptyLabel="No activity found"
      closeStopsPropagation
    />
  );
}
