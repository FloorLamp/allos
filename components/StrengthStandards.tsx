import {
  levelFloors,
  strengthLevelLabel,
  strengthLevelColor,
  DISPLAYED_STRENGTH_LIFTS,
  type StrengthLevel,
} from "@/lib/strength-standards";
import type { Sex } from "@/lib/types";
import ScrollFade from "@/components/ScrollFade";

// The named level columns (ascending). "Untrained" is the implicit standing below
// the beginner floor, so it isn't a column.
const LEVEL_COLUMNS: StrengthLevel[] = [
  "beginner",
  "novice",
  "intermediate",
  "advanced",
  "elite",
];

// Reference table: estimated 1RM as a multiple of bodyweight for each level, so
// users can see what the per-exercise "Level" labels mean. Thresholds come from
// the SAME bodyweight-band model that places the lifter (lib/strength-standards),
// interpolated at the viewer's bodyweight, so the row/level highlighted here is the
// one the badge showed. Optionally highlights the row for the clicked lift and the
// cell for its current level. `sex` selects the sex-appropriate table.
export default function StrengthStandards({
  highlightLift,
  highlightLevel,
  sex,
  bodyweightKg,
}: {
  highlightLift?: string;
  highlightLevel?: StrengthLevel;
  sex?: Sex | null;
  bodyweightKg?: number | null;
}) {
  // Resolve every displayed lift's floors at the viewer's bodyweight (falls back
  // to the sex reference bodyweight when unknown). A lift with no table for this
  // sex is skipped. Without a sex there's nothing to show.
  const rows = sex
    ? DISPLAYED_STRENGTH_LIFTS.map((lift) =>
        levelFloors(lift, sex, bodyweightKg)
      ).filter((r): r is NonNullable<typeof r> => r != null)
    : [];
  // The highlighted lift resolved to its canonical base (so "Barbell Bench Press"
  // highlights the "Bench Press" row).
  const highlightBase =
    highlightLift && sex
      ? (levelFloors(highlightLift, sex, bodyweightKg)?.lift ?? null)
      : null;

  if (rows.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Set a sex on your profile to see strength standards.
      </p>
    );
  }

  return (
    <div>
      <ScrollFade>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/5 dark:border-white/10">
              <th className="th">Lift</th>
              {LEVEL_COLUMNS.map((lvl) => (
                <th key={lvl} className={`th ${strengthLevelColor(lvl)}`}>
                  {strengthLevelLabel(lvl)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isRow = row.lift === highlightBase;
              const byLevel = new Map(
                row.floors.map((f) => [f.level, f.floorKg])
              );
              return (
                <tr
                  key={row.lift}
                  className={`border-b border-black/5 dark:border-white/10 ${
                    isRow ? "bg-brand-50 dark:bg-brand-950/40" : ""
                  }`}
                >
                  <td className="td font-medium">{row.lift}</td>
                  {LEVEL_COLUMNS.map((lvl) => {
                    const floorKg = byLevel.get(lvl) ?? 0;
                    const ratio = floorKg / row.bodyweightKg;
                    const here = isRow && lvl === highlightLevel;
                    return (
                      <td
                        key={lvl}
                        className={`td tabular-nums ${
                          here
                            ? `font-semibold ${strengthLevelColor(lvl)}`
                            : "text-slate-600 dark:text-slate-300"
                        }`}
                      >
                        {ratio.toFixed(2)}×
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollFade>
      <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
        Estimated 1RM as a multiple of your bodyweight, adjusted for your
        bodyweight and sex; anything below Beginner is “Untrained”. Bodyweight
        pulls (Pull/Chin Up) count bodyweight as part of the load. Equipment
        variants (e.g. Barbell Bench Press) use their base lift’s standard.
      </p>
    </div>
  );
}
