"use client";

import { useState } from "react";
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
import { daysOfSupplyForItem, isLowSupply, type DoseRate } from "@/lib/refill";
import type { PediatricFormContext } from "@/lib/prn-dosing";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { getMedicationInfo } from "@/lib/medication-info";
import {
  RefillBadge,
  AdherenceSummaryLine,
} from "@/components/AdherenceRefill";
import RefillButton from "@/components/medications/RefillButton";
import MedicationForm from "@/components/MedicationForm";
import RxOtcBadge from "@/components/RxOtcBadge";
import FoodGuidance from "@/components/FoodGuidance";
import NotesText from "@/components/NotesText";
import DoseStatusControl from "@/components/DoseStatusControl";
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
  trainingRestricted,
  suppressedFoodKeys = [],
  prnDayLabel = null,
  prnAdministrations = [],
  prnHistory = [],
  prnRedoseLine = null,
  pediatric,
  age = null,
  detailView = false,
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
  trainingRestricted: boolean;
  // Active food-timing dismissals for this profile (#435), threaded to FoodGuidance.
  suppressedFoodKeys?: string[];
  // PRN (as-needed) administrations for today (#797): the "2 today · last 4:02pm"
  // summary + each administration's profile-local clock time (most recent first),
  // both pre-formatted server-side. Shown INSTEAD of the binary dose pill for a PRN
  // med, since a PRN med can be given several times a day.
  prnDayLabel?: string | null;
  // Today's PRN administrations with ledger ids (#851 item 11) — each chip offers
  // remove-with-undo, since a mis-tapped Log otherwise permanently skews supply + the
  // redose window + the daily count.
  prnAdministrations?: { id: number; label: string }[];
  // Past PRN administration history grouped by day (#851 item 13), most recent first —
  // rendered in the detail-page History disclosure so the med's own page answers "how
  // often last month", not just today. Empty for scheduled meds / the list card.
  prnHistory?: { date: string; times: string[] }[];
  // The redose-window status line (#798): "Redose OK — min interval passed · 2 of 4
  // today" / "Next dose in ~2h · …" / "Max reached · …", or null when not configured.
  // Pre-formatted server-side via the shared redoseCardLabel.
  prnRedoseLine?: string | null;
  // Pediatric label-dosing context (#798) for the edit form's weight-band suggestion.
  pediatric?: PediatricFormContext;
  // The profile's age in whole years (issue #851 item 4), threaded to FoodGuidance so
  // an age-gated food note (alcohol → adult) is hidden for a child.
  age?: number | null;
  // Rendered as the /medications/[id] detail body (#817) rather than a list card:
  // the course/side-effect History disclosure starts OPEN (it's the med's clinical
  // home, not a scannable list row where it should stay tucked away).
  detailView?: boolean;
}) {
  const formatPrefs = useFormatPrefs();
  const s = supplement;
  const [editing, setEditing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [addingEffect, setAddingEffect] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const confirm = useConfirm();
  const undoable = useUndoableDelete();

  // Current/Past keys off the authoritative active flag (see isMedicationCurrent),
  // so the card can never contradict scheduling; `open` still comes from the
  // courses so a captured side effect links to the live course.
  const current = isMedicationCurrent(s);
  const open = currentCourse(courses);
  const ordered = sortCourses(courses);
  const unresolved = unresolvedCount(sideEffects);

  if (editing) {
    return (
      <div className="card bg-slate-50/60 dark:bg-ink-900/60">
        <MedicationForm
          action={updateSupplement}
          supplement={s}
          doses={doses}
          allSupplements={allSupplements}
          stackItems={stackItems}
          pgxVariants={pgxVariants}
          pairs={pairs}
          onDone={() => setEditing(false)}
          trainingRestricted={trainingRestricted}
          pediatric={pediatric}
          age={age}
        />
      </div>
    );
  }

  // Educational "what is this drug" explainer, matched from the medication's
  // name (brand or generic). Absent for meds outside the curated set.
  const medInfo = getMedicationInfo(s.name);

  const subline = [s.brand, s.product].filter(Boolean).join(" · ");
  const medMeta = medicationMetaLine(s);
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

  return (
    <div
      className={`card !py-3 ${current ? "" : "opacity-70"} ${
        menuOpen ? "relative z-20" : ""
      } border-l-4 ${
        current
          ? "border-l-rose-400 dark:border-l-rose-500"
          : "border-l-slate-300 dark:border-l-ink-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium text-slate-800 dark:text-slate-100">
              {s.name}
            </span>
            {subline && (
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {subline}
              </span>
            )}
            <RxOtcBadge rx={s.rx} />
            {s.as_needed === 1 && (
              <span className="badge bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300">
                PRN
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
            <RefillBadge
              quantityOnHand={s.quantity_on_hand}
              qtyPerDose={s.qty_per_dose}
              refillRate={refillRate}
              doseCount={doses.length}
              todayStr={todayStr}
            />
          </div>
          {medMeta && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {medMeta}
            </div>
          )}
          <NotesText
            as="div"
            notes={s.notes}
            className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
          />
          {/* Food–drug guidance (issue #154): a per-item food note (grapefruit,
              vitamin K, dairy/minerals, alcohol) — no second med needed. */}
          <FoodGuidance
            itemId={s.id}
            name={s.name}
            rxcui={s.rxcui}
            rxcuiIngredients={s.rxcui_ingredients}
            suppressedFoodKeys={suppressedFoodKeys}
            age={age}
          />
          {medInfo && (
            <details className="group mt-1">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400">
                What is this?
              </summary>
              <div className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                <span className="font-medium text-slate-600 dark:text-slate-300">
                  {medInfo.generic}
                  {medInfo.drug_class ? ` · ${medInfo.drug_class}` : ""}
                </span>
                <p className="mt-0.5">{medInfo.description}</p>
              </div>
            </details>
          )}
          <AdherenceSummaryLine strip={strip} />
        </div>
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
      </div>

      {/* A PRN (as-needed) med shows the day's ADMINISTRATIONS (multiple/day, real
          times) instead of a single binary pill (#797). Logging happens from the
          dashboard quick-log widget / Telegram; this is the day's record. */}
      {current && s.as_needed === 1 && (
        <div className="mt-2" data-testid="prn-administrations">
          <div className="text-sm text-slate-600 dark:text-slate-300">
            {prnDayLabel}
          </div>
          {prnRedoseLine && (
            <div
              data-testid="prn-redose-line"
              className="mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-300"
            >
              {prnRedoseLine}
            </div>
          )}
          {prnAdministrations.length > 0 && (
            <div
              className="mt-1 flex flex-wrap gap-1"
              data-testid="prn-administration-list"
            >
              {prnAdministrations.map((a) => (
                <span
                  key={a.id}
                  data-testid="prn-administration-chip"
                  className="inline-flex items-center gap-1 rounded-full border border-black/10 py-0.5 pl-2 pr-1 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400"
                >
                  {a.label}
                  {/* Remove a mis-tapped administration with undo (#851 item 11). */}
                  <button
                    type="button"
                    data-testid="prn-administration-remove"
                    aria-label={`Remove ${a.label} dose`}
                    title="Remove this dose"
                    className="flex h-4 w-4 items-center justify-center rounded-full text-slate-500 transition hover:bg-rose-100 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-900/40"
                    onClick={async () => {
                      const fd = new FormData();
                      fd.set("log_id", String(a.id));
                      await undoable(deleteAdministration, fd, {
                        deletedMessage: "Dose removed.",
                      });
                    }}
                  >
                    <IconX className="h-3 w-3" stroke={2} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Today's dose check-offs — a SCHEDULED med only (PRN uses the block above),
          when it's current and due. */}
      {current && due && s.as_needed !== 1 && doses.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {doses.map((dose) => (
            <DoseStatusControl
              key={dose.id}
              doseId={dose.id}
              taken={takenDoseIds.has(dose.id)}
              skipped={skippedDoseIds.has(dose.id)}
              variant="pill"
              label={dose.amount || dose.time_of_day || "Dose"}
            />
          ))}
        </div>
      )}

      {/* Detail: course history, side effects, lifecycle actions. Open by default
          on the /medications/[id] detail page (#817), collapsed on a list card. */}
      <details className="mt-2" open={detailView}>
        <summary className="cursor-pointer section-label">
          History &amp; side effects
        </summary>

        <div className="mt-3 space-y-4">
          {/* Recent PRN doses (#851 item 13): a dated roll-up so the med's own page
              answers "how often last month", not just today. PRN meds with history. */}
          {prnHistory.length > 0 && (
            <div data-testid="prn-history">
              <div className="mb-1 section-label">Recent doses</div>
              <ul className="space-y-1">
                {prnHistory.map((day) => (
                  <li
                    key={day.date}
                    className="flex flex-wrap items-baseline gap-x-2 text-sm text-slate-600 dark:text-slate-300"
                  >
                    <span className="font-medium">{fmt(day.date)}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {day.times.length} dose{day.times.length === 1 ? "" : "s"}
                      {day.times.length > 0 ? ` · ${day.times.join(", ")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Stop / restart controls. */}
          <div>
            {current ? (
              stopping ? (
                <form
                  action={async (fd) => {
                    await stopMedication(fd);
                  }}
                  onSubmit={() => setStopping(false)}
                  className="space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/10"
                >
                  <input type="hidden" name="id" value={s.id} />
                  <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
                    Stop this medication
                  </div>
                  <select
                    name="stop_reason"
                    defaultValue="side_effect"
                    className="input text-sm"
                  >
                    {STOP_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {STOP_REASON_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <input
                    name="note"
                    placeholder="Note (optional)"
                    className="input text-sm"
                  />
                  <div className="flex gap-2">
                    <input
                      name="effect"
                      placeholder="Side effect (optional)"
                      className="input text-sm"
                    />
                    <select
                      name="severity"
                      defaultValue=""
                      className="input w-32 text-sm"
                    >
                      <option value="">Severity</option>
                      {SIDE_EFFECT_SEVERITIES.map((sev) => (
                        <option key={sev} value={sev}>
                          {SEVERITY_LABELS[sev]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-3">
                    <SubmitButton
                      pendingLabel="Stopping…"
                      className="btn-danger btn-sm"
                    >
                      Stop
                    </SubmitButton>
                    <button
                      type="button"
                      onClick={() => setStopping(false)}
                      className="text-sm text-slate-500 hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setStopping(true)}
                  className="rounded-md border border-rose-300 px-3 py-1 text-sm font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
                >
                  Stop medication
                </button>
              )
            ) : (
              <form
                action={async (fd) => {
                  await restartMedication(fd);
                }}
              >
                <input type="hidden" name="id" value={s.id} />
                <SubmitButton
                  pendingLabel="Restarting…"
                  className="rounded-md border border-emerald-300 px-3 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-60 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950"
                >
                  Restart medication
                </SubmitButton>
              </form>
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
              <button
                type="button"
                onClick={() => setAddingEffect((v) => !v)}
                className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
              >
                {addingEffect ? "Cancel" : "Add"}
              </button>
            </div>

            {addingEffect && (
              <form
                action={async (fd) => {
                  await addSideEffect(fd);
                }}
                onSubmit={() => setAddingEffect(false)}
                className="mb-2 space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <input type="hidden" name="id" value={s.id} />
                {open && (
                  <input type="hidden" name="course_id" value={open.id} />
                )}
                <input
                  name="effect"
                  required
                  placeholder="Effect (e.g. Nausea)"
                  className="input text-sm"
                />
                <div className="flex gap-2">
                  <select
                    name="severity"
                    defaultValue=""
                    className="input w-32 text-sm"
                  >
                    <option value="">Severity</option>
                    {SIDE_EFFECT_SEVERITIES.map((sev) => (
                      <option key={sev} value={sev}>
                        {SEVERITY_LABELS[sev]}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    name="noted_on"
                    defaultValue={todayStr}
                    className="input text-sm"
                  />
                </div>
                <input
                  name="notes"
                  placeholder="Notes (optional)"
                  className="input text-sm"
                />
                <SubmitButton pendingLabel="Saving…" className="btn btn-sm">
                  Add side effect
                </SubmitButton>
              </form>
            )}

            {sideEffects.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                None noted.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {sideEffects.map((se) => (
                  <li
                    key={se.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
                  >
                    <span
                      className={`font-medium ${
                        se.resolved
                          ? "text-slate-500 line-through dark:text-slate-400"
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
                    {se.noted_on && (
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {fmt(se.noted_on)}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-2 text-xs">
                      <form
                        action={async (fd) => {
                          await toggleSideEffectResolved(fd);
                        }}
                      >
                        <input type="hidden" name="id" value={se.id} />
                        <SubmitButton className="text-slate-500 hover:underline dark:text-slate-400">
                          {se.resolved ? "Reopen" : "Resolve"}
                        </SubmitButton>
                      </form>
                      {/* Promote is hidden once resolved: promoting marks the
                          effect resolved, so hiding it here (plus the server-side
                          external_id dedup) stops a double-click adding two
                          identical allergy rows. */}
                      {!se.resolved && (
                        <button
                          type="button"
                          className="text-brand-700 hover:underline dark:text-brand-400"
                          onClick={async () => {
                            const ok = await confirm({
                              title: "Promote to intolerance",
                              message: `Add “${se.effect}” as an intolerance in Allergies?`,
                              confirmLabel: "Promote",
                            });
                            if (!ok) return;
                            const fd = new FormData();
                            fd.set("id", String(se.id));
                            await promoteSideEffectToIntolerance(fd);
                          }}
                        >
                          Promote
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-rose-600 hover:underline dark:text-rose-400"
                        onClick={async () => {
                          const ok = await confirm({
                            title: "Delete side effect",
                            message: `Delete “${se.effect}”?`,
                            confirmLabel: "Delete",
                            danger: true,
                          });
                          if (!ok) return;
                          const fd = new FormData();
                          fd.set("id", String(se.id));
                          await deleteSideEffect(fd);
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
