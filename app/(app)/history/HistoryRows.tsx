"use client";

import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconAlertTriangle,
  IconApple,
  IconBandage,
  IconBrain,
  IconCalendarEvent,
  IconChartLine,
  IconChevronDown,
  IconDroplet,
  IconFileText,
  IconFlag,
  IconFlame,
  IconFlask2,
  IconMoon,
  IconPill,
  IconRipple,
  IconRun,
  IconScaleOutline,
  IconScan,
  IconStethoscope,
  IconTemperature,
  IconTrophy,
  IconVaccine,
  IconVirus,
  type TablerIcon,
} from "@tabler/icons-react";
import { timelineEntryAnchorId } from "@/lib/timeline-format";
import DateField from "@/components/DateField";
import HistoricalDoseForm from "@/components/medications/HistoricalDoseForm";
import LoggedEventRow, {
  LOGGED_EVENT_LIST,
  LOGGED_EVENT_ROW,
  LOGGED_EVENT_TRAILING,
} from "@/components/LoggedEventRow";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useToast } from "@/components/Toast";
import { useUndoableDelete } from "@/components/useUndoableDelete";
import {
  doseOptionsFor,
  type DoseLedgerItem,
} from "@/components/intake/dose-ledger-entry";
import { deleteAdministration } from "@/app/(app)/nutrition/intake-actions";
import {
  deleteFoodLogEvent,
  updateFoodLogEvent,
} from "@/app/(app)/nutrition/actions";
import {
  editPracticeSession,
  removePracticeSession,
} from "@/app/(app)/wellness/actions";
import {
  deleteSubstanceDailyTotalAction,
  updateSubstanceDailyTotalAction,
} from "@/app/(app)/medical/substance-use/actions";
import {
  deleteMetricReading,
  updateMetricReading,
} from "@/app/(app)/trends/reading-actions";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { FOOD_SLOTS } from "@/lib/food-slot";
import {
  HISTORY_KIND_LABELS,
  type HistoryKind,
  type HistoryRollup,
  type HistoryRow,
} from "@/lib/history-format";
import type { AppRoute } from "@/lib/hrefs";
import TimelineFilterLink from "@/components/TimelineFilterLink";
import DestinationLink from "@/components/DestinationLink";
import { MedicalValue } from "@/components/ui";
import { editSymptom, removeSymptom } from "@/app/(app)/symptom-actions";
import { LoggedViaField } from "@/components/LoggedViaSurface";
import {
  deleteCycleAction,
  saveCycleAction,
} from "@/app/(app)/medical/cycles/actions";
import { SYMPTOM_SEVERITY_LEVELS, severityLabelFor } from "@/lib/symptoms";
import { FLOW_LABELS, FLOW_LEVELS } from "@/lib/cycle";

// THE RECORD'S ROWS (#3958 phase 1) — one line, at every viewport.
//
// THE ONE-LINE RULE IS A DELIBERATE EXCEPTION to the #3671 compact-card default, and
// the owner argued it from what this surface is FOR: scanning many rows. What
// truncates first is the detail segment, and that cell is also the row's DISCLOSURE
// where there is more than a line's worth to say (#662/#2920, phase 2d — see the
// detail cell below). The rows are `<li>`s on `LoggedEventRow` (#3891's identity half)
// rather than a `ResponsiveTable`: a table's card mode exists to STACK a row onto
// several lines, which is the thing this surface may not do — an OPEN row's panel is a
// sibling `<li>`, so the row itself is one line whether or not it is open.
//
// WHAT THE ⋯ DOES, AND WHAT IT MAY NOT DO. Every branch below posts to the Server
// Action that domain already had — `deleteAdministration`, `updateFoodLogEvent`,
// `editPracticeSession`, `updateSubstanceDailyTotalAction`, `updateMetricReading` —
// and renders that domain's own form where one exists. NO NEW WRITE PATH: the page is
// a second door onto five write cores, not a sixth core. Each of those actions
// re-checks write access server-side, so the menu below is an affordance and never the
// gate.
//
// AND IT GATES PER ROW, NOT PER PAGE (#4009 item 1 / #2106). In `?view=everyone` the
// merged feed carries other members' rows, and #3958 rules that "⋯ additionally
// requires write access on the row's profile, re-checked server-side". Phase 1 met the
// safety half only — every row that was not the acting profile's rendered read-only,
// because every action above resolved its subject from the session and would have
// written to the wrong one. Now each form posts the ROW's `profile_id` and each action
// gates it through the shared `gateItemProfile` (requireProfileWriteAccess: reachable
// AND write, redirect otherwise). So `writableProfileIds` below decides whether the ⋯
// is DRAWN, and the server decides whether the write LANDS — a forged submit naming a
// profile this login cannot write is refused at the action, which is the half a
// missing button could never prove.

