import Link from "next/link";
import { encounterHref } from "@/lib/hrefs";
import { intakeHref } from "@/lib/hrefs";
import type { EpisodeInRangeEvents } from "@/lib/illness-episode-events";

// The in-range clinical events for an illness episode (issue #856 items 7-8): visits,
// appointments, medication courses started in-range, and documents/labs — each derived
// by date from the episode window and linked to its detail. Authed-page only (not shared).

function fmtDate(d: string): string {
  const dt = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
      });
}

export default function EpisodeInRangeEvents({
  events,
}: {
  events: EpisodeInRangeEvents;
}) {
  if (events.total === 0) return null;
  return (
    <div className="card mt-5" data-testid="episode-in-range-events">
      <h2 className="section-label mb-2">During this illness</h2>
      <ul className="flex flex-col gap-2 text-sm">
        {events.encounters.map((e) => (
          <li key={`enc-${e.id}`} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-slate-400">
              {fmtDate(e.date)}
            </span>
            <Link href={encounterHref(e.id)} className="link">
              {e.type || "Visit"}
              {e.reason ? ` — ${e.reason}` : ""}
            </Link>
          </li>
        ))}
        {events.appointments.map((a) => (
          <li key={`apt-${a.id}`} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-slate-400">
              {fmtDate(a.scheduledAt)}
            </span>
            <span className="text-slate-700 dark:text-slate-200">
              {a.title || "Appointment"}
            </span>
          </li>
        ))}
        {events.courses.map((c) => (
          <li key={`course-${c.id}`} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-slate-400">
              {fmtDate(c.startedOn)}
            </span>
            <Link href={intakeHref("medication")} className="link">
              Started {c.name}
            </Link>
          </li>
        ))}
        {events.documents.map((d) => (
          <li key={`doc-${d.id}`} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-slate-400">
              {fmtDate(d.date)}
            </span>
            <span className="text-slate-700 dark:text-slate-200">
              {d.docType || "Document"}: {d.filename}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
