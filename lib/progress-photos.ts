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
