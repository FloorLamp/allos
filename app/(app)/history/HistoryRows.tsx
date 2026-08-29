"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import {
  IconApple,
  IconFlame,
  IconPill,
  IconRipple,
  IconScaleOutline,
} from "@tabler/icons-react";
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
import { HISTORY_KIND_LABELS, type HistoryRow } from "@/lib/history-format";

// THE RECORD'S ROWS (#3958 phase 1) — one line, at every viewport.
//
// THE ONE-LINE RULE IS A DELIBERATE EXCEPTION to the #3671 compact-card default, and
// the owner argued it from what this surface is FOR: scanning many rows. So there is
// no tap-to-disclose here — what truncates first is the detail segment, and a row's
// long content lives on the record's own page behind the title link. That is also why
// the rows are `<li>`s on `LoggedEventRow` (#3891's identity half) rather than a
// `ResponsiveTable`: a table's card mode exists to STACK a row onto several lines,
// which is the thing this surface may not do.
//
// WHAT THE ⋯ DOES, AND WHAT IT MAY NOT DO. Every branch below posts to the Server
// Action that domain already had — `deleteAdministration`, `updateFoodLogEvent`,
// `editPracticeSession`, `updateSubstanceDailyTotalAction`, `updateMetricReading` —
// and renders that domain's own form where one exists. NO NEW WRITE PATH: the page is
// a second door onto five write cores, not a sixth core. Each of those actions
// re-checks write access server-side, so the menu below is an affordance and never the
// gate.
//
// AND IT IS ACTING-PROFILE ONLY. In `?view=everyone` the merged feed carries other
// members' rows, and every one of these actions resolves ITS profile from the session's
// acting profile — so a ⋯ on somebody else's row would either write to the wrong
// subject or refuse. The row renders read-only instead (`canEdit` below), which is the
// honest form of #2106's "⋯ additionally requires write access on the row's profile"
// until those cores take a subject.

const KIND_GLYPH = {
  dose: IconPill,
  food: IconApple,
  practice: IconRipple,
  substance: IconFlame,
  body: IconScaleOutline,
} as const;

// The domain's own delete, adapted to the ONE undoable-delete contract every "remove
// a logged event" in the app answers to (owner ruling 2026-08-05).
async function removeFoodServing(fd: FormData) {
  const outcome = await deleteFoodLogEvent(fd);
  return outcome.ok
    ? { undoId: outcome.undoId }
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
  actingProfileId,
  canWrite,
  doseItems,
  maxDate,
  defaultTime,
  subjectNames,
}: {
  rows: HistoryRow[];
  actingProfileId: number;
  canWrite: boolean;
  /** Every intake item this profile owns — the dose form's picker and dose options. */
  doseItems: DoseLedgerItem[];
  maxDate: string;
  defaultTime: string;
  /** Whose row it is, in `?view=everyone`. Empty in single view (#534). */
  subjectNames: Record<number, string>;
}) {
  const prefs = useFormatPrefs();
  const confirm = useConfirm();
  const undoable = useUndoableDelete();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const itemById = new Map(doseItems.map((item) => [item.id, item]));

  const canEdit = (row: HistoryRow) =>
    canWrite && row.edit != null && row.profileId === actingProfileId;

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
    const fd = new FormData();
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
      const fd = new FormData(event.currentTarget);
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
            maxDate={maxDate}
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
                return updateFoodLogEvent(fd);
              })
            }
          >
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Date
              <DateField
                name="date"
                defaultValue={row.date}
                max={maxDate}
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
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Time
              <input
                type="time"
                name="time"
                defaultValue={row.sortTime ?? ""}
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-xs text-slate-500 dark:text-slate-400">
              Duration (minutes)
              <input
                type="number"
                name="duration_min"
                min={1}
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
                max={maxDate}
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

  return (
    <ul className={LOGGED_EVENT_LIST} data-testid="history-rows">
      {rows.map((row) => {
        const Glyph = KIND_GLYPH[row.kind];
        const subject = subjectNames[row.profileId];
        if (editingId === row.id) {
          return (
            <li
              key={row.id}
              data-testid="history-row-editing"
              className="border-t border-(--divider) px-3 py-2 first:border-t-0"
            >
              {editForm(row, () => setEditingId(null))}
            </li>
          );
        }
        return (
          <li
            key={row.id}
            data-testid="history-row"
            data-history-kind={row.kind}
            data-history-row-id={row.id}
            className={LOGGED_EVENT_ROW}
          >
            <LoggedEventRow
              icon={
                <Glyph
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
                  stroke={1.75}
                />
              }
            >
              {/* ONE LINE, EVERY VIEWPORT: the cluster truncates unconditionally,
                  which is what the row grammar buys with its disclosure. */}
              <span className="flex min-w-0 items-baseline gap-1.5 truncate">
                {row.href ? (
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
                {row.detail ? (
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
          </li>
        );
      })}
    </ul>
  );
}
