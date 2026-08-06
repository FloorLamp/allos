import { notFound } from "next/navigation";
import Link from "next/link";
import { IconArrowLeft, IconBarbell, IconPill } from "@tabler/icons-react";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getProtocol,
  getProtocolOutcomePickerData,
  getProtocolPractice,
  getProtocolUsage,
  getProtocolAdherence,
  getProtocolIntakeOptions,
  getProtocolIntakeItem,
  getPracticeDayCount,
  getPracticeSessions,
  getPracticeSpellingsMap,
  isPredictedPracticeDay,
  practiceSpellingsFor,
} from "@/lib/queries";
import { getSituations } from "@/lib/settings";
import { mergedSituationOptions } from "@/lib/situations";
import { SituationOptionsProvider } from "@/components/SituationOptionsContext";
import { getEquipment, getEquipmentById } from "@/lib/equipment";
import { recoveryGearOptions } from "@/lib/protocol-gear";
import { getUnitPrefs } from "@/lib/settings";
import { intakeHref } from "@/lib/hrefs";
import { formatUsageSummary } from "@/lib/usage-format";
import {
  protocolPracticeLabel,
  protocolPracticeNoun,
} from "@/lib/protocol-practice";
import { protocolRelevantPanels } from "@/lib/protocol-outcome-picker";
import { practiceDurationPrefill } from "@/lib/practice";
import PracticeCardHeader from "@/components/practices/PracticeCardHeader";
import PracticeHistorySection from "@/components/practices/PracticeHistorySection";
import PracticeWeeklyProgress from "@/components/practices/PracticeWeeklyProgress";
import PageContainer from "@/components/PageContainer";
import ProtocolControls from "../ProtocolControls";
import ProtocolCompare from "../ProtocolCompare";
import ProtocolLogButton from "../ProtocolLogButton";
import {
  updateProtocol,
  updateProtocolOutcomes,
  endProtocol,
  resumeProtocol,
  runProtocolAgain,
  deleteProtocol,
} from "../actions";

export const dynamic = "force-dynamic";

