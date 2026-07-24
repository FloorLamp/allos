import Link from "next/link";
import Avatar, { type AvatarProfile } from "@/components/Avatar";
import { episodeHref, encounterHref } from "@/lib/hrefs";
import { fmtTemp } from "@/lib/units";
import type { TemperatureUnit } from "@/lib/settings";
import { formatRecordDate } from "@/lib/record-format";
import { MONTHS_LONG } from "@/lib/date";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  careTrailRowSortDate,
  type CareTrailRow,
  type CareTrailEpisode,
  type CareTrailLinkedVisit,
  type CareTrailNestedCourse,
} from "@/lib/care-trail";

// The grouped, de-blanded care-trail list (#1373 Part 2): month/year group headers over
// the merged rows, each episode carrying its nested linked visits + medication courses in
// episode-relative time ("Day 2 — Urgent care, Dr. Ng"; "Day 2 — started Amoxicillin ·
// Completed"). Unlinked visits (illness+visits mode) interleave as standalone rows. A
// FORMATTER over the pre-built rows — the nesting/day math is one computation (lib/care-trail.ts).
//
// Chips ride ON each row (#531/#534, #1327): a member avatar + disambiguated name renders
// only for NON-ACTING members in multi-view; single-view shows no chip.

interface RowSubject {
  name: string;
  profile: AvatarProfile;
}

function monthKey(row: CareTrailRow): string {
  const d = careTrailRowSortDate(row);
  return d ? d.slice(0, 7) : "";
}

// Locale-free "Month Year" (the app never leaks the server locale — #964/#1020).
function monthLabel(key: string): string {
  if (!key) return "Undated";
  const [y, m] = key.split("-");
  return `${MONTHS_LONG[Number(m) - 1]} ${y}`;
}

function MemberChip({ subject }: { subject: RowSubject }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
      <Avatar profile={subject.profile} size="sm" />
      {subject.name}
    </span>
  );
}

function LinkedVisitRow({ visit }: { visit: CareTrailLinkedVisit }) {
  const label = [visit.type || "Visit", visit.providerName]
    .filter(Boolean)
    .join(", ");
  return (
    <li>
      <Link
        href={encounterHref(visit.encounterId)}
        className="flex items-center gap-2 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-ink-800"
        data-testid="care-trail-linked-visit"
        data-encounter-id={visit.encounterId}
      >
        {visit.dayNumber != null && (
          <span className="font-medium text-slate-500 dark:text-slate-400">
            Day {visit.dayNumber}
          </span>
        )}
        <span className="text-slate-400">—</span>
        <span>{label}</span>
      </Link>
    </li>
  );
}

function CourseRow({ course }: { course: CareTrailNestedCourse }) {
  return (
    <li
      className="flex flex-wrap items-center gap-2 px-2 py-1 text-xs text-slate-600 dark:text-slate-300"
      data-testid="care-trail-course"
      data-course-id={course.courseId}
    >
      {course.dayNumber != null && (
        <span className="font-medium text-slate-500 dark:text-slate-400">
          Day {course.dayNumber}
        </span>
      )}
      <span className="text-slate-400">—</span>
      <span>
        started <span className="font-medium">{course.medName}</span>
      </span>
      <span
        className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
        data-testid="care-trail-course-state"
      >
        {course.stateLabel}
      </span>
      {course.overhangDays > 0 && (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          continued {course.overhangDays}d past
        </span>
      )}
      {course.chainVisit && (
        <span
          className="text-xs text-slate-500 dark:text-slate-400"
          data-testid="care-trail-course-chain"
        >
          prescribed at the
          {course.chainVisit.dayNumber != null
            ? ` Day-${course.chainVisit.dayNumber}`
            : ""}{" "}
          visit
        </span>
      )}
    </li>
  );
}

