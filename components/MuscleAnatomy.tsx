import { muscleLabel, MUSCLE_IDS, type MuscleId } from "@/lib/lifts";
import {
  BODY_OUTLINE,
  MIRROR_TRANSFORM,
  MUSCLE_PATHS,
  VIEW_H,
  VIEW_W,
  type AnatomyView,
} from "@/lib/muscle-anatomy-paths";

// The MuscleAnatomy figure (#737): a hand-authored, self-contained inline SVG
// (front + back stylized bodies, every `MuscleId` mapped to paths in
// lib/muscle-anatomy-paths.ts) rendered in one of three modes. The component is
// a pure FORMATTER — all attribution comes from existing computations
// (`LiftDef.primaryMuscles`/`secondaryMuscles`, #736's `musclesWorked` /
// `coverageFromSets`); it computes nothing of its own (#221/#482).
//
// Accessibility (never color-only): every muscle group carries a `<title>` (the
// native hover tooltip, the pattern the app already uses for e.g. the cardio
// intensity mix) plus an aria-label, and the HOSTING surface's text list always
// accompanies the figure — the figure layers on top of the permanent list-first
// rendering (#736), it never replaces it.
//
// No hooks/handlers, so it renders in both Server Component hosts (Training →
// Overview) and client trees (ExerciseDetailPanel's guide section).

export interface AnatomyCoverageEntry {
  muscle: MuscleId;
  sets: number;
  /**
   * Optional explicit fill for this muscle — the swappable fill source. The
   * Training → Overview host populates it with the SHARED #742 palette
   * (`bandPresentation(bandVerdict(muscle, sets)).color`) so the figure tints by
   * band verdict and matches the coverage-list chips — the coordinated-palette
   * outcome, host-only, no component rework. Left absent, the default intensity
   * ramp (set volume vs the window max) applies as the fallback.
   */
  color?: string | null;
}

export type MuscleAnatomyProps =
  | {
      /** Per-exercise: primary saturated, secondary muted (pure LiftDef lookup). */
      mode: "exercise";
      primary: MuscleId[];
      secondary: MuscleId[];
      className?: string;
    }
  | {
      /** Per-session: the union of muscles a logged session's sets worked (#736 musclesWorked). */
      mode: "session";
      worked: MuscleId[];
      className?: string;
    }
  | {
      /** Weekly coverage: heat per muscle from #736 coverageFromSets; absent muscles render the neutral empty tint. */
      mode: "coverage";
      coverage: AnatomyCoverageEntry[];
      className?: string;
    };

// Default coverage ramp color — emerald-500, the same hue as the coverage
// list's bars, readable on both themes.
const RAMP_COLOR = "#10b981";

// Theme-aware fills. The base/untrained tint and the exercise-mode emphases are
// Tailwind fill classes (so they adapt to dark via the `dark:` variant); the
// coverage ramp is an inline mid-tone color that reads on both themes.
const BASE_FILL = "fill-slate-300/60 dark:fill-white/15";
const ACTIVE_FILL = "fill-brand-600 dark:fill-brand-500";
const SECONDARY_FILL = "fill-brand-600/40 dark:fill-brand-500/45";
const BODY_FILL = "fill-slate-200/70 dark:fill-white/[0.07]";

