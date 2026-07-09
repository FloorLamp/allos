import {
  displayedStandards,
  STANDARD_LEVELS,
  type Standard,
} from "@/lib/strength";
import type { Sex } from "@/lib/types";
import ScrollFade from "@/components/ScrollFade";

// Reference table: estimated 1RM as a multiple of bodyweight for each level, so
// users can see what the per-exercise "Level" labels mean. Optionally highlights
// the row for the lift the user clicked and the cell for its current level.
// `sex` selects the sex-appropriate standards column (defaults to male/unspecified).
export default function StrengthStandards({
  highlightStandard,
  highlightLevel,
  sex,
}: {
  highlightStandard?: Standard;
  highlightLevel?: string;
  sex?: Sex | null;
}) {
  return (
    <div>
      <ScrollFade>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-black/5 dark:border-white/10">
              <th className="th">Lift</th>
              {STANDARD_LEVELS.map((l) => (
                <th key={l.label} className={`th ${l.color}`}>
                  {l.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayedStandards(sex).map(({ lift, standard }) => {
              const isRow =
                !!highlightStandard && standard === highlightStandard;
              return (
                <tr
                  key={lift}
                  className={`border-b border-black/5 dark:border-white/10 ${
                    isRow ? "bg-brand-50 dark:bg-brand-950/40" : ""
                  }`}
                >
                  <td className="td font-medium">{lift}</td>
                  {STANDARD_LEVELS.map((l) => {
                    const here = isRow && l.label === highlightLevel;
                    return (
                      <td
                        key={l.label}
                        className={`td tabular-nums ${
                          here
                            ? `font-semibold ${l.color}`
                            : "text-slate-600 dark:text-slate-300"
                        }`}
                      >
                        {standard[l.key]}×
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
        Estimated 1RM as a multiple of your bodyweight; anything below Novice is
        “Beginner”. Bodyweight pulls (Pull/Chin Up) count bodyweight as part of
        the load. Equipment variants (e.g. Barbell Bench Press) use their base
        lift’s standard.
      </p>
    </div>
  );
}
