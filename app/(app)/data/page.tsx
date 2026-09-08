import { DATA_SECTIONS, dataSectionHref } from "@/lib/hrefs";
import DestinationLink from "@/components/DestinationLink";
import {
  getTrashRetentionDays,
  getUnitPrefs,
  getProfileFullName,
  getProfileAge,
} from "@/lib/settings";
import { isStrengthTrainingRelevant } from "@/lib/life-stage";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import TabFirstPage from "@/components/TabFirstPage";
import PageContainer from "@/components/PageContainer";
import { DATA_TAB_FIRST_PAGE } from "@/components/tab-first-pages";
import { ImportJobList } from "@/components/ImportClient";
import ImportMethodTabs from "@/app/(app)/data/ImportMethodTabs";
import IntegrationsGrid from "@/components/IntegrationsGrid";
import StreamLifecycleOffers from "@/components/integrations/StreamLifecycleOffers";
import DataExport from "@/components/DataExport";
import ReviewInbox from "@/components/ReviewInbox";
import CoverageSection from "@/app/(app)/data/CoverageSection";
import TrashSection from "@/app/(app)/data/TrashSection";
import { getImportJobs } from "@/app/(app)/data/actions";
import { listDocumentTombstones } from "@/lib/document-tombstones";
import { listCorrectionSources } from "@/lib/bulk-correction-db";
import { isCorrectionFieldId } from "@/lib/bulk-correction";
import {
  getImportDocumentsFeed,
  getConnectedSources,
  getImportIssues,
  getActivityDuplicateClusters,
  getBodyMetricConflicts,
  getUnitMislabelReviews,
  getUnreadableDoseAmounts,
  getOverlappingSleepSessions,
  getQuietStreamRows,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

function parseSection(value: string | string[] | undefined) {
  const first = Array.isArray(value) ? value[0] : value;
  return DATA_SECTIONS.find((section) => section === first) ?? "import";
}

// Each deep-linked section loads only its own profile-scoped data.
export default async function DataPage(
  props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const searchParams = await props.searchParams;
  const { login, profile, access } = await requireSession();
  const units = getUnitPrefs(login.id);
  const strengthTrainingAvailable = isStrengthTrainingRelevant(
    getProfileAge(profile.id)
  );
  const section = parseSection(searchParams.section);
  // Demo mode (#181): disable the medical-upload input (a PHI-entry vector) with a
  // hint. The write is already blocked server-side; this is the UX on top.
  const demo = isDemoRestricted(isDemoMode(), login.role);

  let activeSection: React.ReactNode;
  if (section === "manage") {
    activeSection = <DataExport searchParams={searchParams} />;
  } else if (section === "trash") {
    // Retention is instance policy; capture payloads are read only in this tab.
    activeSection = (
      <TrashSection
        profileId={profile.id}
        retentionDays={getTrashRetentionDays()}
      />
    );
  } else if (section === "coverage") {
    // Coverage gaps (#550/#1086) — built only when active because it runs a
    // Light-tier AI blurb + a candidate scan across biomarkers/meds/conditions.
    activeSection = <CoverageSection profileId={profile.id} />;
  } else if (section === "review") {
    // A contextual "Fix a range…" link (e.g. from the Body weight chart) lands
    // here with ?fix=<field> to pre-select the bulk-correction panel's field.
    const rawFix = Array.isArray(searchParams.fix)
      ? searchParams.fix[0]
      : searchParams.fix;
    const importIssues = getImportIssues(profile.id);
    const activityClusters = getActivityDuplicateClusters(profile.id);
    const bodyMetricPairs = getBodyMetricConflicts(profile.id);
    // Probable power-of-ten unit mislabels (issue #761) — each a one-click Review card.
    const unitMislabels = getUnitMislabelReviews(profile.id);
    activeSection = (
      <ReviewInbox
        issues={importIssues}
        // A source syncing green while one of its continuous streams went quiet
        // (#2146). Built only for the ACTIVE Review section — it is two indexed seeks
        // per declared stream, but nothing on the Import or Manage request needs it —
        // and deliberately absent from the nav's escalation badge (#1801): a
        // coaching-tier observation must not inflate it.
        quietStreams={getQuietStreamRows(profile.id, login.id)}
        // The recurring per-source streams for the "Connected sources" section.
        sources={getConnectedSources(profile.id)}
        // The one-off "Imports" feed (documents + archives + paste jobs) behind Review.
        feed={getImportDocumentsFeed(profile.id)}
        // Documents this profile deleted, whose re-acquisition an acquirer is refused
        // (#1777) — rendered so the standing block is findable and reversible.
        blockedDocuments={listDocumentTombstones(profile.id)}
        // The profile's own name(s), for the document provenance-mismatch flag.
        knownNames={[getProfileFullName(profile.id), profile.name]}
        activityClusters={activityClusters}
        bodyMetricPairs={bodyMetricPairs}
        unitMislabels={unitMislabels}
        unreadableDoseAmounts={getUnreadableDoseAmounts(profile.id)}
        // Sleep sessions of one origin that overlap (#3628) — a night stored twice
        // that the ingest collapse could not settle from the device's heart rate.
        overlappingSleep={getOverlappingSleepSessions(profile.id)}
        // Bulk corrections (#1603): the "Fix a run of data" panel's source runs.
        correctionSources={listCorrectionSources(profile.id)}
        initialCorrectionField={isCorrectionFieldId(rawFix) ? rawFix : null}
        units={units}
        isAdmin={login.role === "admin"}
      />
    );
  } else {
    const importJobs = await getImportJobs();
    activeSection = (
      <div className="space-y-6">
        {/* One card, two ways to bring data in: upload a file (documents +
            spreadsheets/CSV → the medical-document pipeline) or paste a
            CSV / log (→ a reviewable extraction job). The paste flow's
            in-flight review cards render below, always visible. */}
        <section id="paste-import" className="scroll-mt-4 space-y-4">
          <div className="card">
            <ImportMethodTabs
              demo={demo}
              weightUnit={units.weightUnit}
              workoutImportAvailable={strengthTrainingAvailable}
            />
          </div>

          <ImportJobList
            jobs={importJobs}
            unit={units.weightUnit}
            workoutImportAvailable={strengthTrainingAvailable}
          />
        </section>

        {/* The continuous-stream on/offboarding offer (#2162), directly above the
            integrations surface — the post-connect moment, since this is the page a
            user is on when a newly connected wearable starts delivering. Class 2 and
            one-shot: answered in a tap, then gone. Renders nothing when no offer is
            live, which is almost always. */}
        <StreamLifecycleOffers
          profileId={profile.id}
          canWrite={access === "write"}
          className=""
        />

        {/* Connect a device or service — the full integrations surface (the
            standalone /integrations page was folded in here; each card links to
            its per-source setup page under /integrations/<id>). */}
        {/* NO CARD SHELL HERE (#3466 class B). `IntegrationsGrid` renders one
            `.card` per source, so a `.card` wrapper drew a border around a grid of
            borders — and on a phone it also charged the grid a second 16px gutter
            for the privilege. The heading below is a SECTION header on the canvas,
            which is what the other tab sections already do. */}
        <div id="integrations" className="scroll-mt-4">
          <div className="mb-3">
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Connect a device or service
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Sync activities, steps, and vitals automatically.
            </p>
          </div>
          <IntegrationsGrid profileId={profile.id} />
        </div>

        {/* The import history now lives in one place — the Review tab's unified
            feed — so there's a single source of truth for everything imported
            (documents, pastes, and background syncs), not two competing logs. */}
        <DestinationLink
          href={dataSectionHref("review")}
          className="card flex items-center justify-between gap-3 transition hover:border-brand-300 dark:hover:border-brand-800"
        >
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Import history &amp; review
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              See everything you&apos;ve uploaded, pasted, or synced — and
              resolve duplicates — in the Review tab.
            </p>
          </div>
        </DestinationLink>
      </div>
    );
  }

  return (
    <PageContainer width="wide" className="mx-auto">
      <TabFirstPage config={DATA_TAB_FIRST_PAGE} testId="data-page">
        {activeSection}
      </TabFirstPage>
    </PageContainer>
  );
}
