"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  MedicationCourse,
  MedicationSideEffect,
  Supplement,
  SupplementDose,
  SupplementPair,
} from "@/lib/types";
import type { InteractionItem } from "@/lib/drug-interactions";
import type { PgxVariantInput } from "@/lib/pgx";
import {
  STOP_REASONS,
  STOP_REASON_LABELS,
  SIDE_EFFECT_SEVERITIES,
  SEVERITY_LABELS,
  sortCourses,
  currentCourse,
  isMedicationCurrent,
  stopReasonLabel,
  unresolvedCount,
  medicationMetaLine,
} from "@/lib/medication-history";
import type { AdherenceDot } from "@/lib/supplement-adherence";
import type { AdherenceCalendarModel } from "@/lib/adherence-calendar";
import { daysOfSupplyForItem, isLowSupply, type DoseRate } from "@/lib/refill";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import { medicationHref } from "@/lib/hrefs";
import { formatLongDate } from "@/lib/format-date";
import {
  formatMedicationDoseLine,
  formatMedicationDoseProduct,
} from "@/lib/medication-dose-format";
import { formatGivenAtClockWithRelativeAge } from "@/lib/administration-format";
import { getMedicationInfo } from "@/lib/medication-info";
import {
  RefillBadge,
  AdherenceSummaryLine,
} from "@/components/AdherenceRefill";
import RefillButton from "@/components/medications/RefillButton";
import AdherenceCalendar from "@/components/medications/AdherenceCalendar";
import ScheduledDoseAction from "@/components/medications/ScheduledDoseAction";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import QuickLogPrnControl from "@/components/dashboard/QuickLogPrnControl";
import MedicationForm from "@/components/MedicationForm";
import RxOtcBadge from "@/components/RxOtcBadge";
import ProviderName from "@/components/ProviderName";
import FoodGuidance from "@/components/FoodGuidance";
import NotesText from "@/components/NotesText";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import {
  updateSupplement,
  deleteSupplement,
} from "@/app/(app)/nutrition/supplement-actions";
import {
  stopMedication,
  restartMedication,
  addSideEffect,
  toggleSideEffectResolved,
  deleteSideEffect,
  promoteSideEffectToIntolerance,
  deleteAdministration,
} from "./actions";
import { IconX } from "@tabler/icons-react";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

