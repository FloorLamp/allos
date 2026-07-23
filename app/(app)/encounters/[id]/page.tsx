import Link from "next/link";
import { notFound } from "next/navigation";
import {
  IconArrowLeft,
  IconBuildingHospital,
  IconFileText,
} from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  getEncounter,
  linkedRowsForEncounter,
  suggestionsForEncounter,
  episodeForLinkedEncounter,
} from "@/lib/queries";
import { episodeForProfileDate } from "@/lib/illness-episode";
import { episodeHref } from "@/lib/hrefs";
import { daysBetweenDateStr } from "@/lib/date";
import FromThisVisit from "@/components/visit-links/FromThisVisit";
import { formatRecordDate, sourceLabel } from "@/lib/record-format";
import { classLabel, encounterTypeDisplay } from "@/lib/encounter-kind";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import NotesText from "@/components/NotesText";
import ProviderName from "@/components/ProviderName";
import OpenInMaps from "@/components/OpenInMaps";
import type { Encounter } from "@/lib/types";

export const dynamic = "force-dynamic";

// Visit detail: the full record for a single encounter —
// dates, type/class, chief complaint, diagnoses, attending clinician + facility,
// the free-text visit notes, and provenance. Reached from the Visits list and from
// a Timeline visit entry (both deeplink to /encounters/[id]). Profile-scoped: the
// query filters BOTH id AND profile_id, so guessing another profile's id 404s.
//
// All CCD-derived text (reason / diagnoses / notes) renders as plain React children
// — escaped by default, never dangerouslySetInnerHTML — so nothing in an imported
// record can inject markup.

function dateLabel(e: Encounter, fmt: DisplayFormatPrefs): string {
  const start = formatRecordDate(e.date, "", fmt);
  if (e.end_date && e.end_date !== e.date)
    return `${start} – ${formatRecordDate(e.end_date, "", fmt)}`;
  return start;
}

function diagnosisList(diagnoses: string | null): string[] {
  if (!diagnoses) return [];
  return diagnoses
    .split(/\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-slate-800 dark:text-slate-100">
        {children}
      </dd>
    </div>
  );
}