// Whole set counts plainly, half-credit (secondary muscles) with one decimal.
function fmtSets(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

interface MuscleRender {
  state: string; // data-state, for structural (non-pixel) assertions
  fillClass?: string;
  fill?: string;
  fillOpacity?: number;
  title: string;
}

function renderPlan(props: MuscleAnatomyProps): Map<MuscleId, MuscleRender> {
  const plan = new Map<MuscleId, MuscleRender>();
  if (props.mode === "exercise") {
    const primary = new Set(props.primary);
    const secondary = new Set(props.secondary);
    for (const m of MUSCLE_IDS) {
      const label = muscleLabel(m);
      if (primary.has(m)) {
        plan.set(m, {
          state: "primary",
          fillClass: ACTIVE_FILL,
          title: `${label} — primary`,
        });
      } else if (secondary.has(m)) {
        plan.set(m, {
          state: "secondary",
          fillClass: SECONDARY_FILL,
          title: `${label} — secondary`,
        });
      } else {
        plan.set(m, { state: "none", fillClass: BASE_FILL, title: label });
      }
    }
  } else if (props.mode === "session") {
    const worked = new Set(props.worked);
    for (const m of MUSCLE_IDS) {
      const label = muscleLabel(m);
      plan.set(
        m,
        worked.has(m)
          ? {
              state: "worked",
              fillClass: ACTIVE_FILL,
              title: `${label} — worked this session`,
            }
          : { state: "none", fillClass: BASE_FILL, title: label }
      );
    }
  } else {
    const byMuscle = new Map(props.coverage.map((c) => [c.muscle, c]));
    const maxSets = props.coverage.reduce((m, c) => Math.max(m, c.sets), 0);
    for (const m of MUSCLE_IDS) {
      const label = muscleLabel(m);
      const entry = byMuscle.get(m);
      if (!entry || entry.sets <= 0) {
        // Untrained muscles get the neutral empty tint — absence of data, not
        // an alarm.
        plan.set(m, {
          state: "untrained",
          fillClass: BASE_FILL,
          title: `${label} — not trained`,
        });
      } else {
        const title = `${label} — ${fmtSets(entry.sets)} ${entry.sets === 1 ? "set" : "sets"}`;
        plan.set(
          m,
          entry.color
            ? // Explicit fill from the host (e.g. the #742 verdict palette).
              { state: "trained", fill: entry.color, fillOpacity: 0.9, title }
            : // Default intensity ramp over the window's max set volume.
              {
                state: "trained",
                fill: RAMP_COLOR,
                fillOpacity:
                  0.3 + 0.7 * (maxSets > 0 ? entry.sets / maxSets : 0),
                title,
              }
        );
      }
    }
  }
  return plan;
}

const VIEW_GAP = 12; // gutter between the two bodies
const CAPTION_H = 14; // room for the Front/Back captions

function BodyView({
  view,
  plan,
}: {
  view: AnatomyView;
  plan: Map<MuscleId, MuscleRender>;
}) {
  const outline = BODY_OUTLINE[view];
  return (
    <>
      {/* Silhouette: fill-only left half + mirrored twin (no stroke → no seam). */}
      <path d={outline} className={BODY_FILL} />
      <path d={outline} className={BODY_FILL} transform={MIRROR_TRANSFORM} />
      {MUSCLE_IDS.map((m) => {
        const shapes = MUSCLE_PATHS[m].filter((s) => s.view === view);
        if (shapes.length === 0) return null;
        const r = plan.get(m)!;
        return (
          <g
            key={m}
            data-muscle={m}
            data-state={r.state}
            aria-label={r.title}
            className={r.fillClass}
            fill={r.fill}
            fillOpacity={r.fillOpacity}
          >
            {/* Native hover/tap tooltip naming the muscle (never color-only). */}
            <title>{r.title}</title>
            {shapes.map((s, i) => (
              <g key={i}>
                <path d={s.d} />
                {s.bilateral && <path d={s.d} transform={MIRROR_TRANSFORM} />}
              </g>
            ))}
          </g>
        );
      })}
    </>
  );
}

export default function MuscleAnatomy(props: MuscleAnatomyProps) {
  const plan = renderPlan(props);
  const width = 2 * VIEW_W + VIEW_GAP;
  const modeLabel =
    props.mode === "exercise"
      ? "muscles this exercise works"
      : props.mode === "session"
        ? "muscles this session worked"
        : "weekly muscle coverage";
  return (
    <svg
      viewBox={`0 0 ${width} ${VIEW_H + CAPTION_H}`}
      role="img"
      aria-label={`Muscle diagram (front and back): ${modeLabel}`}
      data-testid="muscle-anatomy"
      data-mode={props.mode}
      className={props.className}
    >
      <g>
        <BodyView view="front" plan={plan} />
      </g>
      <g transform={`translate(${VIEW_W + VIEW_GAP},0)`}>
        <BodyView view="back" plan={plan} />
      </g>
      <text
        x={VIEW_W / 2}
        y={VIEW_H + 10}
        textAnchor="middle"
        fontSize={7}
        className="fill-slate-400 dark:fill-slate-500"
      >
        Front
      </text>
      <text
        x={VIEW_W + VIEW_GAP + VIEW_W / 2}
        y={VIEW_H + 10}
        textAnchor="middle"
        fontSize={7}
        className="fill-slate-400 dark:fill-slate-500"
      >
        Back
      </text>
    </svg>
  );
}