function EpisodeRow({
  ep,
  subject,
  temperatureUnit,
  prefs,
}: {
  ep: CareTrailEpisode;
  subject: RowSubject | null;
  temperatureUnit: TemperatureUnit;
  prefs: DisplayFormatPrefs;
}) {
  const range = `${formatRecordDate(ep.firstDay, "—", prefs)} – ${
    ep.ongoing ? "ongoing" : formatRecordDate(ep.lastActiveDay, "—", prefs)
  }`;
  return (
    <li>
      <div
        className="card block"
        data-testid="care-trail-row"
        data-kind="episode"
        data-profile-id={ep.profileId}
      >
        <Link
          href={episodeHref(ep.episodeId)}
          className="block transition hover:opacity-90"
          data-testid="care-trail-episode-link"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
              {subject && (
                <>
                  <MemberChip subject={subject} />
                  <span className="text-slate-400">·</span>
                </>
              )}
              {ep.situation}
            </span>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {range}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            {ep.dayCount != null && <span>{ep.dayCount}-day</span>}
            {ep.maxTempF != null && (
              <span>peak {fmtTemp(ep.maxTempF, temperatureUnit)}</span>
            )}
            {ep.symptomLabels.length > 0 && (
              <span>
                {ep.symptomLabels.slice(0, 4).join(", ")}
                {ep.symptomLabels.length > 4 ? "…" : ""}
              </span>
            )}
            {ep.linkedVisitCount > 0 && (
              <span
                className="font-medium text-sky-700 dark:text-sky-300"
                data-testid="care-trail-link-count"
              >
                {ep.linkedVisitCount} linked visit
                {ep.linkedVisitCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </Link>
        {(ep.linkedVisits.length > 0 || ep.courses.length > 0) && (
          <ul className="mt-2 border-l-2 border-black/5 pl-3 dark:border-ink-700">
            {ep.linkedVisits.map((v) => (
              <LinkedVisitRow key={`v-${v.encounterId}`} visit={v} />
            ))}
            {ep.courses.map((c) => (
              <CourseRow key={`c-${c.courseId}`} course={c} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

function UnlinkedVisitRow({
  encounterId,
  type,
  reason,
  providerName,
  date,
  subject,
  prefs,
}: {
  encounterId: number;
  type: string | null;
  reason: string | null;
  providerName: string | null;
  date: string;
  subject: RowSubject | null;
  prefs: DisplayFormatPrefs;
}) {
  return (
    <li>
      <Link
        href={encounterHref(encounterId)}
        className="card block transition hover:shadow-md"
        data-testid="care-trail-row"
        data-kind="visit"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 font-semibold text-slate-800 dark:text-slate-100">
            {subject && (
              <>
                <MemberChip subject={subject} />
                <span className="text-slate-400">·</span>
              </>
            )}
            Visit
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {formatRecordDate(date, "—", prefs)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          {type && <span>{type}</span>}
          {reason && <span>{reason}</span>}
          {providerName && <span>{providerName}</span>}
        </div>
      </Link>
    </li>
  );
}

export default function CareTrailList({
  rows,
  subjectById,
  actingProfileId,
  multi,
  temperatureUnit,
  formatPrefs,
}: {
  rows: CareTrailRow[];
  subjectById: Map<number, RowSubject>;
  actingProfileId: number;
  multi: boolean;
  temperatureUnit: TemperatureUnit;
  formatPrefs: DisplayFormatPrefs;
}) {
  // Chip only for a NON-ACTING member in multi-view (#1327).
  const chipFor = (profileId: number): RowSubject | null =>
    multi && profileId !== actingProfileId
      ? (subjectById.get(profileId) ?? null)
      : null;

  // Group by month, descending (rows already sorted newest-first).
  const groups: { key: string; rows: CareTrailRow[] }[] = [];
  for (const row of rows) {
    const key = monthKey(row);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }

  return (
    <div className="space-y-6" data-testid="care-trail-list">
      {groups.map((g) => (
        <div key={g.key || "undated"}>
          <h3 className="section-label mb-2">{monthLabel(g.key)}</h3>
          <ul className="flex flex-col gap-2">
            {g.rows.map((row) =>
              row.kind === "episode" ? (
                <EpisodeRow
                  key={`e-${row.episodeId}`}
                  ep={row}
                  subject={chipFor(row.profileId)}
                  temperatureUnit={temperatureUnit}
                  prefs={formatPrefs}
                />
              ) : (
                <UnlinkedVisitRow
                  key={`v-${row.encounterId}`}
                  encounterId={row.encounterId}
                  type={row.type}
                  reason={row.reason}
                  providerName={row.providerName}
                  date={row.date}
                  subject={chipFor(row.profileId)}
                  prefs={formatPrefs}
                />
              )
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}
