import Link from "next/link";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { episodeHref, encounterHref } from "@/lib/hrefs";
import type { Swimlane } from "@/lib/care-trail-swimlane";

// The care-trail "at-a-glance band" (#1373 Part 2): trailing-window per-member swimlanes,
// one lane per in-view member, illness episodes as duration bars + visits as point markers
// on the SAME horizontal time axis — so same-date lands at the same x and cross-member
// overlap ("Riley then Sam two days later") reads as geometry. Pure CSS over the
// pre-computed layout model (lib/care-trail-swimlane.ts); no client JS.
//
// House dataviz rules: never color-only — every bar/marker carries a title tooltip and
// the lane its member label; theme-aware in both modes; the band lives in its own
// overflow-x container so the PAGE body never scrolls horizontally (#1063). Collapses
// (renders nothing) for sparse data — the caller checks `swimlane.hasData`.

// Peak-severity tint for an episode bar: hotter fever → warmer bar. Fever-free episodes
// stay a neutral illness tint. Labels/tooltips carry the real meaning (never color-only).
function barTone(maxTempF: number | null): string {
  if (maxTempF != null && maxTempF >= 102)
    return "bg-rose-500/80 dark:bg-rose-500/70";
  if (maxTempF != null && maxTempF >= 100.4)
    return "bg-amber-500/80 dark:bg-amber-500/70";
  return "bg-sky-500/70 dark:bg-sky-500/60";
}

export default function CareTrailBand({
  swimlane,
  subjectById,
  temperatureLabel,
}: {
  swimlane: Swimlane;
  // Disambiguated identity (#534) for each in-view member, in lane order.
  subjectById: Map<number, { name: string; profile: AvatarProfile }>;
  // A short "past 12 months" style caption for the axis.
  temperatureLabel: string;
}) {
  return (
    <section
      className="card"
      data-testid="care-trail-band"
      aria-label="Illness and visit timeline"
    >
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          At a glance
        </h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {temperatureLabel}
        </span>
      </div>
      {/* The page body never scrolls horizontally — the band scrolls inside itself. */}
      <div className="overflow-x-auto">
        <div className="min-w-[36rem] space-y-3">
          {swimlane.lanes.map((lane) => {
            const subject = subjectById.get(lane.profileId);
            return (
              <div
                key={lane.profileId}
                className="flex items-center gap-3"
                data-testid="care-trail-lane"
                data-profile-id={lane.profileId}
              >
                <div className="flex w-28 shrink-0 items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                  {subject && <Avatar profile={subject.profile} size="sm" />}
                  <span className="truncate">{subject?.name ?? "—"}</span>
                </div>
                {/* The lane track. Episode bars are absolutely positioned by percent;
                the baseline holds unlinked visit markers. */}
                <div className="relative h-8 flex-1 rounded bg-slate-100 dark:bg-ink-800">
                  {/* baseline */}
                  <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-slate-200 dark:bg-ink-700" />
                  {lane.episodes.map((bar) => (
                    <Link
                      key={`e-${bar.episodeId}`}
                      href={episodeHref(bar.episodeId)}
                      data-testid="care-trail-bar"
                      data-episode-id={bar.episodeId}
                      title={`${bar.situation}${
                        bar.ongoing ? " (ongoing)" : ""
                      }`}
                      className={`absolute top-1 flex h-3 items-center rounded-sm ${barTone(
                        bar.maxTempF
                      )} ${bar.ongoing ? "ring-1 ring-inset ring-white/70" : ""}`}
                      style={{
                        left: `${bar.leftPct}%`,
                        width: `${bar.widthPct}%`,
                      }}
                    >
                      {/* linked visit markers ON the bar */}
                      {bar.visitMarkers.map((m) => {
                        // position relative to the bar's own width
                        const rel =
                          bar.widthPct > 0
                            ? ((m.pct - bar.leftPct) / bar.widthPct) * 100
                            : 0;
                        return (
                          <span
                            key={`m-${m.encounterId}`}
                            data-testid="care-trail-visit-marker"
                            data-linked="true"
                            title={`Visit${m.type ? ` — ${m.type}` : ""}${
                              m.dayNumber != null ? ` (Day ${m.dayNumber})` : ""
                            }`}
                            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-slate-800 dark:border-ink-900 dark:bg-white"
                            style={{
                              left: `${Math.max(0, Math.min(100, rel))}%`,
                            }}
                          />
                        );
                      })}
                    </Link>
                  ))}
                  {/* course sub-bars, beneath their episode bar */}
                  {lane.episodes.flatMap((bar) =>
                    bar.courseBars.map((c) => (
                      <span
                        key={`c-${c.courseId}`}
                        data-testid="care-trail-course-bar"
                        data-overhang={c.overhang}
                        title={`${c.medName}${c.overhang ? " (continues past illness)" : ""}`}
                        className={`absolute bottom-1 h-1.5 rounded-full ${
                          c.overhang
                            ? "bg-emerald-500/80 dark:bg-emerald-400/70"
                            : "bg-emerald-500/50 dark:bg-emerald-400/50"
                        }`}
                        style={{
                          left: `${c.leftPct}%`,
                          width: `${c.widthPct}%`,
                        }}
                      />
                    ))
                  )}
                  {/* unlinked visit markers on the baseline */}
                  {lane.visitMarkers.map((m) => (
                    <Link
                      key={`uv-${m.encounterId}`}
                      href={encounterHref(m.encounterId)}
                      data-testid="care-trail-visit-marker"
                      data-linked="false"
                      title={`Visit${m.type ? ` — ${m.type}` : ""}`}
                      className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-white bg-slate-400 dark:border-ink-900 dark:bg-slate-500"
                      style={{ left: `${m.pct}%` }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