// ONE GLYPH PER KIND, total over the closed registry — the timeline's own icon
// vocabulary, re-housed rather than re-chosen, so a reader who knew the feed's
// symbols still knows the record's. Total means a new kind cannot ship without one.
const KIND_GLYPH: Record<HistoryKind, TablerIcon> = {
  dose: IconPill,
  food: IconApple,
  practice: IconRipple,
  substance: IconFlame,
  body: IconScaleOutline,
  sleep: IconMoon,
  symptom: IconTemperature,
  activity: IconActivity,
  endurance: IconRun,
  milestone: IconTrophy,
  lab: IconChartLine,
  visit: IconCalendarEvent,
  imaging: IconScan,
  medication: IconPill,
  immunization: IconVaccine,
  condition: IconStethoscope,
  allergy: IconAlertTriangle,
  document: IconFileText,
  protocol: IconFlask2,
  goal: IconFlag,
  illness: IconVirus,
  injury: IconBandage,
  cycle: IconDroplet,
  insight: IconBrain,
};

/** A day's collapsed log rows, with the href that opens it and its rendered state. */
export type HistoryRollupLine = HistoryRollup & {
  href: AppRoute;
  open: boolean;
};

// The domain's own delete, adapted to the ONE undoable-delete contract every "remove
// a logged event" in the app answers to (owner ruling 2026-08-05).
async function removeFoodServing(fd: FormData) {
  const outcome = await deleteFoodLogEvent(fd);
  return outcome.ok
    ? { undoId: outcome.undoId }
    : { undoId: null, error: outcome.error };
}

// The symptom bar's own remove, adapted to the undoable-delete contract. It answers in
// the bar's `SymptomLogResult` shape (the optimistic chip reconciles to it), and the
// undo token rides back on the removal itself (#2124) — so the adaptation is a rename,
// not a second delete path.
async function removeSymptomDay(fd: FormData) {
  const outcome = await removeSymptom(fd);
  return outcome.ok
    ? { undoId: outcome.undoId ?? null }
    : { undoId: null, error: outcome.error };
}

async function removeSubstanceDay(fd: FormData) {
  const outcome = await deleteSubstanceDailyTotalAction(fd);
  return outcome.kind === "deleted"
    ? { undoId: outcome.undoId }
    : { undoId: null, error: outcome.error };
}

