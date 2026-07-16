import {
  episodeDayNumber,
  episodeHeadline,
  feverTrend,
  feverTrendLabel,
  type AssembledEpisode,
} from "@/lib/illness-episode-format";
import { severityLabel } from "@/lib/symptoms";
import NotesText from "@/components/NotesText";

// The printable / shareable illness-episode summary (issue #801). A pure
// presentational server component over the ONE assembled model — reused by the
// authed detail page and the public /share render, so both tell the identical story.
// Dark-mode print legibility is automatic (#794 7c): `darkMode` is scoped to
// `@media not print`, so every `dark:` utility here stops matching under print and
// the light styles render on the forced-white page.

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, {
        timeZone: "UTC",
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

// The 1–4 severity as filled/empty dots — a compact, print-safe severity glyph.
function SeverityDots({ severity }: { severity: number }) {
  return (
    <span
      className="inline-flex gap-0.5 align-middle"
      title={severityLabel(severity)}
      aria-label={severityLabel(severity)}
    >
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={
            n <= severity
              ? "h-2 w-2 rounded-full bg-rose-500 dark:bg-rose-400"
              : "h-2 w-2 rounded-full bg-slate-200 dark:bg-ink-700"
          }
        />
      ))}
    </span>
  );
}

export default function EpisodeSummary({
  episode,
  note,
  outcome,
  generatedAt,
}: {
  episode: AssembledEpisode;
  // The episode-level free-text note + outcome annotation (#856 item 8/9). Optional so
  // the public /share render (which has no row) simply omits them.
  note?: string | null;
  outcome?: string | null;
  generatedAt?: string;
}) {
  const day = episodeDayNumber(
    episode.start,
    episode.lastActiveDay ?? episode.asOf
  );
  const fever = feverTrendLabel(feverTrend(episode.temperatures));

  return (
    <section className="flex flex-col gap-5">
      {/* Header */}
      <header className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">
            {episode.situation} episode
          </h1>
          <span
            className={
              episode.ongoing
                ? "badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                : "badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
            }
          >
            {episode.ongoing ? "Ongoing" : "Resolved"}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {episodeHeadline(episode)}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="section-label">Started</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {fmtDate(episode.start ?? episode.firstDay)}
            </dd>
          </div>
          <div>
            <dt className="section-label">
              {episode.ongoing ? "As of" : "Ended"}
            </dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {fmtDate(episode.lastActiveDay)}
            </dd>
          </div>
          <div>
            <dt className="section-label">Day</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {day != null ? day : "—"}
            </dd>
          </div>
          <div>
            <dt className="section-label">Peak temp</dt>
            <dd className="text-slate-700 dark:text-slate-200">
              {episode.maxTempF != null
                ? `${episode.maxTempF.toFixed(1)}°F`
                : "—"}
            </dd>
          </div>
        </dl>
        {outcome ? (
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">
            <span className="section-label mr-2">Outcome</span>
            {outcome}
          </p>
        ) : null}
        {note ? (
          <div className="mt-3">
            <div className="section-label mb-1">Episode note</div>
            <NotesText
              as="p"
              className="text-sm text-slate-600 dark:text-slate-300"
              notes={note}
            />
          </div>
        ) : null}
      </header>

      {/* Symptoms */}
      {episode.symptoms.length > 0 && (
        <div
          className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none"
          data-testid="episode-symptoms"
        >
          <h2 className="section-label mb-2">Symptoms</h2>
          <ul className="flex flex-col gap-2">
            {episode.symptoms.map((s) => (
              <li
                key={s.symptom}
                className="flex flex-wrap items-center gap-x-3 gap-y-1"
              >
                <span className="min-w-[9rem] text-sm font-medium text-slate-700 dark:text-slate-200">
                  {s.label}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {s.points.map((p) => (
                    <span
                      key={p.date}
                      className="inline-flex items-center gap-1"
                      title={`${fmtDate(p.date)} · ${severityLabel(p.severity)}`}
                    >
                      <SeverityDots severity={p.severity} />
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Fever curve */}
      {episode.temperatures.length > 0 && (
        <div
          className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none"
          data-testid="episode-fever"
        >
          <h2 className="section-label mb-2">
            Temperature{fever ? ` — ${fever}` : ""}
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {episode.temperatures.map((t, i) => (
              <li
                key={`${t.date}-${t.time ?? i}`}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-slate-500 dark:text-slate-400">
                  {fmtDate(t.date)}
                  {t.time ? ` · ${t.time}` : ""}
                </span>
                <span
                  className={
                    t.flag === "high"
                      ? "font-semibold text-rose-600 dark:text-rose-400"
                      : "text-slate-700 dark:text-slate-200"
                  }
                >
                  {t.degF.toFixed(1)}°F
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Medications */}
      {episode.medications.length > 0 && (
        <div
          className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none"
          data-testid="episode-meds"
        >
          <h2 className="section-label mb-2">Medications given</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {episode.medications.map((m) => (
              <li key={m.itemId}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {m.name}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {m.count}×
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {m.administrations
                    .map(
                      (a) =>
                        `${fmtDate(a.date)}${a.time ? ` ${a.time}` : ""}${
                          a.amount ? ` · ${a.amount}` : ""
                        }`
                    )
                    .join("  ·  ")}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Bridged conditions */}
      {episode.conditions.length > 0 && (
        <div className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none">
          <h2 className="section-label mb-2">Conditions</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {episode.conditions.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-slate-700 dark:text-slate-200">
                  {c.name}
                  {c.fromEpisode ? (
                    <span className="ml-2 text-xs text-slate-400">
                      (from this episode)
                    </span>
                  ) : null}
                </span>
                <span className="text-xs capitalize text-slate-500 dark:text-slate-400">
                  {c.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Notes */}
      {episode.notes.length > 0 && (
        <div className="card break-inside-avoid print:border print:border-slate-300 print:shadow-none">
          <h2 className="section-label mb-2">Notes</h2>
          <ul className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
            {episode.notes.map((n, i) => (
              <li key={`${n.date}-${i}`}>
                <span className="text-slate-400">{fmtDate(n.date)}</span> —{" "}
                {n.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {generatedAt && (
        <p className="text-xs text-slate-400">
          Generated {fmtDate(generatedAt.slice(0, 10))}. Illness summary — not a
          medical record.
        </p>
      )}
    </section>
  );
}
