import { recapLineAnnotation, type Recap } from "@/lib/recap";

// The retrospective's body (#2179). A description list over the SAME `RecapLine[]` the
// dashboard recap card renders, annotated by the SAME `recapLineAnnotation` — so the
// year page, the weekly card and the Telegram recap can never annotate one line three
// different ways (#221). Nothing here decides content: which lines exist at year scale
// is `RECAP_LINE_MODEL`'s declaration, and whether a count carries a comparison is the
// commemorative exemption, already applied inside `buildRecap`.
export default function RetrospectiveLines({ recap }: { recap: Recap }) {
  return (
    <dl className="divide-y divide-black/5 dark:divide-white/5">
      {recap.lines.map((line) => {
        const annotation = recapLineAnnotation(line);
        return (
          <div
            key={line.key}
            className="flex items-baseline justify-between gap-4 py-3"
            data-testid="retrospective-line"
            data-line={line.key}
          >
            {/* A bare line is already self-labelled (#1935): the label stays for
                screen readers so the list keeps its pairs, but printing it would
                label the row twice. */}
            <dt
              className={
                line.bare
                  ? "sr-only"
                  : "text-sm text-slate-500 dark:text-slate-400"
              }
            >
              {line.label}
            </dt>
            <dd className={line.bare ? "min-w-0" : "min-w-0 text-right"}>
              <span
                className="font-semibold text-slate-800 dark:text-slate-100"
                data-testid="retrospective-line-value"
              >
                {line.value}
              </span>
              {annotation && (
                <span
                  className="ml-2 text-xs text-slate-500 dark:text-slate-400"
                  data-testid="retrospective-line-annotation"
                >
                  {annotation}
                </span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
