import Link from "next/link";
import { IconChevronDown } from "@tabler/icons-react";
import Avatar from "@/components/Avatar";
import IntakeWarnings, { IntakeSafetyScope } from "@/components/IntakeWarnings";
import CardGroup, { CardGroupSection } from "@/components/CardGroup";
import { MEDICATIONS_HREF, type MedicationFilter } from "@/lib/hrefs";
import type { TimeFormat } from "@/lib/format-date";
import type { SubjectInfo } from "@/lib/scope";
import { medBoardId } from "@/lib/medication-multi-view";
import MedicationsTodayPanel from "./MedicationsTodayPanel";
import MedicationRow from "./MedicationRow";
import MedicationListActions from "./MedicationListActions";
import DormantPrnSweep from "./DormantPrnSweep";
import type { MedicationsData } from "./med-data";

// ONE member's regimen board (issue #1373 Part 1) — a scaled instance of the
// Medications page composition (Today panel · safety strip · current + past lists ·
// review). The multi-view page loop-composes `loadMedicationsData` PER member (each in
// that member's own timezone/today — the per-profile-context trap) and renders one of
// these per in-view member, acting first.
//
// ZERO-REGRESSION BY CONSTRUCTION: with `subject == null` (single-view) the board
// renders EXACTLY today's page body — the bare `space-y-5` stack, no subject header,
// every write affordance live. The header + the per-member write gates engage only
// when a subject is stamped (multi-view). Every new prop defaults to the single-view
// value, so a single-profile login's page is byte-identical.
//
// Write reach (the #1096 write-centric rule + #858 dose gate):
//   • Dose confirms (Today panel scheduled check-off + PRN log) target THIS member via
//     the #858 profileId gate, enabled for a write-granted member (canConfirm).
//   • Deep management (edit/stop/restart/delete/refill, dormant-PRN sweep, share/print)
//     carries no cross-profile seam, so it stays ACTING-ONLY (act-as to manage another
//     member) — rendered only on the acting board.
//   • The safety strip renders each member's OWN warnings; its dismiss bus is acting-
//     targeted, so the dismiss control shows only on the acting board.
// A read-only-granted member's board is fully view-only: no confirm, no management.
export default function MedicationBoard({
  data,
  timeFormat,
  filter,
  subject,
  profileId,
  isActing,
  canWrite,
}: {
  data: MedicationsData;
  timeFormat: TimeFormat;
  filter: MedicationFilter | null;
  // The row's owning member (#534 disambiguated). Null in single-view → no header,
  // byte-identical body.
  subject: SubjectInfo | null;
  profileId: number;
  // Whether THIS board is the acting profile's (deep management + dismiss reach).
  isActing: boolean;
  // Whether the viewer may WRITE this member (dose-confirm reach). A read-only member
  // → view-only board.
  canWrite: boolean;
}) {
  // Dose confirms carry the member's profileId ONLY on a non-acting board; on the
  // acting board they omit it (fall back to the active profile — byte-identical).
  const confirmProfileId = isActing ? undefined : profileId;

  const shownCurrent =
    filter === "needs-rxcui"
      ? data.current.filter((m) => !m.med.rxcui || !m.med.rxcui.trim())
      : data.current;
  const hasReviewItems =
    data.dormantPrn.length > 0 || data.dismissedDormantPrn.length > 0;
  const hasSafetyWarnings =
    data.interactionWarnings.length > 0 ||
    data.pgxWarnings.length > 0 ||
    data.ototoxicWarnings.length > 0 ||
    data.allergyWarnings.length > 0;

  const body = (
    <div className="space-y-5">
      {/* 1. Today panel (leads). */}
      <MedicationsTodayPanel
        scheduled={data.current}
        prnToday={data.prnToday}
        taken={data.taken}
        skipped={data.skipped}
        nowHhmm={data.nowHhmm}
        nowIso={data.nowIso}
        timeFormat={timeFormat}
        timezone={data.tz}
        profileId={confirmProfileId}
        canWrite={canWrite}
      />

      {/* 2. Safety strip — this member's own interaction (#144) / PGx / ototoxic /
      allergy warnings, keyed on the SAME dedupeKeys as their own surfaces. Dismiss is
      acting-only (the bus has no cross-profile target). */}
      <IntakeWarnings
        interactionWarnings={data.interactionWarnings}
        pgxWarnings={data.pgxWarnings}
        ototoxicWarnings={data.ototoxicWarnings}
        allergyWarnings={data.allergyWarnings}
        coverage={data.coverage}
        dismissable={isActing}
      />

      {/* 3. Current medications stay primary; Past collapses below. Under the
      needs-rxcui filter the list narrows to the unconfirmed slice. */}
      {filter === "needs-rxcui" && (
        <p
          className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300"
          data-testid="medications-filter-notice"
        >
          Showing medications without a confirmed RxNorm code — open each one
          and use “Find RxNorm code”.
          <Link
            href={MEDICATIONS_HREF}
            className="font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            Show all
          </Link>
        </p>
      )}
      <CardGroup
        title="Current medications"
        description={`${shownCurrent.length}${filter ? ` of ${data.current.length}` : ""} active medication${shownCurrent.length === 1 ? "" : "s"} · Dose schedules, refill status, and recent adherence.`}
        action={
          isActing && data.current.length > 0 ? (
            <MedicationListActions />
          ) : undefined
        }
        data-testid="medication-list"
      >
        <CardGroupSection>
          {shownCurrent.length > 0 ? (
            <div className="divide-y divide-black/5 dark:divide-white/5">
              {shownCurrent.map((m) => (
                <MedicationRow
                  key={m.med.id}
                  med={m.med}
                  doses={m.doses}
                  courses={m.courses}
                  sideEffects={m.sideEffects}
                  strip={m.strip}
                  refillRate={m.refillRate}
                  prnRedoseLine={m.prnRedoseLine}
                  monitoringNote={m.monitoringNote}
                  heldBy={m.heldBy}
                  todayStr={data.todayStr}
                  canWrite={isActing}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {filter === "needs-rxcui"
                ? "Every current medication has a confirmed RxNorm code."
                : "No current medications yet."}
            </p>
          )}
        </CardGroupSection>
      </CardGroup>

      {data.past.length > 0 && !filter ? (
        <details className="card group" data-testid="past-medications">
          <summary className="-m-2 flex w-[calc(100%+1rem)] cursor-pointer list-none items-center justify-between gap-4 rounded-lg p-2 outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500/40 [&::-webkit-details-marker]:hidden dark:hover:bg-ink-850">
            <span className="min-w-0">
              <span className="block text-base font-semibold text-slate-700 dark:text-slate-200">
                Past medications
              </span>
              <span className="mt-1 block text-sm text-slate-500 dark:text-slate-400">
                {data.past.length} completed or stopped
              </span>
            </span>
            <IconChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180 dark:text-slate-400" />
          </summary>
          <div className="mt-5 divide-y divide-black/5 border-t border-black/5 pt-1 dark:divide-white/5 dark:border-white/5">
            {data.past.map((m) => (
              <MedicationRow
                key={m.med.id}
                med={m.med}
                doses={m.doses}
                courses={m.courses}
                sideEffects={m.sideEffects}
                strip={m.strip}
                refillRate={m.refillRate}
                prnRedoseLine={m.prnRedoseLine}
                todayStr={data.todayStr}
                canWrite={isActing}
              />
            ))}
          </div>
        </details>
      ) : null}

      {/* 4. Maintenance suggestions — acting-only (no cross-profile seam). */}
      {isActing && hasReviewItems ? (
        <CardGroup
          title="Review medication list"
          description="Resolve medications that may no longer be current."
          data-testid="medication-review"
        >
          {(data.dormantPrn.length > 0 ||
            data.dismissedDormantPrn.length > 0) && (
            <CardGroupSection>
              <DormantPrnSweep
                suggestions={data.dormantPrn}
                dismissed={data.dismissedDormantPrn}
              />
            </CardGroupSection>
          )}
        </CardGroup>
      ) : null}

      {!hasSafetyWarnings ? (
        <IntakeSafetyScope coverage={data.coverage} />
      ) : null}
    </div>
  );

  // Single-view: byte-identical to today (no wrapper, no header).
  if (subject == null) return body;

  // Multi-view: a labelled board — disambiguated name (#534) + an RO badge on a
  // read-only grant (so a member knows why the board shows no controls), then the
  // same body. The DOM id anchors the leading strip's per-item jumps.
  return (
    <section
      id={medBoardId(profileId)}
      data-testid={`med-board-${profileId}`}
      className="scroll-mt-4"
    >
      <div
        className="mb-3 flex items-center gap-2"
        data-testid={`med-board-header-${profileId}`}
      >
        <Avatar
          profile={{
            id: subject.profileId,
            name: subject.name,
            photo_path: subject.photoPath,
            photo_version: subject.photoVersion,
          }}
          size="sm"
        />
        <h2 className="min-w-0 truncate text-lg font-semibold text-slate-800 dark:text-slate-100">
          {subject.name}
        </h2>
        {subject.access === "read" && (
          <span
            data-testid={`med-board-ro-${profileId}`}
            className="shrink-0 rounded-full bg-amber-100 px-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          >
            RO
          </span>
        )}
      </div>
      {body}
    </section>
  );
}