// One medication, rendered as a card carrying its whole lifecycle: the
// current dose check-offs, its course history (start/stop dates + reasons), the
// side-effect list, and the stop / restart / side-effect / promote actions. Unlike
// supplements (rendered one row per dose), a medication renders once so its
// per-medication history has a single home.
export default function MedicationCard({
  supplement,
  doses,
  allSupplements,
  stackItems,
  pgxVariants,
  pairs,
  takenDoseIds,
  skippedDoseIds,
  due,
  courses,
  sideEffects,
  strip,
  refillRate,
  todayStr,
  nowIso,
  trainingRestricted,
  suppressedFoodKeys = [],
  prnDayLabel = null,
  prnAdministrations = [],
  doseHistory = [],
  prnRedoseLine = null,
  prnRedosePrimary = true,
  monitoringLabs = [],
  pediatric,
  age = null,
  adherenceCalendar = null,
  takenDoseTimes = {},
  timezone,
  historyMinDate,
  historyMaxDate,
  defaultHistoryTime,
  canWrite = true,
  initialAction,
  conditions = [],
}: {
  supplement: Supplement;
  doses: SupplementDose[];
  allSupplements: { id: number; name: string }[];
  stackItems: InteractionItem[];
  pgxVariants: PgxVariantInput[];
  pairs: SupplementPair[];
  takenDoseIds: Set<number>;
  skippedDoseIds: Set<number>;
  due: boolean;
  courses: MedicationCourse[];
  sideEffects: MedicationSideEffect[];
  // 14-day adherence strip + refill rate, threaded so the med card shows the same
  // adherence summary + "≈N days left" badge as the supplement row (#747 parity).
  strip: AdherenceDot[];
  refillRate: DoseRate | null;
  todayStr: string;
  nowIso: string;
  trainingRestricted: boolean;
  // Active food-timing dismissals for this profile (#435), threaded to FoodGuidance.
  suppressedFoodKeys?: string[];
  // PRN (as-needed) administrations for today (#797): the
  // "2 today · last 4:02pm (2 hrs ago)"
  // summary + each administration's profile-local clock time (most recent first),
  // both pre-formatted server-side. Shown INSTEAD of the binary dose pill for a PRN
  // med, since a PRN med can be given several times a day.
  prnDayLabel?: string | null;
  // Today's as-needed administrations with ledger ids and snapshotted amounts. Each
  // row offers remove-with-undo, since a mis-tapped log otherwise permanently skews
  // supply, the redose window, and the daily count.
  prnAdministrations?: {
    id: number;
    label: string;
    amount: string | null;
    product: string | null;
  }[];
  // Taken-dose ledger rows for scheduled and PRN medications.
  doseHistory?: {
    id: number;
    doseId: number;
    date: string;
    time: string;
    timeValue: string;
    amount: string | null;
    product: string | null;
  }[];
  // The redose-window status line (#798): "Redose OK — min interval passed · 2 of 4
  // today" / "Next dose in ~2h · …" / "Max reached · …", or null when not configured.
  // Pre-formatted server-side via the shared redoseCardLabel.
  prnRedoseLine?: string | null;
  prnRedosePrimary?: boolean;
  monitoringLabs?: string[];
  // Pediatric label-dosing context (#798) for the edit form's weight-band suggestion.
  pediatric?: PediatricFormContext;
  // The profile's age in whole years (issue #851 item 4), threaded to FoodGuidance so
  // an age-gated food note (alcohol → adult) is hidden for a child.
  age?: number | null;
  adherenceCalendar?: AdherenceCalendarModel | null;
  takenDoseTimes?: Record<number, string>;
  timezone: string;
  historyMinDate?: string;
  historyMaxDate: string;
  defaultHistoryTime: string;
  // A medication reached through another accessible profile's illness episode is
  // readable without switching profiles. Writes remain tied to the acting profile, so
  // the cross-profile detail view hides every mutation control until the user explicitly
  // chooses "Act as …" in the page identity banner.
  canWrite?: boolean;
  // List-row overflow actions land on this detail view with the relevant form open.
  initialAction?: "edit" | "stop";
  // The profile's conditions for the "For condition…" indication picker (#1052).
  conditions?: { id: number; name: string }[];
}) {
  const s = supplement;
  const router = useRouter();
  const [editing, setEditing] = useState(canWrite && initialAction === "edit");
  const [stopping, setStopping] = useState(
    canWrite && initialAction === "stop"
  );
  const [addingEffect, setAddingEffect] = useState(false);
  const [addingDose, setAddingDose] = useState(false);
  const [editingHistoryId, setEditingHistoryId] = useState<number | null>(null);
  const [historyMenuId, setHistoryMenuId] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sideEffectMenuId, setSideEffectMenuId] = useState<number | null>(null);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const formatPrefs = useFormatPrefs();
  const closeInitialAction = () => {
    if (initialAction) {
      router.replace(medicationHref(s.id), { scroll: false });
    }
  };

  // Current/Past keys off the authoritative active flag (see isMedicationCurrent),
  // so the card can never contradict scheduling; `open` still comes from the
  // courses so a captured side effect links to the live course.
  const current = isMedicationCurrent(s);
  const open = currentCourse(courses);
  const ordered = sortCourses(courses);
  const unresolved = unresolvedCount(sideEffects);

  if (editing && canWrite) {
    return (
      <div className="card relative z-20 bg-slate-50/60 dark:bg-ink-900/60">
        <MedicationForm
          action={updateSupplement}
          supplement={s}
          doses={doses}
          allSupplements={allSupplements}
          stackItems={stackItems}
          pgxVariants={pgxVariants}
          pairs={pairs}
          onDone={() => {
            setEditing(false);
            closeInitialAction();
          }}
          trainingRestricted={trainingRestricted}
          pediatric={pediatric}
          age={age}
          conditions={conditions}
          course={open ?? ordered[ordered.length - 1]}
          todayStr={todayStr}
        />
      </div>
    );
  }

  // Educational "what is this drug" explainer, matched from the medication's
  // name (brand or generic). Absent for meds outside the curated set.
  const medInfo = getMedicationInfo(s.name);

  // Keep the structured provider separate from the free-text prescription
  // metadata so it can use the registry's standard provider-detail link. Under #1051
  // (semantics decision (a)) the LINKED provider is the prescriber, so prefer it and
  // drop the redundant free-text prescriber when it's present — the registry name
  // wins so renames/merges propagate; the free-text prescriber stays only as the
  // fallback for an unlinked med (`provider_name` null).
  const medMeta = medicationMetaLine({
    prescriber: s.provider_name ? null : s.prescriber,
    pharmacy: s.pharmacy,
    rx_number: s.rx_number,
    provider_name: null,
  });
  const lowSupply = isLowSupply(
    daysOfSupplyForItem(
      s.quantity_on_hand,
      s.qty_per_dose,
      refillRate,
      doses.length
    )
  );

  const fmt = (d: string | null) =>
    d ? formatLongDate(d, formatPrefs) : "unknown";
  const doseLines = doses.map((dose) =>
    formatMedicationDoseLine({
      amount: dose.amount,
      product: s.product,
      timeOfDay: dose.time_of_day,
      asNeeded: s.as_needed === 1,
      timeFormat: formatPrefs.timeFormat,
    })
  );
  const visibleAdherenceCalendar = adherenceCalendar?.weeks.length
    ? adherenceCalendar
    : null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section
        className={`card ${menuOpen ? "relative z-20" : ""}`}
        data-testid="medication-overview"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              Overview
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <RxOtcBadge rx={s.rx} />
              {s.as_needed === 1 && (
                <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                  As Needed
                </span>
              )}
              {current ? (
                <span className="badge bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  Current
                </span>
              ) : (
                <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                  {stopReasonLabel(ordered[ordered.length - 1]?.stop_reason)}
                </span>
              )}
              {unresolved > 0 && (
                <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  {unresolved} side effect{unresolved === 1 ? "" : "s"}
                </span>
              )}
              {s.critical === 1 && (
                <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                  Critical
                </span>
              )}
              <RefillBadge
                quantityOnHand={s.quantity_on_hand}
                qtyPerDose={s.qty_per_dose}
                refillRate={refillRate}
                doseCount={doses.length}
                todayStr={todayStr}
              />
            </div>
            <div className="mt-4">
              <div className="section-label">
                {s.as_needed === 1 ? "Dose" : "Dose schedule"}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                {doseLines.length > 0 && doseLines.some(Boolean) ? (
                  doseLines.map((line, index) => (
                    <span key={doses[index]?.id ?? index}>
                      {line || "Dose not set"}
                    </span>
                  ))
                ) : s.product ? (
                  <span>{s.product}</span>
                ) : (
                  <span className="font-normal text-slate-500 dark:text-slate-400">
                    Dose not set
                  </span>
                )}
              </div>
            </div>
            {(medMeta || s.provider_name) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-1 text-xs text-slate-500 dark:text-slate-400">
                {medMeta && <span>{medMeta}</span>}
                {medMeta && s.provider_name && (
                  <span aria-hidden="true">·</span>
                )}
                {s.provider_name && (
                  <ProviderName
                    name={s.provider_name}
                    providerId={s.provider_id}
                    size="sm"
                    className="text-xs text-slate-500 dark:text-slate-400"
                  />
                )}
              </div>
            )}
            {s.indication_condition_name && (
              <div
                className="mt-1 text-xs text-slate-500 dark:text-slate-400"
                data-testid="medication-indication"
              >
                For:{" "}
                <Link
                  href="/records"
                  className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                >
                  {s.indication_condition_name}
                </Link>
              </div>
            )}
            <div className="mt-2">
              <AdherenceSummaryLine strip={strip} />
            </div>
          </div>
          {canWrite ? (
            <div className="flex shrink-0 items-center gap-2 text-xs">
              {current && lowSupply && (
                <RefillButton
                  itemId={s.id}
                  hasLastFill={s.last_fill_size != null}
                  lastFillSize={s.last_fill_size}
                />
              )}
              <OverflowMenu
                label="Medication actions"
                open={menuOpen}
                onOpenChange={setMenuOpen}
              >
                {({ close }) => (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setEditing(true);
                        close();
                      }}
                      className={MENU_ITEM}
                    >
                      Edit
                    </button>
                    {current ? (
                      <button
                        type="button"
                        role="menuitem"
                        className={MENU_ITEM}
                        onClick={() => {
                          setStopping(true);
                          close();
                        }}
                      >
                        Stop medication
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className={MENU_ITEM}
                        onClick={async () => {
                          close();
                          const fd = new FormData();
                          fd.set("id", String(s.id));
                          await restartMedication(fd);
                        }}
                      >
                        Restart medication
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className={MENU_ITEM_DANGER}
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Delete medication",
                          message: `Delete “${s.name}” and its whole history? You can undo this.`,
                          confirmLabel: "Delete",
                          danger: true,
                        });
                        if (!ok) return;
                        close();
                        const fd = new FormData();
                        fd.set("id", String(s.id));
                        await undoable(deleteSupplement, fd, {
                          deletedMessage: "Medication deleted.",
                        });
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </OverflowMenu>
            </div>
          ) : null}
        </div>

        {/* A PRN (as-needed) med keeps logging and today's ledger together. */}
        {current && s.as_needed === 1 && (
          <div
            className="mt-4 border-t border-black/5 pt-4 dark:border-white/5"
            data-testid="prn-administrations"
          >
            {canWrite ? (
              <QuickLogPrnControl
                itemId={s.id}
                name={s.name}
                doseAmount={doses[0]?.amount ?? null}
                product={s.product}
                dayLabel={prnDayLabel ?? "None today"}
                redoseLine={prnRedoseLine}
                redosePrimary={prnRedosePrimary}
                layout="detail"
              />
            ) : (
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="section-label">Today</span>
                <span className="text-sm text-slate-600 dark:text-slate-300">
                  {prnDayLabel ?? "None today"}
                </span>
              </div>
            )}
            {prnAdministrations.length > 0 && (
              <ul
                className="mt-2 divide-y divide-black/5 border-y border-black/5 dark:divide-white/5 dark:border-white/5"
                data-testid="prn-administration-list"
              >
                {prnAdministrations.map((a) => (
                  <li
                    key={a.id}
                    data-testid="prn-administration-row"
                    className="flex min-h-10 items-center justify-between gap-3 py-2"
                  >
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                        {a.label}
                      </span>
                      {formatMedicationDoseProduct(a.amount, a.product) ? (
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {formatMedicationDoseProduct(a.amount, a.product)}
                        </span>
                      ) : null}
                    </div>
                    {/* Remove a mis-tapped administration with undo (#851 item 11). */}
                    {canWrite ? (
                      <button
                        type="button"
                        data-testid="prn-administration-remove"
                        aria-label={`Remove ${a.label} dose`}
                        title="Remove this dose"
                        className="tap-target flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                        onClick={async () => {
                          const fd = new FormData();
                          fd.set("log_id", String(a.id));
                          await undoable(deleteAdministration, fd, {
                            deletedMessage: "Dose removed.",
                          });
                        }}
                      >
                        <IconX className="h-4 w-4" stroke={2} />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Today's dose check-offs — a SCHEDULED med only (PRN uses the block above),
          when it's current and due. */}
        {current && due && s.as_needed !== 1 && doses.length > 0 && (
          <div
            className="mt-4 border-t border-black/5 pt-4 dark:border-white/5"
            data-testid="scheduled-today"
          >
            <div className="mb-2 section-label">Today</div>
            <div className="space-y-2">
              {doses.map((dose) => (
                <ScheduledDoseAction
                  key={dose.id}
                  doseId={dose.id}
                  doseLabel={
                    formatMedicationDoseLine({
                      amount: null,
                      timeOfDay: dose.time_of_day,
                      asNeeded: false,
                      timeFormat: formatPrefs.timeFormat,
                    }) || ""
                  }
                  taken={takenDoseIds.has(dose.id)}
                  skipped={skippedDoseIds.has(dose.id)}
                  readOnly={!canWrite}
                  takenTime={formatGivenAtClockWithRelativeAge(
                    timezone,
                    takenDoseTimes[dose.id],
                    formatPrefs.timeFormat,
                    new Date(nowIso)
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {canWrite && stopping && current && (
          <form
            action={async (fd) => {
              const result = await stopMedication(fd);
              if (result.ok) {
                setStopping(false);
                closeInitialAction();
              }
            }}
            className="mt-4 space-y-3 border-t border-black/5 pt-4 dark:border-white/5"
            data-testid="stop-medication-form"
          >
            <input type="hidden" name="id" value={s.id} />
            <div>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Stop medication
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Record why this course ended and any side effect that
                contributed.
              </p>
            </div>
            <div>
              <label className="label" htmlFor={`stop-reason-${s.id}`}>
                Reason
              </label>
              <select
                id={`stop-reason-${s.id}`}
                name="stop_reason"
                defaultValue="side_effect"
                className="input text-sm"
              >
                {STOP_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {STOP_REASON_LABELS[reason]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor={`stop-note-${s.id}`}>
                Notes <span className="font-normal">(optional)</span>
              </label>
              <input
                id={`stop-note-${s.id}`}
                name="note"
                placeholder="Add context"
                className="input text-sm"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
              <div>
                <label className="label" htmlFor={`stop-effect-${s.id}`}>
                  Side effect <span className="font-normal">(optional)</span>
                </label>
                <input
                  id={`stop-effect-${s.id}`}
                  name="effect"
                  placeholder="e.g. Nausea"
                  className="input text-sm"
                />
              </div>
              <div>
                <label className="label" htmlFor={`stop-severity-${s.id}`}>
                  Severity
                </label>
                <select
                  id={`stop-severity-${s.id}`}
                  name="severity"
                  defaultValue=""
                  className="input text-sm"
                >
                  <option value="">Not specified</option>
                  {SIDE_EFFECT_SEVERITIES.map((severity) => (
                    <option key={severity} value={severity}>
                      {SEVERITY_LABELS[severity]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <SubmitButton
                pendingLabel="Stopping…"
                className="btn-danger btn-sm"
              >
                Stop medication
              </SubmitButton>
              <button
                type="button"
                onClick={() => {
                  setStopping(false);
                  closeInitialAction();
                }}
                className="btn-ghost btn-sm"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="card" data-testid="medication-guidance">
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
          Details
        </h2>
        <div className="mt-4 divide-y divide-black/5 dark:divide-white/5">
          {monitoringLabs.length > 0 ? (
            <div
              className="py-4 first:pt-0 last:pb-0"
              data-testid="medication-monitoring-detail"
            >
              <div className="section-label">Monitoring</div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {s.name} may need periodic{" "}
                {new Intl.ListFormat("en", {
                  style: "long",
                  type: "conjunction",
                }).format(monitoringLabs)}{" "}
                monitoring. Ask your prescriber which tests you need and how
                often.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <Link
                  href={`/results/biomarkers?q=${encodeURIComponent(monitoringLabs[0])}`}
                  className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  View results
                </Link>
                <Link
                  href={`/results/biomarkers?new=1&name=${encodeURIComponent(monitoringLabs[0])}#add-result`}
                  className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  Add {monitoringLabs[0]} result
                </Link>
              </div>
            </div>
          ) : null}
          {s.notes?.trim() ? (
            <div className="py-4 first:pt-0 last:pb-0">
              <div className="mb-1 section-label">Notes</div>
              <NotesText
                notes={s.notes}
                className="text-sm text-slate-600 dark:text-slate-300"
              />
            </div>
          ) : null}
          <FoodGuidance
            itemId={s.id}
            name={s.name}
            rxcui={s.rxcui}
            rxcuiIngredients={s.rxcui_ingredients}
            suppressedFoodKeys={suppressedFoodKeys}
            age={age}
            heading="Food guidance"
            className="py-4 first:pt-0 last:pb-0"
            canDismiss={canWrite}
          />
          {medInfo && (
            <div className="py-4 first:pt-0 last:pb-0">
              <div className="section-label">About this medication</div>
              <div className="mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                <div className="font-medium text-slate-700 dark:text-slate-200">
                  {medInfo.generic}
                  {medInfo.drug_class ? ` · ${medInfo.drug_class}` : ""}
                </div>
                <p className="mt-1">{medInfo.description}</p>
              </div>
            </div>
          )}
        </div>
      </section>

      {visibleAdherenceCalendar && (
        <section
          className="card lg:col-span-2"
          data-testid="medication-adherence-month"
        >
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            Adherence
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Scheduled doses over the last month.
          </p>
          <div className="mt-4">
            <AdherenceCalendar model={visibleAdherenceCalendar} />
          </div>
        </section>
      )}

      <section className="card lg:col-span-2" data-testid="medication-history">
        <div>
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            History
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Courses, doses, and side effects recorded for this medication.
          </p>
        </div>

        <div className="mt-5 space-y-5">
          <div data-testid="dose-history">
            <div className="mb-1 flex items-center justify-between gap-3">
              <span className="section-label">Dose history</span>
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditingHistoryId(null);
                    setAddingDose((value) => !value);
                  }}
                  className="btn-ghost btn-sm"
                  disabled={
                    doses.length === 0 ||
                    courses.length === 0 ||
                    (!!historyMinDate && historyMinDate > historyMaxDate)
                  }
                  title={
                    courses.length === 0 ||
                    (!!historyMinDate && historyMinDate > historyMaxDate)
                      ? "No recorded medication course is available"
                      : undefined
                  }
                  aria-expanded={addingDose}
                >
                  {addingDose ? "Cancel" : "Log past dose"}
                </button>
              ) : null}
            </div>
            {canWrite && addingDose ? (
              <HistoricalDoseForm
                itemId={s.id}
                medicationName={s.name}
                doses={doses.map((dose) => ({
                  id: dose.id,
                  label:
                    formatMedicationDoseLine({
                      amount: dose.amount,
                      product: s.product,
                      timeOfDay: dose.time_of_day,
                      asNeeded: s.as_needed === 1,
                      timeFormat: formatPrefs.timeFormat,
                    }) || "Dose",
                  amount: dose.amount,
                }))}
                minDate={historyMinDate}
                maxDate={historyMaxDate}
                defaultTime={defaultHistoryTime}
                asNeeded={s.as_needed === 1}
                onDone={() => setAddingDose(false)}
              />
            ) : null}
            {doseHistory.length > 0 ? (
              <ul className="mt-2 divide-y divide-black/5 dark:divide-white/5">
                {doseHistory.map((entry) => (
                  <li
                    key={entry.id}
                    data-testid="dose-history-row"
                    className="py-2 first:pt-0 last:pb-0"
                  >
                    <div className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)_auto] items-center gap-x-3 text-sm text-slate-600 dark:text-slate-300">
                      <span className="font-medium">{fmt(entry.date)}</span>
                      <span className="min-w-0 text-right text-xs text-slate-500 dark:text-slate-400">
                        {[
                          formatMedicationDoseProduct(
                            entry.amount,
                            entry.product
                          ),
                          entry.time,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {canWrite ? (
                        <OverflowMenu
                          label="Dose actions"
                          open={historyMenuId === entry.id}
                          onOpenChange={(open) =>
                            setHistoryMenuId(open ? entry.id : null)
                          }
                        >
                          {({ close }) => (
                            <>
                              <button
                                type="button"
                                role="menuitem"
                                className={MENU_ITEM}
                                onClick={() => {
                                  setAddingDose(false);
                                  setEditingHistoryId(entry.id);
                                  close();
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className={MENU_ITEM_DANGER}
                                onClick={async () => {
                                  close();
                                  const fd = new FormData();
                                  fd.set("log_id", String(entry.id));
                                  if (editingHistoryId === entry.id) {
                                    setEditingHistoryId(null);
                                  }
                                  await undoable(deleteAdministration, fd, {
                                    deletedMessage: "Dose deleted.",
                                  });
                                }}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </OverflowMenu>
                      ) : null}
                    </div>
                    {canWrite && editingHistoryId === entry.id ? (
                      <HistoricalDoseForm
                        itemId={s.id}
                        medicationName={s.name}
                        doses={doses.map((dose) => ({
                          id: dose.id,
                          label:
                            formatMedicationDoseLine({
                              amount: dose.amount,
                              product: s.product,
                              timeOfDay: dose.time_of_day,
                              asNeeded: s.as_needed === 1,
                              timeFormat: formatPrefs.timeFormat,
                            }) || "Dose",
                          amount: dose.amount,
                        }))}
                        minDate={historyMinDate}
                        maxDate={historyMaxDate}
                        defaultTime={defaultHistoryTime}
                        asNeeded={s.as_needed === 1}
                        editing={{
                          logId: entry.id,
                          doseId: entry.doseId,
                          date: entry.date,
                          time: entry.timeValue,
                          amount: entry.amount,
                        }}
                        onDone={() => setEditingHistoryId(null)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                No doses recorded yet.
              </p>
            )}
          </div>

          {/* Course mini-timeline. */}
          <div>
            <div className="mb-1 section-label">Courses ({ordered.length})</div>
            <ul className="space-y-1">
              {ordered.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center gap-x-2 text-sm text-slate-600 dark:text-slate-300"
                >
                  <span className="font-medium">
                    {fmt(c.started_on)} –{" "}
                    {c.stopped_on ? fmt(c.stopped_on) : "present"}
                  </span>
                  {c.stopped_on && (
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                      {stopReasonLabel(c.stop_reason)}
                    </span>
                  )}
                  {!c.stopped_on && (
                    <span className="badge bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      Open
                    </span>
                  )}
                  {/* Per-course attribution (#1204): the prescriber + dose snapshot
                      as recorded at this course, so a multi-provider / renewal history
                      reads "Dr. A · Jan–Mar, Dr. B · Apr–". */}
                  {c.prescriber && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {c.prescriber}
                    </span>
                  )}
                  {c.dose_snapshot && (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      · {c.dose_snapshot}
                    </span>
                  )}
                  <NotesText
                    notes={c.notes}
                    className="text-xs text-slate-500 dark:text-slate-400"
                  />
                </li>
              ))}
            </ul>
          </div>

          {/* Side effects. */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="section-label">
                Side effects ({sideEffects.length})
              </span>
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => setAddingEffect((v) => !v)}
                  className="btn-ghost btn-sm"
                >
                  {addingEffect ? "Cancel" : "Add side effect"}
                </button>
              ) : null}
            </div>

            {canWrite && addingEffect && (
              <form
                action={async (fd) => {
                  await addSideEffect(fd);
                }}
                onSubmit={() => setAddingEffect(false)}
                className="mb-3 space-y-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <input type="hidden" name="id" value={s.id} />
                {open && (
                  <input type="hidden" name="course_id" value={open.id} />
                )}
                <div>
                  <label className="label" htmlFor={`side-effect-${s.id}`}>
                    Side effect
                  </label>
                  <input
                    id={`side-effect-${s.id}`}
                    name="effect"
                    required
                    placeholder="e.g. Nausea"
                    className="input text-sm"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor={`side-severity-${s.id}`}>
                      Severity
                    </label>
                    <select
                      id={`side-severity-${s.id}`}
                      name="severity"
                      defaultValue=""
                      className="input text-sm"
                    >
                      <option value="">Not specified</option>
                      {SIDE_EFFECT_SEVERITIES.map((sev) => (
                        <option key={sev} value={sev}>
                          {SEVERITY_LABELS[sev]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor={`side-date-${s.id}`}>
                      Date noted
                    </label>
                    <DateField
                      id={`side-date-${s.id}`}
                      name="noted_on"
                      defaultValue={todayStr}
                      inputClassName="text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor={`side-notes-${s.id}`}>
                    Notes <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    id={`side-notes-${s.id}`}
                    name="notes"
                    placeholder="Add context"
                    className="input text-sm"
                  />
                </div>
                <SubmitButton pendingLabel="Saving…" className="btn btn-sm">
                  Add side effect
                </SubmitButton>
              </form>
            )}

            {sideEffects.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No side effects recorded.
              </p>
            ) : (
              <ul className="divide-y divide-black/5 dark:divide-white/5">
                {sideEffects.map((se) => (
                  <li
                    key={se.id}
                    className="flex items-start gap-3 py-3 first:pt-1 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span
                          className={`font-medium ${
                            se.resolved
                              ? "text-slate-500 dark:text-slate-400"
                              : "text-slate-700 dark:text-slate-200"
                          }`}
                        >
                          {se.effect}
                        </span>
                        {se.severity && (
                          <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                            {SEVERITY_LABELS[se.severity]}
                          </span>
                        )}
                        {se.resolved && (
                          <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                            Resolved
                          </span>
                        )}
                      </div>
                      {se.noted_on && (
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          Noted {fmt(se.noted_on)}
                        </div>
                      )}
                      <NotesText
                        notes={se.notes}
                        className="mt-1 text-sm text-slate-500 dark:text-slate-400"
                      />
                    </div>
                    {canWrite ? (
                      <OverflowMenu
                        label={`Actions for ${se.effect}`}
                        open={sideEffectMenuId === se.id}
                        onOpenChange={(nextOpen) =>
                          setSideEffectMenuId(nextOpen ? se.id : null)
                        }
                      >
                        {({ close }) => (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              className={MENU_ITEM}
                              onClick={async () => {
                                const fd = new FormData();
                                fd.set("id", String(se.id));
                                await toggleSideEffectResolved(fd);
                                close();
                              }}
                            >
                              {se.resolved
                                ? "Reopen side effect"
                                : "Mark resolved"}
                            </button>
                            {/* Promoting resolves the effect. Hide the action after
                              resolution so it cannot create a duplicate intolerance. */}
                            {!se.resolved && (
                              <button
                                type="button"
                                role="menuitem"
                                className={MENU_ITEM}
                                onClick={async () => {
                                  const ok = await confirm({
                                    title: "Add to allergies",
                                    message: `Add “${se.effect}” to Allergies as a medication intolerance? This side effect will be marked resolved.`,
                                    confirmLabel: "Add to allergies",
                                  });
                                  if (!ok) return;
                                  const fd = new FormData();
                                  fd.set("id", String(se.id));
                                  await promoteSideEffectToIntolerance(fd);
                                  close();
                                }}
                              >
                                Add to allergies
                              </button>
                            )}
                            <button
                              type="button"
                              role="menuitem"
                              className={MENU_ITEM_DANGER}
                              onClick={async () => {
                                const ok = await confirm({
                                  title: "Delete side effect",
                                  message: `Delete “${se.effect}” from this medication’s history?`,
                                  confirmLabel: "Delete",
                                  danger: true,
                                });
                                if (!ok) return;
                                const fd = new FormData();
                                fd.set("id", String(se.id));
                                await deleteSideEffect(fd);
                                close();
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </OverflowMenu>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
