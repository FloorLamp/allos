import type { MuscleId } from "./lifts";

/**
 * Hand-authored path registry for the `MuscleAnatomy` SVG figure (#737).
 *
 * PURE DATA, no DB/network/React — the reflection test in
 * `lib/__tests__/muscle-anatomy-paths.test.ts` walks this registry against the
 * `MuscleId` enum so no muscle can silently go invisible. The figure itself
 * (`components/MuscleAnatomy.tsx`) is a formatter over this data plus the mode
 * inputs; it draws nothing of its own.
 *
 * Authoring conventions:
 * - One shared coordinate frame per body view: `0 0 VIEW_W VIEW_H`
 *   (100 × 220), vertical centerline at x = 50.
 * - The silhouette and every BILATERAL muscle are authored on the viewer's
 *   LEFT side only; the renderer adds a mirrored twin via `MIRROR_TRANSFORM`.
 *   Centered shapes (abs bands, neck) are authored in full and not mirrored.
 * - Stylized/diagrammatic is the bar (a clean gym-app muscle map), NOT
 *   anatomical-atlas fidelity — decided in the issue; do not chase realism.
 * - All path commands are ABSOLUTE (M/L/C/Q/Z) with paired coordinates, which
 *   is what lets the reflection test structurally validate every shape.
 * - No third-party base asset (license/attribution + regrouping problems) —
 *   these paths are drawn by hand for exactly the `MuscleId` granularity.
 */

export const VIEW_W = 100;
export const VIEW_H = 220;

/**
 * The transform that produces the right-side twin of a left-authored bilateral
 * shape: reflect about the vertical centerline of the 0–100 frame.
 */
export const MIRROR_TRANSFORM = `translate(${VIEW_W},0) scale(-1,1)`;

export type AnatomyView = "front" | "back";

export interface MuscleShape {
  view: AnatomyView;
  /** Absolute-command path data (left side when `bilateral`). */
  d: string;
  /** Render a mirrored twin about the centerline (paired muscles). */
  bilateral?: boolean;
}

/**
 * The body silhouette per view, drawn as the LEFT half closed along the
 * centerline (the renderer mirrors it; the halves overlap slightly past
 * x = 50 so no seam shows). Fill-only — no stroke — so the mirrored halves
 * read as one flat shape.
 */
