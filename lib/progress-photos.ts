// PURE pose vocabulary for the physique progress-photo domain (#1119 phase 2).
// Client-safe (no DB import): the pose tabs, the capture form, and the write
// core (lib/progress-photo-write.ts) all consume this one vocabulary, and the
// migration's CHECK constraint mirrors PROGRESS_POSES — grow it only via an
// enum-rebuild migration.

export const PROGRESS_POSES = ["front", "side", "back", "custom"] as const;

export type ProgressPose = (typeof PROGRESS_POSES)[number];

export const POSE_LABELS: Record<ProgressPose, string> = {
  front: "Front",
  side: "Side",
  back: "Back",
  custom: "Custom",
};

// Strict normalization: an off-vocabulary pose is null (the action surfaces a
// friendly error) — never coerced onto the CHECK set silently.
export function normalizePose(
  input: string | null | undefined
): ProgressPose | null {
  const v = (input ?? "").trim().toLowerCase();
  return (PROGRESS_POSES as readonly string[]).includes(v)
    ? (v as ProgressPose)
    : null;
}

// ── The in-domain DOOR (#3284) ───────────────────────────────────────────────
//
// Distinct from the #1119 nav gate, which hides the nav row until a photo exists
// and is CORRECT — a zero-row store should not hold a nav row. The defect that
// gate leaves behind is that the command palette was then the only always-visible
// way in, and a palette-only door is invisible to anyone who does not already know
// to search for it.
//
// A nav row asks one question ("is there anything here?"). A door has to answer a
// second one — "and what does it invite?" — so this fold is three-valued rather
// than boolean. `first-capture` is the #3077 never-recorded-keeps-its-CTA state:
// nothing on file, so the entry IS the invitation.
export type ProgressPhotoDoor = "browse" | "first-capture" | "hidden";

export function progressPhotoDoor(input: {
  hasPhotos: boolean;
  /** The acting session's grant is read-only (`session.access === "read"`). */
  readOnly: boolean;
}): ProgressPhotoDoor {
  if (input.hasPhotos) return "browse";
  // Nothing recorded AND no write grant is the one state with no door: the page
  // behind it is empty and the invitation could not be accepted. Hiding it here is
  // not the nav gate's rule — a read-only viewer WITH photos still gets `browse`.
  return input.readOnly ? "hidden" : "first-capture";
}
