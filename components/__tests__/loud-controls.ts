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
// So the rank class IS the fill, and `loud-controls.test.tsx` refuses a new
// `@utility` that would paint one onto a `.button-control` child again.
//
// SCOPE: the typed control family. The retiring raw `btn` / `btn-danger`
// families paint the same tokens and are solid too, but 190-odd mounts still
// carry them and they retire with their last caller (#4978); the rank specs keep
// them off a converted surface with their own `RAW_FAMILY` assertion instead.
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
