// The pure wrap decision behind ConfirmDialog's modal Tab focus trap (#832).
//
// A modal trap keeps keyboard focus INSIDE the dialog: Tab off the last focusable
// wraps to the first, Shift+Tab off the first wraps to the last, and focus that has
// escaped the dialog entirely (activeInsideRoot === false) is pulled back in. When
// focus is mid-list the browser's native Tab order is fine, so we do nothing and let
// the event through. The DOM-specific parts (querying focusables, reading
// document.activeElement, calling .focus()) stay in the component; this function is
// the branch logic, extracted so it can be unit-tested without a DOM.
//
// Returns the INDEX (within the focusables list, in DOM order) that focus should be
// forced to — the caller preventDefaults and focuses it — or null to let the default
// Tab move through untouched.
export function nextTrapFocusIndex(
  count: number,
  // Index of document.activeElement within the focusables list, or -1 if the active
  // element is not one of them (e.g. focus is on the dialog container, or escaped).
  activeIndex: number,
  // Whether the active element is still contained by the dialog root.
  activeInsideRoot: boolean,
  shiftKey: boolean
): number | null {
  if (count === 0) return null;
  const escaped = !activeInsideRoot;
  if (shiftKey) {
    // Shift+Tab off the first element (or from outside the dialog) wraps to the last.
    return activeIndex === 0 || escaped ? count - 1 : null;
  }
  // Tab off the last element (or from outside the dialog) wraps to the first.
  return activeIndex === count - 1 || escaped ? 0 : null;
}