export const BODY_OUTLINE: Record<AnatomyView, string> = {
  front:
    // Head (left half) — crown to jaw, closed along the centerline.
    "M 50.6 3.5 C 45.5 3.5 41.5 7.5 41.5 13.5 C 41.5 19 44.5 23.5 50.6 23.5 Z " +
    // Torso, arm, leg (left half), closed along the centerline.
    "M 50.6 22.5 C 47.5 22.5 45.8 22.8 45.8 24.5 C 45.8 27.5 45 30.2 42.5 31.5 " +
    "C 35.5 33 27.5 33.8 23.8 39.5 C 21.2 43.8 20.4 50 19.4 57.5 " +
    "C 18.4 65.5 16.8 74 15.4 83.5 C 14.7 88.5 14 93.5 13.5 97.5 " +
    "C 12.4 102.5 12.9 107 14.5 108.2 C 16.6 109.7 19.2 108.2 19.9 104.4 " +
    "C 20.7 99.9 21.4 95.8 22.1 91.8 C 23.5 83.8 25 75.8 26.4 68 " +
    "C 27.5 62 28.6 56 29.6 51 C 30.4 55.5 31.6 60 32.8 65 " +
    "C 34.2 71.5 35.3 78 35.5 84 C 34.6 92 32.2 98 31.6 104 " +
    "C 30.9 112 32.4 128 34.4 141 C 35.4 149 36 156 36.4 162 " +
    "C 36.1 172 36.5 182 37.9 192 C 38.4 197 38.5 201 38.5 203.5 " +
    "C 37.2 205.8 36.5 208 36.5 209.5 C 36.5 211.6 38 212.6 41 212.6 " +
    "C 44 212.6 46 212.6 46.6 212.6 C 48.1 212.6 48.6 210.9 48.3 208.4 " +
    "C 47.8 204 47.5 200 47.5 196 C 47.4 186 46.7 176 46.4 168 " +
    "C 46.2 162 46.7 155 47.4 150 C 48.4 140 49.3 130 49.7 124 " +
    "C 49.9 121 50.2 119.5 50.6 119 Z",
  back:
    // The back silhouette shares the same stylized body shape (flat fill, no
    // face) — one authored half keeps the two views visually identical.
    "M 50.6 3.5 C 45.5 3.5 41.5 7.5 41.5 13.5 C 41.5 19 44.5 23.5 50.6 23.5 Z " +
    "M 50.6 22.5 C 47.5 22.5 45.8 22.8 45.8 24.5 C 45.8 27.5 45 30.2 42.5 31.5 " +
    "C 35.5 33 27.5 33.8 23.8 39.5 C 21.2 43.8 20.4 50 19.4 57.5 " +
    "C 18.4 65.5 16.8 74 15.4 83.5 C 14.7 88.5 14 93.5 13.5 97.5 " +
    "C 12.4 102.5 12.9 107 14.5 108.2 C 16.6 109.7 19.2 108.2 19.9 104.4 " +
    "C 20.7 99.9 21.4 95.8 22.1 91.8 C 23.5 83.8 25 75.8 26.4 68 " +
    "C 27.5 62 28.6 56 29.6 51 C 30.4 55.5 31.6 60 32.8 65 " +
    "C 34.2 71.5 35.3 78 35.5 84 C 34.6 92 32.2 98 31.6 104 " +
    "C 30.9 112 32.4 128 34.4 141 C 35.4 149 36 156 36.4 162 " +
    "C 36.1 172 36.5 182 37.9 192 C 38.4 197 38.5 201 38.5 203.5 " +
    "C 37.2 205.8 36.5 208 36.5 209.5 C 36.5 211.6 38 212.6 41 212.6 " +
    "C 44 212.6 46 212.6 46.6 212.6 C 48.1 212.6 48.6 210.9 48.3 208.4 " +
    "C 47.8 204 47.5 200 47.5 196 C 47.4 186 46.7 176 46.4 168 " +
    "C 46.2 162 46.7 155 47.4 150 C 48.4 140 49.3 130 49.7 124 " +
    "C 49.9 121 50.2 119.5 50.6 119 Z",
};

/**
 * Every `MuscleId` mapped to ≥1 shape. Placement is diagrammatic: each muscle
 * is drawn in the ONE view where it reads best (front: pressing/anterior chain
 * + delts + arms flexors; back: pulling/posterior chain), so the two views
 * together cover the full enum without duplication.
 */
