import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import {
  getTrashRetentionDays,
  getUnitPrefs,
  getProfileFullName,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { PageHeader } from "@/components/ui";
import Tabs from "@/components/Tabs";
import NavTabs from "@/components/NavTabs";
import UploadForm from "@/components/UploadForm";
import ImportClient, { ImportJobList } from "@/components/ImportClient";
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
  getQuietStreamRows,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

const SECTIONS = ["import", "review", "coverage", "manage", "trash"] as const;
type Section = (typeof SECTIONS)[number];

function parseSection(value: string | string[] | undefined): Section {
  const first = Array.isArray(value) ? value[0] : value;
  return SECTIONS.includes(first as Section) ? (first as Section) : "import";
}

// The consolidated data hub: one "Data" umbrella for
// everything you do with your data. The "Import" tab is every way to bring data
// in (upload a document, paste a workout/lab log, connect a device/service) plus
// the unified, profile-scoped import log — each entry drilling into a verify +
// debug view of what it produced. The "Manage & Export" tab (the former
// standalone Data page content) browses and exports everything you've logged,
// with per-dataset CSV download and row edit/delete. The "Coverage" tab (issue
// #1086) is the catalog-coverage-gaps workflow (formerly /coverage, then briefly
// /records#coverage) — biomarkers/meds/conditions the curated catalogs don't cover
// yet, with the track/enrich/request paths — a data-management workflow about the
// app's coverage of your data, not a clinical record. The "Trash" tab (issue #2013)
// is the rendered view over the restorable capture every destructive delete has
// written since #30 — deleted rows, restorable for an admin-configured window, with
// per-row "Delete permanently" and "Empty trash". The active tab is deep-linkable via
// ?section= (import | review | coverage | manage | trash); /import and /coverage
// redirect here.
export default async function DataPage(
  props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const searchParams = await props.searchParams;
  const { login, profile, access } = await requireSession();
  const units = getUnitPrefs(login.id);
  const section = parseSection(searchParams.section);
  // Demo mode (#181): disable the medical-upload input (a PHI-entry vector) with a
  // hint. The write is already blocked server-side; this is the UX on top.
  const demo = isDemoRestricted(isDemoMode(), login.role);

  // The Review tab's badge count is cheap (duplicate/conflict detection over the
  // activities/body_metrics tables) and needed on the tab strip regardless of the
  // active section, so it's always computed. The heavier per-section data is built
  // only for the active section below.
  const importIssues = getImportIssues(profile.id);
  const activityClusters = getActivityDuplicateClusters(profile.id);
  const bodyMetricPairs = getBodyMetricConflicts(profile.id);
  // Probable power-of-ten unit mislabels (issue #761) — each a one-click Review card.
  const unitMislabels = getUnitMislabelReviews(profile.id);
  const reviewCount =
    importIssues.length +
    activityClusters.length +
    bodyMetricPairs.length +
    unitMislabels.length;

  // Build ONLY the active section server-side (issue #113, mirroring the #109
  // /trends fix): passing every section as a prop rendered — and ran the queries
  // for — all three on every /data request, including the Manage panel that
  // serialized every dataset in full. NavTabs switches sections via a URL
  // navigation, so each request computes one section.
  let activeSection: React.ReactNode;
  if (section === "manage") {
    activeSection = <DataExport searchParams={searchParams} />;
  } else if (section === "trash") {
    // Recently deleted (#2013) — the rendered view over the `deleted_rows` capture
    // that has existed since #30 behind nothing but a 15-second toast. Built only
    // when active: it parses one payload per capture, which is no work to do on an
    // Import or Review request. The retention window is instance policy read from
    // global settings (Settings → Server, admin-only).
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
    activeSection = (
      <ReviewInbox
        issues={importIssues}
        // A source syncing green while one of its continuous streams went quiet
        // (#2146). Built only for the ACTIVE Review section — it is two indexed seeks
        // per declared stream, but nothing on the Import or Manage request needs it —
        // and deliberately absent from `reviewCount` above: a coaching-tier
        // observation must not inflate an escalation badge.
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
            <Tabs
              tabs={[
                {
                  id: "upload",
                  label: "File upload (incl. CSV)",
                  content: (
                    <div>
                      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                        Upload a lab report, scan, or health-record export
                      </h2>
                      <UploadForm demo={demo} />
                    </div>
                  ),
                },
                {
                  id: "paste",
                  label: "Paste CSV",
                  content: (
                    <ImportClient units={{ weightUnit: units.weightUnit }} />
                  ),
                },
              ]}
            />
          </div>

          <ImportJobList jobs={importJobs} unit={units.weightUnit} />
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
        <div id="integrations" className="card scroll-mt-4">
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
        <Link
          href="/data?section=review"
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
          <IconArrowRight className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
        </Link>
      </div>
    );
  }

  const tabStrip = [
    { id: "import", label: "Import" },
    { id: "review", label: reviewCount > 0 ? `Review (${reviewCount})` : "Review" },
    { id: "coverage", label: "Coverage" },
    { id: "manage", label: "Manage & export" },
    { id: "trash", label: "Trash" },
  ];

  return (
    <div>
      <PageHeader
        title="Data"
        subtitle="Bring data in — upload documents, paste logs, or connect a device — then browse, manage, and export everything you've logged."
      />

      <NavTabs paramKey="section" tabs={tabStrip}>
        {activeSection}
      </NavTabs>
    </div>
  );
}
