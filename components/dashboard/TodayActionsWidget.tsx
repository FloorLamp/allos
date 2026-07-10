import type { DigestModel } from "@/lib/notifications/digest";

// Today's actions (NEW) — surfaces the pre-built morning-digest model
// (doses/goals due today, yesterday's recap, newly-flagged biomarkers + new docs)
// right on the dashboard. `model` is null when the digest has nothing to say, in
// which case the card reads "All clear".
export default function TodayActionsWidget({
  model,
}: {
  model: DigestModel | null;
}) {
  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Today&apos;s actions
        </h2>
      </div>
      {!model ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          All clear — nothing needs your attention right now.
        </p>
      ) : (
        <div className="space-y-4">
          {model.sections.map((section) => (
            <div key={section.heading}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {section.heading}
              </div>
              <ul className="space-y-1">
                {section.lines.map((line, i) => (
                  <li
                    key={i}
                    className="text-sm text-slate-700 dark:text-slate-200"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