// A single protocol's before/during detail. Scoped by (profile, id) so a guessed
// id from another profile 404s. The comparison is the pure engine's output
// (gathered per outcome metric in the query seam) rendered as panels. The
// practice/gear card (issue #344) shows the linked recovery gear, adherence (the
// SAME weekly-count computation the routine widget uses), and usage-during-window.
export default async function ProtocolDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { login, profile } = await requireSession();
  const id = Number(params.id);
  const protocol = id ? getProtocol(profile.id, id) : null;
  if (!protocol) notFound();

  const units = getUnitPrefs(login.id);
  const todayStr = today(profile.id);
  const { comparison, options } = getProtocolOutcomePickerData(
    profile.id,
    protocol,
    todayStr,
    units.weightUnit
  );
  const practice = getProtocolPractice(profile.id, protocol);
  const gear =
    protocol.equipment_id != null
      ? getEquipmentById(profile.id, protocol.equipment_id)
      : undefined;
  // "Recovery gear" (issue #592): offer recovery + uncategorized gear only (kindOf),
  // not the whole inventory. No blanket includeRetired — a retired device appears
  // solely as the currently-linked selectedMissing fallback (`gear`, resolved via
  // getEquipmentById which ignores the retired flag), never as a fresh choice, so an
  // edit keeps the existing link without resurfacing sold/broken gear for new picks.
  const equipment = recoveryGearOptions(getEquipment(profile.id), gear);
  const intakeItems = getProtocolIntakeOptions(profile.id);
  // The linked intervention supplement/medication (issue #660), resolved to its
  // name + kind (kind drives the surface its link points at). Null when unlinked or
  // the item was deleted.
  const intakeItem = getProtocolIntakeItem(profile.id, protocol.intake_item_id);
  const relevantPanelIds = [
    ...protocolRelevantPanels({
      practice: practice
        ? `${practice.scopeKind} ${practice.value}`
        : undefined,
      intakeItemName: intakeItem?.name,
    }),
  ];
  const adherence = getProtocolAdherence(profile.id, protocol);
  const practiceSpellings =
    practice?.scopeKind === "practice"
      ? practiceSpellingsFor(
          getPracticeSpellingsMap(profile.id),
          practice.value
        )
      : [];
  // Today's running session count for the one-tap widget (#1259), only for a wellness
  // practice — the count sits beside the Log button so a second tap is informed.
  const practiceTodayCount =
    practice?.scopeKind === "practice"
      ? getPracticeDayCount(
          profile.id,
          practice.value,
          todayStr,
          practiceSpellings
        )
      : 0;
  // The rhythm note (#2188): whether today is one of the practice's inferred
  // session days. False when no pattern exists (#558 — the note renders nowhere).
  const practiceUsuallyToday =
    practice?.scopeKind === "practice" &&
    isPredictedPracticeDay(profile.id, practice.value, todayStr) === true;
  const usage = getProtocolUsage(
    profile.id,
    protocol,
    todayStr,
    practiceSpellings
  );
  const protocolPracticeSessions =
    practice?.scopeKind === "practice"
      ? getPracticeSessions(
          profile.id,
          practice.value,
          100,
          {
            start: protocol.start_date,
            end: protocol.end_date ?? todayStr,
          },
          practiceSpellings
        )
      : [];
  const previousDurationMin =
    practice?.scopeKind === "practice"
      ? practiceDurationPrefill(
          getPracticeSessions(
            profile.id,
            practice.value,
            1,
            undefined,
            practiceSpellings
          )
        )
      : null;
  const hasPracticeCard = !!gear || !!practice || !!intakeItem;
  const ongoing = protocol.end_date == null;

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="protocol-detail-page"
    >
      <Link
        href="/longevity#protocols"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
      >
        <IconArrowLeft className="h-4 w-4" stroke={1.75} aria-hidden />
        Back to protocols
      </Link>

      <div className="space-y-6">
        {/* The edit form's situation picker reads the SAME merged vocabulary the
            supplement and medication forms do (#1676). */}
        <SituationOptionsProvider
          options={mergedSituationOptions(getSituations(profile.id)).map(
            (o) => o.name
          )}
        >
          <ProtocolControls
            protocol={protocol}
            options={options}
            equipment={equipment}
            intakeItems={intakeItems}
            practice={practice}
            updateAction={updateProtocol}
            endAction={endProtocol}
            resumeAction={resumeProtocol}
            runAgainAction={runProtocolAgain}
            deleteAction={deleteProtocol}
            asOf={todayStr}
          />
        </SituationOptionsProvider>

        <div className="grid gap-6">
          {hasPracticeCard && (
            <div
              className="card min-w-0 space-y-3"
              data-testid="protocol-practice-card"
            >
              <PracticeCardHeader
                name={
                  practice?.scopeKind === "practice"
                    ? practice.value
                    : "Practice"
                }
                progress={
                  // NO ADHERENCE, NO VERDICT (#2008). getProtocolAdherence returns
                  // null when the protocol has no frequency target or the target has
                  // no progress row; `?? "on-pace"` turned that absence into a
                  // positive claim ("0 sessions · on pace") computed from nothing.
                  // `??` supplies a neutral default, never a verdict — so the block
                  // renders only when there IS progress, exactly as the dashboard
                  // widget already gated it.
                  practice?.scopeKind === "practice" && ongoing && adherence
                    ? {
                        count: adherence.count,
                        perWeek: practice.perWeek,
                        perWeekMax: practice.perWeekMax,
                        pace: adherence.pace,
                        atCeiling: adherence.atCeiling,
                        testId: "protocol-adherence",
                      }
                    : undefined
                }
                action={
                  practice?.scopeKind === "practice" ? (
                    <Link
                      href="/wellness"
                      className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
                      data-testid="protocol-wellness-link"
                    >
                      View practice →
                    </Link>
                  ) : undefined
                }
              />

              {gear && (
                <div>
                  <div className="section-label">Recovery gear</div>
                  <Link
                    href={`/equipment/${gear.id}`}
                    className="mt-0.5 inline-flex items-center gap-1.5 font-medium text-brand-700 hover:underline dark:text-brand-300"
                    data-testid="protocol-gear-link"
                  >
                    <IconBarbell
                      className="h-4 w-4"
                      stroke={1.75}
                      aria-hidden
                    />
                    {gear.name}
                    {gear.retired ? (
                      <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        Retired
                      </span>
                    ) : null}
                  </Link>
                </div>
              )}

              {intakeItem && (
                <div>
                  <div className="section-label">Supplement or medication</div>
                  <Link
                    href={intakeHref(intakeItem.kind)}
                    className="mt-0.5 inline-flex items-center gap-1.5 font-medium text-brand-700 hover:underline dark:text-brand-300"
                    data-testid="protocol-intake-link"
                  >
                    <IconPill className="h-4 w-4" stroke={1.75} aria-hidden />
                    {intakeItem.name}
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                      {intakeItem.kind === "medication"
                        ? "Medication"
                        : "Supplement"}
                    </span>
                  </Link>
                </div>
              )}

              {practice &&
                ongoing &&
                adherence &&
                practice.scopeKind !== "practice" && (
                  <div>
                    <div className="section-label">Weekly progress</div>
                    <PracticeWeeklyProgress
                      count={adherence.count}
                      perWeek={practice.perWeek}
                      perWeekMax={practice.perWeekMax}
                      label={protocolPracticeLabel(
                        practice.scopeKind,
                        practice.value
                      )}
                      noun={protocolPracticeNoun(practice.scopeKind)}
                      pace={adherence.pace}
                      atCeiling={adherence.atCeiling}
                      testId="protocol-adherence"
                    />
                  </div>
                )}

              {practice && ongoing && (
                <ProtocolLogButton
                  practice={practice}
                  ongoing={ongoing}
                  todayCount={practiceTodayCount}
                  atCeiling={adherence?.atCeiling ?? false}
                  today={todayStr}
                  defaultDurationMin={previousDurationMin}
                  usualSessionDay={practiceUsuallyToday}
                  showDetails
                />
              )}
            </div>
          )}
          <div className="min-w-0" data-testid="protocol-comparison-column">
            <ProtocolCompare
              comparison={comparison}
              protocolId={protocol.id}
              selectedKeys={protocol.outcomeKeys}
              options={options}
              relevantPanelIds={relevantPanelIds}
              updateAction={updateProtocolOutcomes}
            />
          </div>
          {hasPracticeCard && (
            <div className="card min-w-0" data-testid="protocol-history-card">
              {practice?.scopeKind === "practice" ? (
                <PracticeHistorySection
                  title="Sessions during this protocol"
                  sessions={protocolPracticeSessions}
                  sessionCount={usage.sessions}
                  lastUsed={usage.lastUsed}
                  today={todayStr}
                  emptyText="No sessions logged during this protocol."
                  usageTestId="protocol-usage"
                />
              ) : (
                <div>
                  <div className="section-label">
                    Logged during this protocol
                  </div>
                  <div
                    className="mt-0.5 text-sm text-slate-700 dark:text-slate-200"
                    data-testid="protocol-usage"
                  >
                    {formatUsageSummary(
                      usage.sessions,
                      usage.lastUsed,
                      todayStr,
                      practice?.scopeKind === "food_group"
                        ? "serving"
                        : "session"
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PageContainer>
  );
}