export default function HistoryRows({
  rows,
  rollups = [],
  writableProfileIds,
  doseItems,
  maxDates,
  defaultTime,
  subjectNames,
  rowClassName = "",
  showGlyphs = true,
}: {
  rows: HistoryRow[];
  /**
   * The day's collapsed log lines (#3958 phase 2), rendered as the day's FIXED LAST
   * lines. Empty on every view but Everything — filtered to a family the page is the
   * plain record, and the day view lists everything.
   */
  rollups?: HistoryRollupLine[];
  /**
   * The profiles this login may WRITE, out of the ones in view (#4009 item 1).
   *
   * A SET RATHER THAN A BOOLEAN, because the question is per row: in
   * `?view=everyone` a caregiver may hold write on one member and read-only on
   * another, and #2106's rule is about the ROW's profile. Resolved once from
   * `scope.access` at the page boundary — the server-side re-check at apply time is
   * the action's `gateItemProfile`, never this.
   */
  writableProfileIds: readonly number[];
  /** Every intake item this profile owns — the dose form's picker and dose options. */
  doseItems: DoseLedgerItem[];
  /**
   * THE LATEST DAY EACH SUBJECT MAY BE CORRECTED TO, keyed by profile — the row's own
   * profile-local today, not the caregiver's (#4009 item 1). One acting-profile
   * `maxDate` bounded a member in a zone AHEAD of the caregiver's out of their own
   * current day: the server accepts it (every bound below is asked of the gated
   * profile) and only the client's `max` attribute refuses. Same shape as
   * `subjectNames` beside it, and total over the rows in view — the page builds it
   * from the same member list the feeds came from.
   */
  maxDates: Record<number, string>;
  defaultTime: string;
  /** Whose row it is, in `?view=everyone`. Empty in single view (#534). */
  subjectNames: Record<number, string>;
  /** The jump rail's lane, spent by the ROW rather than by the band around it. */
  rowClassName?: string;
  /**
   * Whether the leading kind glyph is drawn at all (#4045 §3), extending #3958's own
   * rule that "the glyph column collapses entirely in views that render no glyphs".
   * A glyph differentiates rows; filtered to ONE kind every row wears the same apple,
   * which carries no information and spends the row's leading column to say nothing.
   * The caller decides, because the question is about the VIEW and not about the rows
   * this list happens to hold: a single-kind All view is still All, and its next row
   * could be any kind.
   */
  showGlyphs?: boolean;
}) {
  const prefs = useFormatPrefs();
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  // THE OPEN ROW, in client state rather than in the URL — and the split is a rule,
  // not a preference. The folds and the rollups carry their open state in the URL
  // because expanding them changes what the SERVER must render; this panel's content
  // already arrived on the row, so a round trip would buy a longer URL and nothing
  // else. Same tier as `editingId` and `menuOpenId` beside it: one row at a time, so
  // opening a second closes the first and the list never grows two panels deep.
  const [openPanelId, setOpenPanelId] = useState<string | null>(null);
  const itemById = new Map(doseItems.map((item) => [item.id, item]));

  // WRITE ACCESS ON THE ROW'S OWN PROFILE (#2106), not on the acting one — for EVERY
  // kind now. Phase 2b drew no ⋯ at all on another member's symptom or cycle row,
  // because `editSymptom`, `saveCycleAction` and `deleteCycleAction` resolved their
  // subject from the SESSION: the menu would have corrected the acting profile's own
  // log instead of the row it was drawn on. All three take the row's subject now, so
  // the gate is the same one question for all seven ⋯ kinds and there is no
  // per-kind exception left to keep in sync with the actions.
  const writable = new Set(writableProfileIds);
  const canEdit = (row: HistoryRow) =>
    row.edit != null && writable.has(row.profileId);

  // WHETHER THIS ROW HAS MORE THAN ITS LINE (#662/#2920, phase 2d). Asked of the ROW's
  // own content and never of its kind: the feed's gathers set `detailItems` on the
  // labs, activities, doses and symptom-days that HAVE a breakdown and leave it off
  // the ones that do not, so a kind-keyed predicate would draw an empty panel's
  // control on the rows that carry nothing.
  const hasPanel = (row: HistoryRow) =>
    (row.detailItems?.length ?? 0) > 0 || (row.linkedRefs?.length ?? 0) > 0;

  // AND SO IS "TODAY" — the row's subject decides how far forward its date field
  // reaches, for the same reason its zone decides what a wall clock means.
  const maxDateFor = (row: HistoryRow) => maxDates[row.profileId];

  // EVERY CORRECTION AND EVERY DELETE NAMES ITS SUBJECT (#4009 item 1). The field is
  // `profile_id` because that is how this repo already spells a per-item write's
  // subject — Upcoming's rows, the Tier-1 record rows, the training log all post it,
  // and `gateItemProfile` is the shared reader. Set on EVERY row, including the acting
  // profile's, so there is no branch here that could be wrong on one side: an
  // acting-profile row posts its own id and gates identically.
  const withSubject = (fd: FormData, row: HistoryRow) => {
    fd.set("profile_id", String(row.profileId));
    return fd;
  };

  // The ⋯'s accessible name, and no two rows alike (#2615/#3937): the identity plus
  // the whole when-cell, because two doses of one item on one day are told apart only
  // by the clock.
  const menuName = (row: HistoryRow) =>
    [row.title, row.clock ?? row.date].filter(Boolean).join(" — ");

  async function remove(row: HistoryRow) {
    const edit = row.edit;
    if (!edit) return;
    const ok = await confirm({
      title: `Delete ${HISTORY_KIND_LABELS[row.kind].toLowerCase().replace(/s$/, "")}?`,
      message: `Remove ${menuName(row)} from the record. You can undo this.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setPendingId(row.id);
    if (editingId === row.id) setEditingId(null);
    const fd = withSubject(new FormData(), row);
    try {
      switch (edit.kind) {
        case "dose":
          fd.set("log_id", String(edit.logId));
          await undoable(deleteAdministration, fd, {
            deletedMessage: "Dose deleted.",
          });
          break;
        case "food":
          fd.set("event_id", String(edit.eventId));
          await undoable(removeFoodServing, fd, {
            deletedMessage: "Serving removed",
          });
          break;
        case "practice":
          fd.set("id", String(edit.sessionId));
          await undoable(removePracticeSession, fd, {
            deletedMessage: "Session removed",
          });
          break;
        case "substance":
          fd.set("substance", edit.substance);
          fd.set("id", String(edit.rowId));
          await undoable(removeSubstanceDay, fd, {
            deletedMessage: "Entry removed",
          });
          break;
        case "body":
          fd.set("kind", edit.slug);
          fd.set("target", edit.target);
          await undoable(deleteMetricReading, fd, {
            deletedMessage: "Reading removed",
          });
          break;
        case "symptom":
          // (date, symptom) IS the address — `symptom_logs` is UNIQUE on it and every
          // core in lib/symptom-log-write.ts takes exactly this pair.
          fd.set("symptom", edit.symptom);
          fd.set("date", row.date);
          // AND THE SUBJECT AGAIN, UNDER THE OTHER SHIPPED SPELLING. `removeSymptom`
          // is a symptom-BAR action (#858) as well as this row's delete, and the bar
          // posts its cross-profile target as `profileId`; every other action this
          // component posts reads `profile_id` through `gateItemProfile`. Both gate
          // the same requireProfileWriteAccess(target), so this line is a field name
          // and not a second authorization path — without it the delete would fall
          // back to the acting profile while the Edit beside it corrected the row's
          // own member.
          fd.set("profileId", String(row.profileId));
          await undoable(removeSymptomDay, fd, {
            deletedMessage: "Symptom removed",
          });
          break;
        case "cycle":
          // The ROW, not the marker: deleting either marker deletes the period they
          // are two views of, which is what the confirm names.
          fd.set("id", String(edit.cycleId));
          await undoable(deleteCycleAction, fd, {
            deletedMessage: "Period removed",
          });
          break;
      }
    } catch {
      toast("Couldn't remove that entry.", { tone: "error" });
    } finally {
      setPendingId(null);
    }
  }

  // The correction form, per kind, exactly as that domain already draws it. The dose
  // one IS the domain's component (#2228's amend contract, seeded from the row's
  // STATED instant and nothing else); the other four are the same small field sets
  // their ledgers carried, posting the same actions.
  function editForm(row: HistoryRow, done: () => void): ReactNode {
    const edit = row.edit;
    if (!edit) return null;
    const submitting = pendingId === row.id;

    async function post(
      event: FormEvent<HTMLFormElement>,
      run: (fd: FormData) => Promise<{ ok: boolean; error?: string }>
    ) {
      event.preventDefault();
      const fd = withSubject(new FormData(event.currentTarget), row);
      setPendingId(row.id);
      const outcome = await run(fd);
      setPendingId(null);
      if (!outcome.ok) {
        toast(outcome.error ?? "Couldn't save that change.", { tone: "error" });
        return;
      }
      toast("Corrected.");
      done();
    }

    const buttons = (
      <div className="flex items-end gap-2">
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </button>
        <button className="btn-ghost" type="button" onClick={done}>
          Cancel
        </button>
      </div>
    );

    switch (edit.kind) {
      case "dose": {
        const item = itemById.get(edit.itemId);
        return (
          <HistoricalDoseForm
            itemId={edit.itemId}
            itemName={row.title}
            doses={item ? doseOptionsFor(item, prefs) : []}
            maxDate={maxDateFor(row)}
            defaultTime={defaultTime}
            asNeeded={item?.asNeeded ?? false}
            courseBound={edit.itemKind === "medication"}
            editing={{
              logId: edit.logId,
              doseId: edit.doseId,
              date: row.date,
              statedAt: edit.statedAt,
              amount: edit.amount,
            }}
            // The SUBJECT's id and zone (#4009 item 1). This is the one correction
            // form that is not posted through `post()` above — it owns its own
            // `action` — so it stamps `profile_id` itself, and it is also the only one
            // that collects a wall clock, so it must collect it on the subject's
            // calendar rather than the caregiver's.
            subjectProfileId={row.profileId}
            tz={row.tz}
            onDone={done}
          />
        );
      }
      case "food":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                fd.set("event_id", String(edit.eventId));
                // MOVING A SERVING MOVES THE (DAY, WALL-TIME) PAIR, rather than
                // stranding a stated eating instant on a different profile-local
                // day. An unchanged row omits the patch so its stored precision
                // stays byte-identical, and a logged-at-only row has no eating-time
                // statement to invent.
                const nextDate = String(fd.get("date") ?? "");
                if (
                  nextDate !== row.date &&
                  edit.clockKind === "stated" &&
                  edit.clock
                ) {
                  fd.set("occurred_at", edit.clock);
                }
                return updateFoodLogEvent(fd);
              })
            }
          >
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Date
              <DateField
                name="date"
                defaultValue={row.date}
                max={maxDateFor(row)}
                required
                inputClassName="mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Food group
              <select
                name="group_key"
                defaultValue={edit.groupKey}
                className="input mt-1 w-full"
              >
                {FOOD_GROUPS.map((group) => (
                  <option key={group.slug} value={group.slug}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Meal
              <select
                name="meal_slot"
                defaultValue={edit.mealSlot}
                className="input mt-1 w-full"
              >
                {FOOD_SLOTS.map((slot) => (
                  <option key={slot}>{slot}</option>
                ))}
              </select>
            </label>
            {buttons}
          </form>
        );
      case "practice":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                fd.set("id", String(edit.sessionId));
                const outcome = await editPracticeSession(fd);
                return outcome.kind === "updated"
                  ? { ok: true }
                  : { ok: false, error: "Couldn't save that session." };
              })
            }
          >
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Date
              <DateField
                name="date"
                defaultValue={row.date}
                required
                inputClassName="mt-1 w-full"
              />
            </label>
            {/* THE SESSION'S TIME RIDES ALONG UNCHANGED, AND IT IS THE STORED
                COLUMN. `editPracticeSession` REWRITES every field it reads, so
                omitting one erases it — but posting `row.sortTime` back instead was
                worse than erasing: that is `bestKnownInstant`, which falls back to
                `created_at` for a quick-path tick with no stated time, so correcting
                a DURATION laundered the filing clock into the event column and the
                row stopped saying "logged 19:43". `edit.statedTime` is
                `practice_logs.time` and nothing else — the same value
                `PracticeSessionHistory` posts. (A raw <input type="time"> here would
                be an eleventh hand-rolled "when did this happen" (#2236), which the
                ratchet in lib/__tests__/time-input-scan.test.ts refuses; correcting a
                session's clock stays on the practice card, where the full editor is.) */}
            <input type="hidden" name="time" value={edit.statedTime ?? ""} />
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Duration (minutes)
              <input
                type="number"
                name="duration_min"
                min={1}
                defaultValue={edit.durationMin ?? ""}
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
              Notes
              <input
                type="text"
                name="notes"
                defaultValue={edit.notes ?? ""}
                className="input mt-1 w-full"
              />
            </label>
            {buttons}
          </form>
        );
      case "substance":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                fd.set("substance", edit.substance);
                fd.set("id", String(edit.rowId));
                const outcome = await updateSubstanceDailyTotalAction(fd);
                return outcome.kind === "updated"
                  ? { ok: true }
                  : { ok: false, error: "Couldn't save that entry." };
              })
            }
          >
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Date
              <DateField
                name="date"
                defaultValue={row.date}
                max={maxDateFor(row)}
                required
                inputClassName="mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Amount
              <input
                type="number"
                name="amount"
                min={1}
                defaultValue={edit.amount}
                className="input mt-1 w-full"
              />
            </label>
            {/* Same rewrite-everything contract as the practice edit above: the
                action reads `notes` and stores what it finds, so a form without the
                field would silently clear it. */}
            <label className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
              Notes
              <input
                type="text"
                name="notes"
                defaultValue={edit.notes ?? ""}
                className="input mt-1 w-full"
              />
            </label>
            {buttons}
          </form>
        );
      case "symptom":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                fd.set("symptom", edit.symptom);
                fd.set("date", row.date);
                const outcome = await editSymptom(fd);
                return outcome.ok
                  ? { ok: true }
                  : { ok: false, error: outcome.error };
              })
            }
          >
            {/* `setSymptomSeverityCore` reads `logged_via` off the post (#3087), so
                this form has to say which surface it is — without it every correction
                made here would be stamped with the `page` fallback and the provenance
                ledger would show the dashboard bar's word for a record-page edit. */}
            <LoggedViaField />
            {/* NO DATE FIELD, and that is the store's shape rather than an omission:
                `symptom_logs` is UNIQUE(profile_id, date, symptom), so moving a
                symptom-day to another date is a delete plus a re-log, not an edit —
                and `setSymptomSeverityCore` would silently upsert onto whatever day
                it was handed, merging two days' worst severities into one. */}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Severity
              <select
                name="severity"
                defaultValue={edit.severity}
                className="input mt-1 w-full"
              >
                {SYMPTOM_SEVERITY_LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {severityLabelFor(edit.symptom, level.value)}
                  </option>
                ))}
              </select>
            </label>
            {/* `setSymptomSeverityCore` stores the note it is handed, so the field has
                to be here — the same rewrite-everything contract the practice and
                substance forms above carry, and the same silent data loss without it. */}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Note
              <input
                type="text"
                name="note"
                defaultValue={edit.note ?? ""}
                className="input mt-1 w-full"
              />
            </label>
            {buttons}
          </form>
        );
      case "cycle":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                fd.set("id", String(edit.cycleId));
                const outcome = await saveCycleAction(fd);
                return outcome.ok
                  ? { ok: true }
                  : { ok: false, error: outcome.error };
              })
            }
          >
            {/* BOTH BOUNDARIES, from either marker. The two rows are one period, and
                `saveCycleAction` rewrites the whole row through the shared
                plausibility gate (#1682) — so posting one boundary would clear the
                other, and the gate's overlap check needs both to be meaningful. */}
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Started
              <DateField
                name="period_start"
                defaultValue={edit.periodStart}
                max={maxDateFor(row)}
                required
                inputClassName="mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Ended
              <DateField
                name="period_end"
                defaultValue={edit.periodEnd ?? ""}
                max={maxDateFor(row)}
                inputClassName="mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Flow
              <select
                name="flow"
                defaultValue={edit.flow ?? ""}
                className="input mt-1 w-full"
              >
                <option value="">Not recorded</option>
                {FLOW_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {FLOW_LABELS[level]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Note
              <input
                type="text"
                name="note"
                defaultValue={edit.note ?? ""}
                className="input mt-1 w-full"
              />
            </label>
            {buttons}
          </form>
        );
      case "body":
        return (
          <form
            className="grid gap-2 sm:grid-cols-2"
            onSubmit={(event) =>
              void post(event, async (fd) => {
                fd.set("kind", edit.slug);
                fd.set("target", edit.target);
                if (edit.unit) fd.set("weight_unit", edit.unit);
                return updateMetricReading(fd);
              })
            }
          >
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Value
              <input
                type="number"
                step="any"
                name="value"
                defaultValue={edit.value}
                className="input mt-1 w-full"
                required
              />
            </label>
            {buttons}
          </form>
        );
    }
  }

  const renderRow = (row: HistoryRow) => {
    const Glyph = KIND_GLYPH[row.kind];
    const subject = subjectNames[row.profileId];
    if (editingId === row.id) {
      return (
        <li
          key={row.id}
          data-testid="history-row-editing"
          className={`band card-gutter-action border-t border-(--divider) py-2 first:border-t-0 ${rowClassName}`}
        >
          {editForm(row, () => setEditingId(null))}
        </li>
      );
    }
    return (
      <Fragment key={row.id}>
        <li
          // THE ROW'S ANCHOR (#1068). The day view's intraday chart is a MAP of the day
          // and this list is its detail, so a tick has to have something to scroll to.
          // Built by the same `timelineEntryAnchorId` the model's ticks are built with,
          // from the same id, so the two cannot drift into different spellings.
          // `scroll-mt` keeps the landed row clear of the sticky day header above it.
          id={timelineEntryAnchorId(row.id)}
          data-testid="history-row"
          data-history-kind={row.kind}
          data-history-row-id={row.id}
          className={`${LOGGED_EVENT_ROW} band card-gutter-action scroll-mt-24`}
        >
          {/* THE RAIL'S LANE IS SPENT HERE, on an inner wrapper rather than as
              padding on the row. The row's own `px-4` is a `max-sm:` variant, so a
              base `pr-7` on the same element loses the cascade below `sm` — which is
              exactly the width the rail exists for, and where the ⋯ then sat under
              the strip. A wrapper has no padding of its own to lose to. */}
          <div
            // The wrapper that actually SPENDS the rail's lane, named so a test can
            // measure it. Below `sm` the band fill is full-bleed (#3920) and the day
            // section reserves nothing, so this element is the only place the "row
            // content ends short of the edge" half of that rule is observable.
            data-testid="history-row-content"
            className={`flex min-w-0 flex-1 items-center gap-2 ${rowClassName}`}
          >
            <LoggedEventRow
              icon={
                showGlyphs ? (
                  <Glyph
                    aria-hidden
                    className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
                    stroke={1.75}
                  />
                ) : undefined
              }
            >
              {/* ONE LINE, EVERY VIEWPORT: the cluster truncates unconditionally,
                which is what the row grammar buys with its disclosure. */}
              <span className="flex min-w-0 items-baseline gap-1.5 truncate">
                {row.href && !canEdit(row) && row.edit == null ? (
                  /* THE › HALF OF THE EXCLUSIVE AFFORDANCE (#3958). A row a richer
                     surface owns carries no ⋯, and its pointer is the ONE rightward
                     destination cue the primitive owns — `DestinationLink` draws the
                     chevron and lib/__tests__/destination-link-primitive.test.ts
                     refuses a hand-rolled one inside a link. So the row has exactly one
                     control and one cue, and a row can never show both verbs. */
                  <DestinationLink
                    href={row.href}
                    className="inline-flex shrink-0 items-center text-link"
                    data-testid="history-row-title"
                  >
                    {row.title}
                  </DestinationLink>
                ) : row.href ? (
                  <Link
                    href={row.href}
                    className="shrink-0 text-link"
                    data-testid="history-row-title"
                  >
                    {row.title}
                  </Link>
                ) : (
                  <span className="shrink-0" data-testid="history-row-title">
                    {row.title}
                  </span>
                )}
                {subject ? (
                  <span
                    className="shrink-0 text-xs font-normal text-slate-500 dark:text-slate-400"
                    data-testid="history-row-subject"
                  >
                    {subject}
                  </span>
                ) : null}
                {/* THE DISCLOSURE IS THE DETAIL CELL, and that is what makes it fit
                  this row's grammar rather than porting the feed's card back. #3958
                  rules the row one line at every viewport and the trailing affordance
                  EXCLUSIVE — ⋯ or ›, never both — so a third trailing control was
                  never available, and the leading chevron is already spoken for by
                  the rollup line. What is left is the cell the issue itself points
                  at: "what truncates first; long detail lives behind the row's
                  disclosure". The control is therefore exactly where the truncation
                  happens, it spends no new width (the chevron replaces nothing and
                  sits outside the truncating span, so the line still ends in an
                  ellipsis when it must), and the title link stays independent —
                  a ⋯ row and a › row disclose the same way. */}
                {hasPanel(row) ? (
                  <button
                    type="button"
                    data-testid="history-row-disclosure"
                    aria-expanded={openPanelId === row.id}
                    aria-controls={`${timelineEntryAnchorId(row.id)}-panel`}
                    onClick={() =>
                      setOpenPanelId(openPanelId === row.id ? null : row.id)
                    }
                    className="flex min-w-0 items-center gap-1 text-left text-xs font-normal text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                  >
                    <span
                      className="min-w-0 truncate"
                      data-testid="history-row-detail"
                    >
                      {row.detail}
                    </span>
                    <IconChevronDown
                      aria-hidden
                      className={`h-3 w-3 shrink-0 transition ${
                        openPanelId === row.id ? "rotate-180" : ""
                      }`}
                      stroke={2}
                    />
                  </button>
                ) : row.detail ? (
                  <span
                    className="min-w-0 truncate text-xs font-normal text-slate-500 dark:text-slate-400"
                    data-testid="history-row-detail"
                  >
                    {row.detail}
                  </span>
                ) : null}
              </span>
            </LoggedEventRow>
            {row.clock ? (
              <span
                className={`${LOGGED_EVENT_TRAILING} whitespace-nowrap`}
                data-testid="history-row-clock"
              >
                {row.clock}
              </span>
            ) : null}
            {canEdit(row) ? (
              <OverflowMenu
                kind={HISTORY_KIND_LABELS[row.kind].replace(/s$/, "")}
                itemName={menuName(row)}
                open={menuOpenId === row.id}
                onOpenChange={(open) => setMenuOpenId(open ? row.id : null)}
              >
                {({ close }) => (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="history-row-edit"
                      onClick={() => {
                        close();
                        setEditingId(row.id);
                      }}
                      className={MENU_ITEM}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="history-row-delete"
                      disabled={pendingId === row.id}
                      onClick={() => {
                        close();
                        void remove(row);
                      }}
                      className={MENU_ITEM_DANGER}
                    >
                      Delete
                    </button>
                  </>
                )}
              </OverflowMenu>
            ) : null}
          </div>
        </li>
        {/* THE PANEL IS THE ROW'S SIBLING, NOT ITS CHILD (#4045 §4 — revealed content
          belongs directly beneath the line that revealed it). A row `<li>` is
          `flex items-center` on the shared primitive and every geometry assertion on
          this page measures it; growing it into a column when a reader opens one
          would move the thing those specs measure. The rollup's revealed rows are
          siblings for the same reason. */}
        {openPanelId === row.id ? (
          <li
            id={`${timelineEntryAnchorId(row.id)}-panel`}
            data-testid="history-row-panel"
            data-history-row-id={row.id}
            className="band card-gutter-action border-t border-(--divider) py-2"
          >
            <div
              className={`min-w-0 text-sm text-slate-600 dark:text-slate-300 ${rowClassName}`}
            >
              {row.detailItems && row.detailItems.length > 0 ? (
                <dl className="space-y-1">
                  {row.detailItems.map((item, index) => (
                    <div
                      key={`${row.id}:detail:${index}:${item.label}`}
                      className="grid gap-1 sm:grid-cols-[10rem_1fr]"
                    >
                      <dt className="font-medium text-slate-700 dark:text-slate-200">
                        {item.label}
                      </dt>
                      <dd>
                        {item.unit || item.flag ? (
                          <MedicalValue
                            value={item.value}
                            unit={item.unit ?? null}
                            flag={item.flag ?? null}
                          />
                        ) : (
                          item.value
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {/* LINKED CONTEXT (#662), AND ITS HEADING CLAIMS ONLY WHAT THE GATHER HAD
                (#2920): "From this visit" for rows carrying a real encounter link to
                this visit, the encounter detail page's own vocabulary; the document
                wording only where that import document stands for a SINGLE visit.
                A multi-visit portal export sets neither, because a reference chip
                that cannot honestly name its visit says nothing. Informational
                either way — never a causal claim. */}
              {row.linkedRefs && row.linkedRefs.length > 0 ? (
                <div
                  data-testid="history-linked-refs"
                  className={row.detailItems?.length ? "mt-3" : ""}
                >
                  <p
                    // The heading is addressable on its own, because the two spellings
                    // it chooses between are a PREFIX of one another (#2920): an
                    // assertion that can only reach it through the section would have to
                    // match on containment, and "From this visit" is satisfied by the
                    // document wording too.
                    data-testid="history-linked-scope"
                    className="text-xs font-medium text-slate-500 dark:text-slate-400"
                  >
                    {row.linkedScope === "visit"
                      ? "From this visit"
                      : "From this visit’s document"}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {row.linkedRefs.map((ref, index) => (
                      <Link
                        key={`${row.id}:ref:${index}:${ref.label}`}
                        href={ref.href}
                        className="rounded-sm bg-(--ghost) px-1.5 py-0.5 text-xs text-link"
                      >
                        {ref.label}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </li>
        ) : null}
      </Fragment>
    );
  };

  return (
    // `band` (app/globals.css) is what a hand-rolled `rounded-xl border bg-surface`
    // frame says when it is really a BAND: below `sm` it goes full-bleed and drops
    // its side border and radius (#3673/#3920). The rows then re-spend the page
    // gutter through `card-gutter-action`, which is the SHARED tier for that step —
    // a per-file `max-sm:px-*` here would be the second density convention #3466
    // exists to prevent, and its desktop half (`sm:px-3`) is the row primitive's own
    // value, so nothing above `sm` moves. Without `band` this list would draw the
    // per-surface card frame the flat ban removed, on the one page built to be
    // scanned.
    <ul className={`${LOGGED_EVENT_LIST} band`} data-testid="history-rows">
      {rows.map(renderRow)}
      {/* THE DAY'S FIXED LAST LINES (#3958). An aggregate has no honest single instant,
          so it takes a fixed position rather than competing for one in the sort — and
          an expanded rollup's rows render directly beneath their own line, which is
          the #4045 §4 lesson about where revealed content belongs.

          NO ⋯ AND NO ›: expand is a rollup's only verb, so the trailing cell is empty
          and the link is the whole line. `TimelineFilterLink` carries `scroll={false}`,
          so opening one leaves the reader looking at the line they tapped. */}
      {rollups.map((rollup) => (
        <Fragment key={rollup.key}>
          <li
            data-testid="history-rollup"
            data-rollup-key={rollup.key}
            data-rollup-open={rollup.open ? "true" : "false"}
            className={`${LOGGED_EVENT_ROW} band card-gutter-action`}
          >
            <div
              className={`flex min-w-0 flex-1 items-center gap-2 ${rowClassName}`}
            >
              <TimelineFilterLink
                href={rollup.href}
                testId={`history-rollup-${rollup.key}`}
                label={rollup.label}
                ariaExpanded={rollup.open}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span
                  aria-hidden
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center text-slate-500 transition dark:text-slate-400 ${
                    rollup.open ? "rotate-180" : ""
                  }`}
                >
                  <IconChevronDown className="h-3.5 w-3.5" stroke={2} />
                </span>
                {/* LEFT-ALIGNED IN THE TITLE COLUMN, SPANNING TO THE FAR EDGE
                    (#3958): a rollup stands for a set, not for a row, so it draws no
                    phantom trailing cells to line up with the rows above it. */}
                <span className="min-w-0 flex-1 truncate">{rollup.label}</span>
                {subjectNames[rollup.profileId] ? (
                  <span
                    className="shrink-0 text-xs font-normal text-slate-500 dark:text-slate-400"
                    data-testid="history-row-subject"
                  >
                    {subjectNames[rollup.profileId]}
                  </span>
                ) : null}
              </TimelineFilterLink>
            </div>
          </li>
          {rollup.open ? rollup.rows.map(renderRow) : null}
        </Fragment>
      ))}
    </ul>
  );
}
