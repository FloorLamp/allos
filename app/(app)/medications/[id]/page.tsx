import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft } from "@tabler/icons-react";
import { getAccessibleProfiles, requireSession } from "@/lib/auth";
import {
  getProviderNames,
  getMedicationDoseHistory,
  resolveMedicationAcrossProfiles,
  encounterForRecord,
  getConditions,
} from "@/lib/queries";
import { encounterHref } from "@/lib/hrefs";
import { formatRecordDate } from "@/lib/record-format";
import { parseUtcSql, zonedDateParts } from "@/lib/date";
import {
  formatGivenAtClock,
  formatGivenAtClockWithRelativeAge,
} from "@/lib/administration-format";
import { MEDICATIONS_HREF } from "@/lib/hrefs";
import { getDisplayFormatPrefs, getUnitPrefs } from "@/lib/settings";
import { PageHeader } from "@/components/ui";
import PageContainer from "@/components/PageContainer";
import ProviderDatalist from "@/components/ProviderDatalist";
import ProfileIdentityBanner from "@/components/ProfileIdentityBanner";
import {
  loadMedicationsData,
  getMedicationAdherenceCalendar,
} from "../med-data";
import MedicationCard from "../MedicationCard";

export const dynamic = "force-dynamic";

// The medication clinical-record detail page (#817) — the home for one med's whole
// lifecycle (course timeline, side effects, administration/adherence history,
// interaction + food guidance, refill/supply, "what is this" explainer, prescriber/
// pharmacy/Rx, edit/stop/restart). Reuses the rich MedicationCard as its body.
// Scoped like illness episode detail: a medication id resolves only across the viewer's
// ACCESSIBLE profiles, with each lookup retaining its profile_id predicate. This lets a
// caregiver follow a medication link from another household member's illness episode
// without switching first; an ungranted profile still 404s. Cross-profile medication
// detail is read-only until the caregiver explicitly chooses "Act as …" in the identity
// banner, keeping all existing medication actions tied to the acting profile.
export default async function MedicationDetailPage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ action?: string | string[] }>;
}) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const {
    login,
    profile: activeProfile,
    access: activeAccess,
  } = await requireSession();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const accessible = await getAccessibleProfiles();
  const resolved = resolveMedicationAcrossProfiles(
    accessible.map((profile) => profile.id),
    id
  );
  if (!resolved) notFound();
  const profileId = resolved.profileId;
  const subject = accessible.find((profile) => profile.id === profileId)!;
  const crossProfile = profileId !== activeProfile.id;
  const canWrite = !crossProfile && activeAccess === "write";
  const requestedAction = Array.isArray(searchParams.action)
    ? searchParams.action[0]
    : searchParams.action;
  const initialAction =
    canWrite && (requestedAction === "edit" || requestedAction === "stop")
      ? requestedAction
      : undefined;
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const data = loadMedicationsData(
    profileId,
    getUnitPrefs(login.id).weightUnit,
    formatPrefs.timeFormat
  );
  const m = id ? data.byId.get(id) : undefined;
  if (!m) notFound();

  const courseStarts = m.courses
    .map((course) => course.started_on)
    .filter((date): date is string => !!date);
  const courseStops = m.courses
    .map((course) => course.stopped_on)
    .filter((date): date is string => !!date);
  // A historical PRN administration is evidence that use began by that date. Let
  // the picker reach any past date; the write core moves the applicable course start
  // backward atomically. Scheduled medications retain strict course boundaries
  // because their adherence history is schedule-derived. A null scheduled start is
  // an open-ended course, so it intentionally supplies no picker minimum.
  const historyMinDate =
    m.med.as_needed === 1 ||
    m.courses.some((course) => course.started_on == null)
      ? undefined
      : courseStarts.sort()[0];
  const historyMaxDate = m.courses.some((course) => !course.stopped_on)
    ? data.todayStr
    : (courseStops.sort().at(-1) ?? data.todayStr);

  // Taken-dose history for every medication, not only PRN. Exact intake time
  // + snapshotted amount make a newly backfilled dose visible immediately in History.
  const doseHistory = getMedicationDoseHistory(
    profileId,
    m.med.id,
    historyMinDate ?? "0001-01-01"
  ).map((dose) => {
    const storedTime = dose.given_at ?? dose.taken_at;
    const instant = parseUtcSql(storedTime);
    return {
      id: dose.id,
      doseId: dose.dose_id,
      date: dose.date,
      // Legacy scheduled logs may have only `taken_at`, which is the time the row
      // was recorded rather than the date represented by `l.date`. Only attach
      // relative age when the dose's logical date is today; otherwise its adjacent
      // date already supplies the useful context and "just now" would be false.
      time:
        dose.date === data.todayStr
          ? formatGivenAtClockWithRelativeAge(
              data.tz,
              storedTime,
              formatPrefs.timeFormat,
              new Date(data.nowIso)
            )
          : formatGivenAtClock(data.tz, storedTime, formatPrefs.timeFormat),
      timeValue: instant ? zonedDateParts(data.tz, instant).hhmm : "",
      amount: dose.amount,
      product: dose.product,
    };
  });

  // Month adherence calendar (#852 item 5) — only for a SCHEDULED med; a PRN med is
  // never scheduled-due, so its grid would read entirely "not due".
  const calendar =
    m.med.as_needed === 1
      ? null
      : getMedicationAdherenceCalendar(profileId, m.med.id);

  // "Prescribed at: <visit>" (#1050) — the deterministic tier-1 link (a resolved
  // FHIR MedicationRequest.encounter) or a user-accepted suggestion, whichever set
  // this med's encounter_id. Since #1178 the medication IS the single prescription
  // entity, so its own encounter link is the sole source (no source_record_id chain).
  const prescribedAt = encounterForRecord(profileId, "medication", m.med.id);
  // Conditions for the "For condition…" indication picker (#1052) on the edit form.
  const medConditions = getConditions(profileId).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="medication-detail"
    >
      {canWrite ? <ProviderDatalist names={getProviderNames()} /> : null}
      <div className="mb-4">
        <ProfileIdentityBanner
          profile={subject}
          crossProfile={crossProfile}
          testIdPrefix="medication"
        />
      </div>
      {!crossProfile ? (
        <Link
          href={MEDICATIONS_HREF}
          className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:text-slate-400 dark:hover:text-brand-400"
        >
          <IconArrowLeft className="h-4 w-4" />
          Back to medications
        </Link>
      ) : null}
      <PageHeader title={m.med.name} subtitle={m.med.brand ?? undefined} />
      {crossProfile ? (
        <p
          className="mb-4 text-sm text-slate-500 dark:text-slate-400"
          data-testid="medication-cross-profile-note"
        >
          Viewing {subject.name}&apos;s medication. Act as {subject.name} to
          make changes or view their full medication list.
        </p>
      ) : null}
      {prescribedAt ? (
        <p
          className="mb-4 text-sm text-slate-600 dark:text-slate-300"
          data-testid="medication-prescribed-at"
        >
          Prescribed at:{" "}
          <Link
            href={encounterHref(prescribedAt.id)}
            className="font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            {prescribedAt.type || "Visit"},{" "}
            {formatRecordDate(prescribedAt.date, "", formatPrefs)}
            {prescribedAt.providerName ? ` — ${prescribedAt.providerName}` : ""}
          </Link>
        </p>
      ) : null}
      <MedicationCard
        supplement={m.med}
        doses={m.doses}
        allSupplements={data.allSupplements}
        stackItems={data.stackItems}
        pgxVariants={data.pgxVariants}
        pairs={m.pairs}
        takenDoseIds={data.taken}
        skippedDoseIds={data.skipped}
        due={m.due}
        courses={m.courses}
        sideEffects={m.sideEffects}
        strip={m.strip}
        refillRate={m.refillRate}
        todayStr={data.todayStr}
        nowIso={data.nowIso}
        trainingRestricted={data.trainingRestricted}
        suppressedFoodKeys={data.suppressedFoodKeys}
        prnDayLabel={m.prnDayLabel}
        prnAdministrations={m.prnAdministrations}
        doseHistory={doseHistory}
        prnRedoseLine={m.prnRedoseLine}
        prnRedosePrimary={m.prnRedosePrimary}
        monitoringLabs={m.monitoringLabs}
        pediatric={data.pediatric}
        age={data.age}
        adherenceCalendar={calendar}
        takenDoseTimes={m.takenDoseTimes}
        timezone={data.tz}
        historyMinDate={historyMinDate}
        historyMaxDate={historyMaxDate}
        defaultHistoryTime={data.nowHhmm}
        canWrite={canWrite}
        initialAction={initialAction}
        conditions={medConditions}
      />
      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        For reference only. {MEDICAL_DISCLAIMER}
      </p>
    </PageContainer>
  );
}