export default async function EncounterDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { login, profile } = await requireSession();
  const fmt = getDisplayFormatPrefs(login.id);
  const id = Number(params.id);
  const encounter = id ? getEncounter(profile.id, id) : null;
  if (!encounter) notFound();

  const diagnoses = diagnosisList(encounter.diagnoses);
  // Reverse episode association (#856 items 7-8): if this visit's date falls inside an
  // illness episode, chip a link back to it. Derived by date — no FK.
  const episode = episodeForProfileDate(profile.id, encounter.date);
  // The EXPLICIT episode ↔ visit link (#1053): when this visit was accepted as an
  // episode's resulting encounter, show a "During illness episode: …, day N" back-link
  // (day computed from the episode's start). Distinct from the date-derived chip above.
  const linkedEpisode = episodeForLinkedEncounter(profile.id, encounter.id);
  const linkedEpisodeDay =
    linkedEpisode?.started_at != null
      ? (daysBetweenDateStr(linkedEpisode.started_at, encounter.date) ?? 0) + 1
      : null;
  // From-this-visit rows already linked + the read-time "From this visit?" suggestions
  // (#1050). The linked rows/suggestions target the ACTIVE profile's encounter.
  const linkedRows = linkedRowsForEncounter(profile.id, encounter.id);
  const visitSuggestions = suggestionsForEncounter(profile.id, encounter.id);

  return (
    <PageContainer width="reading" data-testid="encounter-detail">
      <Link
        href="/records/history/visits"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
      >
        <IconArrowLeft className="h-4 w-4" stroke={1.75} />
        Back to visits
      </Link>

      <PageHeader
        title={encounterTypeDisplay(encounter.type, encounter.class_code)}
        subtitle={dateLabel(encounter, fmt)}
      />

      {linkedEpisode ? (
        <Link
          href={episodeHref(linkedEpisode.id)}
          className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-300"
          data-testid="encounter-episode-backlink"
        >
          During illness episode: {linkedEpisode.situation}
          {linkedEpisodeDay != null ? `, day ${linkedEpisodeDay}` : ""}
        </Link>
      ) : episode && episode.id != null ? (
        <Link
          href={episodeHref(episode.id)}
          className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-300"
          data-testid="encounter-episode-chip"
        >
          During {episode.situation} episode
        </Link>
      ) : null}

      <div className="rounded-xl border border-black/5 bg-white/60 p-4 shadow-sm sm:p-6 dark:border-white/10 dark:bg-black/10">
        <dl className="divide-y divide-black/5 dark:divide-white/10">
          {encounter.class_code ? (
            <DetailRow label="Class">
              <span className="badge bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
                {classLabel(encounter.class_code)}
              </span>
            </DetailRow>
          ) : null}

          {encounter.reason ? (
            <DetailRow label="Chief complaint">
              <span data-testid="encounter-reason">{encounter.reason}</span>
            </DetailRow>
          ) : null}

          <DetailRow label="Diagnoses">
            {diagnoses.length > 0 ? (
              <div
                className="flex flex-wrap gap-1.5"
                data-testid="encounter-diagnoses"
              >
                {diagnoses.map((d, i) => (
                  <span
                    key={i}
                    className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                  >
                    {d}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </DetailRow>

          {encounter.provider_name ? (
            <DetailRow label="Provider">
              <ProviderName
                name={encounter.provider_name}
                providerId={encounter.provider_id}
                className=""
              />
            </DetailRow>
          ) : null}

          {encounter.location_name ? (
            <DetailRow label="Facility">
              {encounter.location_provider_id ? (
                <Link
                  href={`/providers/${encounter.location_provider_id}`}
                  className="inline-flex items-center gap-1.5 hover:text-brand-700 hover:underline dark:hover:text-brand-300"
                >
                  <IconBuildingHospital
                    className="h-4 w-4 shrink-0"
                    stroke={1.75}
                  />
                  {encounter.location_name}
                </Link>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <IconBuildingHospital
                    className="h-4 w-4 shrink-0"
                    stroke={1.75}
                  />
                  {encounter.location_name}
                </span>
              )}
              {encounter.location_address ? (
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {encounter.location_address}
                  {" · "}
                  <OpenInMaps
                    address={encounter.location_address}
                    label="Directions"
                    showIcon={false}
                    className="text-brand-700 hover:underline dark:text-brand-300"
                  />
                </div>
              ) : null}
            </DetailRow>
          ) : null}

          <DetailRow label="Notes">
            {encounter.notes ? (
              <NotesText
                as="p"
                notes={encounter.notes}
                className="leading-relaxed"
                data-testid="encounter-notes"
              />
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </DetailRow>

          <DetailRow label="Source">
            <div className="flex flex-col items-start gap-1.5">
              <span
                className="text-slate-500 dark:text-slate-400"
                data-testid="encounter-source"
              >
                {sourceLabel(encounter.source)}
              </span>
              {encounter.document_id ? (
                <Link
                  href={`/import/${encounter.document_id}`}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 transition hover:underline dark:text-brand-300"
                >
                  <IconFileText className="h-3.5 w-3.5" stroke={1.75} />
                  View source document
                </Link>
              ) : null}
            </div>
          </DetailRow>
        </dl>
      </div>

      <FromThisVisit
        profileId={profile.id}
        encounterId={encounter.id}
        linkedRows={linkedRows}
        suggestions={visitSuggestions}
      />

      <p className="mt-4 px-1 text-xs text-slate-500 dark:text-slate-400">
        Imported visits come from uploaded health records (CCD Encounters
        section).
      </p>
    </PageContainer>
  );
}