export const MUSCLE_PATHS: Record<MuscleId, MuscleShape[]> = {
  // ---- Front view ----------------------------------------------------------
  neck: [
    // Sternocleidomastoid strip, jaw to clavicle (bilateral).
    {
      view: "front",
      bilateral: true,
      d: "M 46.8 24.2 C 47.6 24.5 48 26.2 47.8 28.5 C 47.6 30.5 46.8 32.2 45.6 33 C 44.8 32.5 44.4 30.8 44.8 28.4 C 45.1 26.2 45.8 24.7 46.8 24.2 Z",
    },
  ],
  "front-delts": [
    // Anterior deltoid — the inner/upper portion of the shoulder cap.
    {
      view: "front",
      bilateral: true,
      d: "M 30 34.3 C 33 33.6 35.3 34.8 35.8 37.4 C 36.1 40.4 34.3 43.4 31.8 44.4 C 29.8 43 28.9 39 30 34.3 Z",
    },
  ],
  "side-delts": [
    // Lateral deltoid — the outer strip of the cap.
    {
      view: "front",
      bilateral: true,
      d: "M 28.6 34.6 C 25.6 35.4 23.4 37.9 22.9 41.4 C 22.6 44.4 23.3 46.9 24.6 48.4 C 27 47.4 28.8 43.9 29.2 39.9 C 29.4 37.9 29.3 35.9 28.6 34.6 Z",
    },
  ],
  "chest-upper": [
    // Clavicular pec band, sternum to shoulder.
    {
      view: "front",
      bilateral: true,
      d: "M 35 40.3 C 37 38.1 42.5 37.1 49.2 37.7 L 49.2 43 C 43.5 43.6 38 44.2 35.5 45.2 C 34.7 43.6 34.6 41.8 35 40.3 Z",
    },
  ],
  chest: [
    // Main (sternal) pec block.
    {
      view: "front",
      bilateral: true,
      d: "M 35.4 46.9 C 38.6 45.7 44.5 45.2 49.2 45.4 L 49.2 60.2 C 44.5 63.2 39 62.2 36.2 58.2 C 34.6 54.7 34.5 50.4 35.4 46.9 Z",
    },
  ],
  biceps: [
    {
      view: "front",
      bilateral: true,
      d: "M 27 50 C 29 51 30.2 54 29.9 58.5 C 29.6 63 28.2 67.5 25.9 69.5 C 24.2 68 23.2 64 23.6 59 C 24 54.5 25.2 51 27 50 Z",
    },
  ],
  forearms: [
    {
      view: "front",
      bilateral: true,
      d: "M 24.9 72.6 C 25.9 75.6 25.7 81 24.4 86 C 23.2 91 21.4 95.5 19.4 97.5 C 17.9 96 17.2 92.5 17.9 87.5 C 18.7 82 20.9 76 22.9 72.6 C 23.6 71.9 24.4 72 24.9 72.6 Z",
    },
  ],
  abs: [
    // Three stacked rectus bands (a hinted six-pack, kept clean).
    {
      view: "front",
      d: "M 44.6 65.8 C 46.4 64.6 53.6 64.6 55.4 65.8 C 56 68.6 56 72.6 55.4 75.4 C 53.6 76.6 46.4 76.6 44.6 75.4 C 44 72.6 44 68.6 44.6 65.8 Z",
    },
    {
      view: "front",
      d: "M 44.6 78.4 C 46.4 77.2 53.6 77.2 55.4 78.4 C 56 81.2 56 85.2 55.4 88 C 53.6 89.2 46.4 89.2 44.6 88 C 44 85.2 44 81.2 44.6 78.4 Z",
    },
    {
      view: "front",
      d: "M 44.8 91 C 46.6 89.8 53.4 89.8 55.2 91 C 55.8 93.8 55.4 97.6 54.2 100.4 C 52.4 101.8 47.6 101.8 45.8 100.4 C 44.6 97.6 44.2 93.8 44.8 91 Z",
    },
  ],
  obliques: [
    {
      view: "front",
      bilateral: true,
      d: "M 42 62.6 C 42.9 63.1 43.3 64.1 43.3 66.1 L 43.3 96.5 C 43.3 98.5 42.3 99.5 40.9 98.3 C 38.5 95.8 37 90 36.9 82 C 36.8 74 38 66.5 40 63.5 C 40.7 62.6 41.5 62.3 42 62.6 Z",
    },
  ],
  "hip-abductors": [
    // Glute med/min — the outer-hip pocket below the waist.
    {
      view: "front",
      bilateral: true,
      d: "M 34.9 104 C 37.1 103.5 38.7 105 39 108 C 39.3 111.5 38.3 114.8 36.2 116.6 C 34.2 115.6 33 112.8 33 109.5 C 33 106.5 33.7 104.7 34.9 104 Z",
    },
  ],
  quads: [
    {
      view: "front",
      bilateral: true,
      d: "M 40.8 108.5 C 42.9 108 44.2 110 44.7 114.5 C 45.4 125 45.1 138 43.9 148.5 C 43.2 154 42.2 158.5 40.6 159.5 C 38.3 158.2 36.5 152 35.8 143.5 C 35.1 134 35.5 124.5 37.3 117.8 C 38.2 113.8 39.2 109.5 40.8 108.5 Z",
    },
  ],
  "hip-adductors": [
    // Inner thigh, high near the midline.
    {
      view: "front",
      bilateral: true,
      d: "M 47.9 119.6 C 49.1 119.1 49.6 120.3 49.5 123.3 C 49.3 131 48.6 139.5 47.4 145.5 C 46.8 148 45.9 148.4 45.5 146.6 C 45.1 144 45.3 138 45.8 131.5 C 46.2 126.5 46.9 121.6 47.9 119.6 Z",
    },
  ],
  tibialis: [
    {
      view: "front",
      bilateral: true,
      d: "M 41.3 166.4 C 42.9 166.9 43.8 170 43.7 176 C 43.6 183 42.7 191 41.1 197 C 40.5 199.5 39.3 199.8 38.7 197.5 C 37.9 191 38.1 181 38.9 173 C 39.3 169.5 40.1 166.7 41.3 166.4 Z",
    },
  ],

  // ---- Back view -----------------------------------------------------------
  traps: [
    // Upper trapezius diamond, neck to shoulder, tapering down the spine.
    {
      view: "back",
      bilateral: true,
      d: "M 48.9 26.5 C 47.9 29 45.4 31.5 41.4 33.2 C 38 34.6 34.5 35.4 32 35.7 C 36 38 40.4 40.7 43.7 43.7 C 46 46 47.9 48 48.9 50.5 Z",
    },
  ],
  "rear-delts": [
    {
      view: "back",
      bilateral: true,
      d: "M 26 35 C 23.4 36 21.9 38.6 21.8 41.8 C 21.7 44.8 22.7 47.3 24.5 48.6 C 27 47.6 28.8 44.3 29 40.3 C 29.1 37.8 28 35.6 26 35 Z",
    },
  ],
  "mid-back": [
    // Rhomboid/scapular block between the lower traps and the spine.
    {
      view: "back",
      bilateral: true,
      d: "M 42.4 52.5 C 44.9 52 47.5 52.4 48.9 53.2 L 48.9 64 C 47 65 44.6 65 43 63.5 C 41.7 61.5 41.2 57.8 41.6 55 C 41.8 53.6 42 52.9 42.4 52.5 Z",
    },
  ],
  lats: [
    // The wing: armpit sweeping down and inward to the lower spine.
    {
      view: "back",
      bilateral: true,
      d: "M 31.9 50.5 C 34.9 52.2 38.4 54 40.2 55.5 L 40.2 62.5 C 41.9 67 43.9 72.5 44.9 79 C 45.2 81.2 45.3 83 45.1 84.2 C 42.2 82.5 38.9 78 36.7 72 C 34.4 65.5 32.4 58.5 31.9 50.5 Z",
    },
  ],
  "lower-back": [
    // Erector strip alongside the spine.
    {
      view: "back",
      bilateral: true,
      d: "M 47.5 66 C 48.5 66 48.85 66.5 48.9 68 L 48.9 95.5 C 48 97.5 46.6 97.5 45.9 95.7 C 45.5 88.5 45.6 77 46.1 70 C 46.4 67.5 46.8 66.2 47.5 66 Z",
    },
  ],
  triceps: [
    {
      view: "back",
      bilateral: true,
      d: "M 26.4 48.5 C 28.7 49 30.1 52 30 56.5 C 29.9 61.5 28.6 66.5 26.4 70 C 24.4 68.8 23.2 65 23.4 60 C 23.6 55 24.6 50.5 26.4 48.5 Z",
    },
  ],
  glutes: [
    {
      view: "back",
      bilateral: true,
      d: "M 41.4 100.5 C 45.7 100 48.7 102 49.1 106.5 C 49.5 112 48.1 118 44.7 121.5 C 40.7 124.5 36.2 123.5 34.4 119.5 C 32.9 115.5 33.2 109.5 35.2 105.5 C 36.7 102.5 38.7 101 41.4 100.5 Z",
    },
  ],
  hamstrings: [
    {
      view: "back",
      bilateral: true,
      d: "M 41.7 126 C 45.1 125.5 47.4 127 47.9 131 C 48.6 139 47.9 149 45.9 156 C 44.9 159.5 43.1 161.5 41.1 161 C 38.6 160.2 36.9 156 36.1 149 C 35.3 141.5 35.7 133 37.6 128.5 C 38.7 126.8 40.1 126.2 41.7 126 Z",
    },
  ],
  calves: [
    {
      view: "back",
      bilateral: true,
      d: "M 41.7 166 C 44.4 166.5 46 170 45.9 175.5 C 45.8 182 44.4 189 42.1 193.5 C 40.1 190 38.4 184 38.1 177 C 37.9 171.5 39.1 167.2 41.7 166 Z",
    },
  ],
};
