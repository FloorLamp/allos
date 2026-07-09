import Link from "next/link";
import { IconArrowRight } from "@tabler/icons-react";
import { getUnitPrefs, getUserFullName } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import Tabs from "@/components/Tabs";
import UploadForm from "@/components/UploadForm";
import ImportClient, { ImportJobList } from "@/components/ImportClient";
import IntegrationsGrid from "@/components/IntegrationsGrid";
import DataExport from "@/components/DataExport";
import ReviewInbox from "@/components/ReviewInbox";
import { getImportJobs } from "@/app/(app)/data/actions";
import {
  getImportFeed,
  getImportIssues,
  getActivityDuplicates,
  getBodyMetricConflicts,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

// The consolidated data hub (issues #208 + #212): one "Data" umbrella for
// everything you do with your data. The "Import" tab is every way to bring data
// in (upload a document, paste a workout/lab log, connect a device/service) plus
// the unified, profile-scoped import log — each entry drilling into a verify +
// debug view of what it produced. The "Manage & Export" tab (the former
// standalone Data page content) browses and exports everything you've logged,
// with per-dataset CSV download and row edit/delete. The active tab is
// deep-linkable via ?section= (import | manage); /import redirects here.
export default async function DataPage() {
  const { login, profile } = requireSession();
  const units = getUnitPrefs(login.id);
  const importJobs = await getImportJobs();
  // The unified import feed (syncs + documents + paste jobs) behind Review.
  const importFeed = getImportFeed(profile.id);
  const importIssues = getImportIssues(profile.id);
  // Detected, still-unresolved duplicate/conflict pairs (issue #10, Phase 2).
  const activityPairs = getActivityDuplicates(profile.id);
  const bodyMetricPairs = getBodyMetricConflicts(profile.id);
  const reviewPairCount = activityPairs.length + bodyMetricPairs.length;
  // The profile's own name(s), for the document provenance-mismatch flag.
  const knownNames = [getUserFullName(profile.id), profile.name];

  const importTab = (
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
                label: "File Upload (incl. CSV)",
                content: (
                  <div>
                    <h2 className="font-semibold text-slate-800 dark:text-slate-100">
                      Upload a lab report, scan, or health-record export
                    </h2>
                    <UploadForm />
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

      {/* Connect a device or service — the full integrations surface (the
          standalone /integrations page was folded in here; each card links to
          its per-provider setup page under /integrations/<id>). */}
      <div className="card">
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
            See everything you&apos;ve uploaded, pasted, or synced — and resolve
            duplicates — in the Review tab.
          </p>
        </div>
        <IconArrowRight className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" />
      </Link>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Data"
        subtitle="Bring data in — upload documents, paste logs, or connect a device — then browse, manage, and export everything you've logged."
      />

      <Tabs
        paramKey="section"
        tabs={[
          { id: "import", label: "Import", content: importTab },
          {
            id: "review",
            label:
              importIssues.length + reviewPairCount > 0
                ? `Review (${importIssues.length + reviewPairCount})`
                : "Review",
            content: (
              <ReviewInbox
                issues={importIssues}
                feed={importFeed}
                knownNames={knownNames}
                activityPairs={activityPairs}
                bodyMetricPairs={bodyMetricPairs}
                units={units}
                isAdmin={login.role === "admin"}
              />
            ),
          },
          {
            id: "manage",
            label: "Manage & Export",
            content: <DataExport />,
            // The heaviest panel (serializes every dataset for browse/export);
            // only mount it client-side when its tab is active. It reads its own
            // data and holds no state another tab depends on.
            keepMounted: false,
          },
        ]}
      />
    </div>
  );
}
