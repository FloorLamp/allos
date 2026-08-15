import type { DisplayFormatPrefs } from "@/lib/format-date";
import { formatMonthDay } from "@/lib/format-date";
import type { FiberSymptomPanel as PanelModel } from "@/lib/fiber-symptom-panel";
import { severityLabelFor, symptomLabel } from "@/lib/symptoms";

// The fiber × GI-symptom read-together panel (issue #2788): the daily fiber series
// and the GI-symptom days on ONE time axis, so the reader can draw their own
// connection — the app draws none. A pure formatter over the panel model
// (lib/fiber-symptom-panel.ts, where the vocabulary and the #2385 declaration live):
// no computed correlation, no verdict copy, no finding, no send. Server-rendered,
// no client JS — a day's detail is its title text.
//
// Encoding: one column per calendar day. The bar is the day's fiber grams (a floor
// when not tracked, #976); a day with no fiber signal renders a neutral baseline tick
// (an honest absence occupying its calendar position, #2258), never a zero-gram bar.
// A GI-symptom day carries a dot under its column, sized by the day's worst severity —
// size plus title text, never color alone (#1220).

// Dot size per worst severity (1–4). Size is the encoding; the title names it.
const SEVERITY_DOT: Record<number, string> = {
  1: "h-1 w-1",
  2: "h-1.5 w-1.5",
  3: "h-2 w-2",
  4: "h-2.5 w-2.5",
};

function dayTitle(
  date: string,
  grams: number | null,
  symptoms: { symptom: string; severity: number }[],
  formatPrefs: DisplayFormatPrefs
): string {
  const day = formatMonthDay(date, formatPrefs);
  const fiber = grams == null ? "no fiber logged" : `${Math.round(grams)} g`;
  const marks = symptoms
    .map(
      (s) =>
        `${symptomLabel(s.symptom)} (${severityLabelFor(s.symptom, s.severity)})`
    )
    .join(", ");
  return marks ? `${day} · ${fiber} · ${marks}` : `${day} · ${fiber}`;
}

export default function FiberSymptomPanel({
  panel,
  formatPrefs,
}: {
  panel: PanelModel;
  formatPrefs: DisplayFormatPrefs;
}) {
  const first = panel.days[0];
  const last = panel.days[panel.days.length - 1];
  if (!first || !last) return null;
  return (
    <div
      data-testid="fiber-symptom-panel"
      className="border-t border-black/5 pt-5 dark:border-white/5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="section-label">Fiber &amp; gut symptoms</h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Last 4 weeks
        </span>
      </div>
      <div
        className="mt-2 flex items-end gap-px"
        data-testid="fiber-symptom-strip"
      >
        {panel.days.map((day) => {
          const worst = day.symptoms[0]?.severity ?? 0;
          return (
            <div
              key={day.date}
              data-testid={`fiber-symptom-day-${day.date}`}
              data-grams={day.grams == null ? undefined : Math.round(day.grams)}
              data-symptoms={day.symptoms.length || undefined}
              role="img"
              aria-label={dayTitle(
                day.date,
                day.grams,
                day.symptoms,
                formatPrefs
              )}
              title={dayTitle(day.date, day.grams, day.symptoms, formatPrefs)}
              className="flex min-w-0 flex-1 flex-col items-center gap-0.5"
            >
              <div className="flex h-14 w-full items-end">
                {day.grams == null ? (
                  // No fiber signal that day — an honest empty slot at its own
                  // calendar position, not a zero-gram claim.
                  <div className="h-px w-full rounded-sm bg-slate-200 dark:bg-slate-700" />
                ) : (
                  <div
                    className="w-full rounded-sm bg-emerald-500/70 dark:bg-emerald-400/70"
                    style={{
                      height: `${Math.max(4, Math.round((Math.min(day.grams, panel.maxGrams) / panel.maxGrams) * 100))}%`,
                    }}
                  />
                )}
              </div>
              <div className="flex h-3 items-center">
                {worst > 0 && (
                  <span
                    className={`inline-block rounded-full bg-amber-500 dark:bg-amber-400 ${
                      SEVERITY_DOT[worst] ?? SEVERITY_DOT[4]
                    }`}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span>{formatMonthDay(first.date, formatPrefs)}</span>
        <span>{formatMonthDay(last.date, formatPrefs)}</span>
      </div>
      {/* What the marks ARE — the encoding, never a connection between the series. */}
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Bars: fiber per day, {Math.round(panel.maxGrams)} g at full height — a
        floor unless tracked. Dots: days with diarrhea, bloating, or abdominal
        pain logged; a bigger dot is a worse day.
      </p>
    </div>
  );
}
