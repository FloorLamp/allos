// THE ONE DEFINITION OF A LOUD CONTROL (#5696, for #4978 ruling 6).
//
// Ruling 6 makes the CARD the surface and gives it one loud control, so nearly
// every rank spec in the #4978 programme counts the fills on a card. They each
// derived that count from a private selector list, and the lists had already
// drifted into three shapes — rank classes only, rank classes plus the two
// wrapper utilities, and `button-control-primary` alone — so what "loud" meant
// depended on which file you opened, and the narrowest of them could not see a
// second fill at all.
//
// A FILL USED TO BE ABLE TO ARRIVE WITHOUT A RANK. `destructive-submit` and
// `duplicate-resolution-primary` painted a solid fill onto a `.button-control`
// CHILD, leaving the button itself with neither rank class: a card could show
// two solid controls while a census of the rank classes reported one, and the
// census only saw past it by knowing each wrapper by name. That is fixed at the
// source rather than mirrored here — `DestructiveSubmit` states
// `variant="danger"`, `DuplicateResolutionActions` states `variant="primary"`,
// and the retired utility took its hand-rolled copy of the primary fill with it.
// So the rank class IS the fill, and `loud-controls.test.tsx` refuses a rule in
// `app/globals.css` that paints one where a combinator or a descendant space
// follows the leading `&`. That file states what the match does and does not
// reach, and pins both of its known defects as cases.
//
// SCOPE: the typed control family. The retiring raw `btn` / `btn-danger`
// families paint the same tokens and are solid too, but they are still mounted
// widely and retire with their last caller (#4978), so folding them in would
// redden dozens of specs for debt that is not this definition's. (No count is
// given here on purpose: every way of measuring it — class tokens, single-line
// `className` mounts, files mentioning the family — gives a different number,
// and none of them is pinned by anything.)
//
// THAT SCOPE IS NOT FREE, and the mitigation is uneven rather than universal: on
// a surface still carrying a raw mount, this function reports one fewer loud
// control than a person sees. `records-form-ranks`, `training-routine-actions`
// and `integrations-card-ranks` close that on their own surfaces with a
// `RAW_FAMILY` assertion; `frequency-target-form-ranks` has a partial one.
// `settings-card-commit-ranks`, `visit-links-bulk-rank` and
// `save-trend-picker-rank` carry none, and rest on their surfaces having been
// converted whole rather than on a check.
export const LOUD_CONTROL = ".button-control-primary, .button-control-danger";

/**
 * Every loud control on a surface, named. Collected rather than sampled and
 * compared as an exact array, so a second fill arriving on a card fails instead
 * of passing unnoticed.
 *
 * Read off the RENDERED class, never the call site: `ButtonProps` is closed and
 * every wrapper forwards by name, so a rank that stopped being forwarded still
 * typechecks and still lints.
 */
export function loudIn(surface: HTMLElement): string[] {
  return [...surface.querySelectorAll<HTMLElement>(LOUD_CONTROL)].map(
    (el) =>
      (el.textContent ?? "").trim() || (el.getAttribute("aria-label") ?? "")
  );
}
