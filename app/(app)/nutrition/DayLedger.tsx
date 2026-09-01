"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown, IconPill } from "@tabler/icons-react";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import LoggedEventRow, {
  LOGGED_EVENT_LIST,
  LOGGED_EVENT_ROW,
  LOGGED_EVENT_TRAILING,
} from "@/components/LoggedEventRow";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import Button from "@/components/Button";
import DoseStatusControl from "@/components/DoseStatusControl";
import { EmptyState } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { useDoseDayResolution } from "@/components/medications/dose-day-settlement";
import { dosesPhrase } from "@/lib/usual-routine";
import { historyClock } from "@/lib/history-format";
import type { DisplayFormatPrefs } from "@/lib/settings";
import { TIME_BUCKET_LABELS } from "@/lib/intake-schedule";
import {
  dayCountsLabel,
  stackLabel,
  type LedgerGroup,
  type LedgerRow,
  type LedgerStack,
} from "@/lib/day-ledger";
import type { PendingDayDose } from "@/lib/queries/usual-routine";
import CheckboxControl from "@/components/CheckboxControl";
import WhenControl from "@/components/WhenControl";
import { useTimezone } from "@/components/TimezoneProvider";
import { statedHhmm, type WhenValue } from "@/lib/stated-time";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  deleteLedgerSelection,
  moveLedgerSelectionToDay,
  setLedgerSelectionTime,
  type LedgerSelectionEditResult,
} from "./intake-actions";

// THE DAY LEDGER (#3987 phase 1).
//
// ONE surface for what a day held: food servings and supplement doses interleaved in
// the profile's own time buckets. It replaces three renderings of the same facts — the
// Meals cards, the LOGGED TODAY list, and the Supplements tab's daily schedule — and
// the acceptance criterion it exists for is that no fact appears on two of them.
//
// THE ROWS IT DRAWS, and where each one's truth comes from:
//
//   serving   a food_log_events row, corrected/removed through the bar's OWN modal
//             (the ⋯ calls back up, so re-timing keeps going through the correction
//             contract rather than a bare time input on the row);
//   dose      one resolved intake_item_logs row — TAKEN or SKIPPED, and a skip states
//             its stored reason, because a skip is a recorded event;
//   stack     one composed write collapsed (`buildDayLedger`), stating "4 of 6" when
//             the routine is partly open;
//   due       the bucket's still-unresolved doses, with the bulk Take-all.
//
// THE BULK WRITE IS #3936'S CONTRACT VERBATIM. The row NAMES every dose it will write
// and `resolveDayDoses` re-derives the day's pending set server-side, writing only the
// listed-and-still-unresolved intersection: a stale tap — the phone already logged it,
// another tab already logged it — refuses and says so, rather than double-logging.
// Single taps queue offline like the sheet's; the bulk row is online-only by
// declaration, for the reason argued in OFFLINE_QUEUE_COVERAGE.
//
// NOT MIRRORED INTO LOCAL STATE. The rows come straight from the server (#1934's
// posture, which the LOGGED list already held): every write here revalidates
// /nutrition, so a local copy could only drift from the answer. What IS local is
// `resolved` — the occurrences this session has written — so a row leaves the list
// under the finger that resolved it instead of waiting for a navigation.

/** The identity of one dose OCCURRENCE: a day plus the schedule row that asks for it. */
function occurrenceKey(date: string, doseId: number): string {
  return `${date}:${doseId}`;
}

export interface DayLedgerProps {
  date: string;
  groups: LedgerGroup[];
  /**
   * Whether this day is still inside `DOSE_LOG_DATE_WINDOW_DAYS`. Beyond it the write
   * cores refuse, so the ledger offers nothing to tap and renders the day as record —
   * the same bound `doseLogDays` draws, never a second opinion about it.
   */
  doseWritable: boolean;
  prefs: DisplayFormatPrefs;
  /**
   * Keep-apart guidance for the buckets that still owe doses, ALREADY RENDERED.
   *
   * Server-rendered nodes rather than data: the dismissal rides `DismissFindingButton`,
   * whose form action is an inline `"use server"` — a server component, which a client
   * island may render as a child but cannot import. Current safety guidance, so the
   * caller passes it for TODAY only.
   */
  keepApart: { bucket: string; content: ReactNode }[];
  /** The workout/rest context this day carries, where training is tracked. */
  dayContext: string | null;
  /**
   * The days a SELECTION may be moved to — the page's own day picker, minus the day
   * being rendered. Empty disables Move to day…, which is the honest rendering when
   * there is nowhere to move to; the server bounds the same span independently
   * (`LEDGER_DAY_SPAN`), so this list is the offer and never the gate.
   */
  moveDays: { date: string; label: string }[];
  onCorrectServing: (eventId: number) => void;
  onRemoveServing: (eventId: number) => void;
  removingServingId: number | null;
}

export default function DayLedger({
  date,
  groups,
  doseWritable,
  prefs,
  keepApart,
  dayContext,
  moveDays,
  onCorrectServing,
  onRemoveServing,
  removingServingId,
}: DayLedgerProps) {
  const toast = useToast();
  const [resolved, setResolved] = useState<Set<string>>(() => new Set());
  // The last outcome per occurrence that did NOT resolve it — shown inline, so the
  // reason a row is still there is legible without hunting for the toast.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // FUNCTIONAL, never `new Set(resolved)`: the bulk row calls this with many ids at
  // once, so two taps inside one render batch would have the second overwrite the first
  // from a stale closure — the resolved row reappears and a second tap earns an error
  // for a dose that is correctly logged (#3936's own note on this).
  function markResolved(doseIds: readonly number[]): void {
    setResolved((prev) => {
      const next = new Set(prev);
      for (const id of doseIds) next.add(occurrenceKey(date, id));
      return next;
    });
  }

  function note(doseId: number, text: string): void {
    setNotes((prev) => ({ ...prev, [occurrenceKey(date, doseId)]: text }));
  }

  const { resolveAll, bulkBlocked } = useDoseDayResolution({
    date,
    bulkFailureMessage: "Something went wrong — reload to see what was logged.",
    note,
    resolved: markResolved,
  });

  // ── SELECTION MODE (#4118) ──────────────────────────────────────────────────
  //
  // A day reconstructed late is wrong the SAME way on every row it holds — the reported
  // case is a whole morning logged the next afternoon — so the repair is one gesture over
  // many rows, not the ⋯ menu N times. What a selection can do is deliberately the three
  // things the ⋯ menu can do to one row, and each one goes through the SAME correction
  // core (lib/day-ledger-edit.ts): there is no bulk write path here, only a bulk caller of
  // the per-row ones.
  //
  // SELECTABLE IS "already a record": servings and TAKEN doses, stack members included. A
  // still-due dose has no row to correct, and a SKIPPED one is re-answered on its own row
  // rather than amended — both cores that could act on a skip scope themselves to taken.
  const confirm = useConfirm();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<{ servings: number[]; doses: number[] }>(
    () => ({ servings: [], doses: [] })
  );
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<"time" | "day" | null>(null);
  // THE ONE "WHEN" CONTROL (#2236/#3273), with its day FIXED to the ledger's own:
  // min === max, so it renders the day as text and the pair rule holds trivially. The
  // batch never re-dates through this control — Move to day… is the other verb, and
  // giving Set time… a day picker too would be two answers to one question.
  const tz = useTimezone();
  const [batchWhen, setBatchWhen] = useState<WhenValue>(() => ({
    date,
    statedAt: null,
  }));
  const [batchDay, setBatchDay] = useState("");
  const pickedCount = picked.servings.length + picked.doses.length;

  function togglePick(kind: "servings" | "doses", id: number): void {
    setPicked((prev) => {
      const list = prev[kind];
      return {
        ...prev,
        [kind]: list.includes(id)
          ? list.filter((x) => x !== id)
          : [...list, id],
      };
    });
  }

  function leaveSelection(): void {
    setSelecting(false);
    setSheet(null);
    setPicked({ servings: [], doses: [] });
    setBatchWhen({ date, statedAt: null });
  }

  /** The box a selectable row carries while selection mode is on, and nothing otherwise. */
  function pickBox(kind: "servings" | "doses", id: number, label: string) {
    if (!selecting) return null;
    return (
      <CheckboxControl
        label={label}
        checked={picked[kind].includes(id)}
        onChange={() => togglePick(kind, id)}
        data-testid={`ledger-pick-${kind === "servings" ? "serving" : "dose"}-${id}`}
      />
    );
  }

  // Post one batch and SAY WHAT LANDED. The action answers with the rows it wrote and
  // every row it refused, each carrying the reason its own core gave — so a batch that
  // half-lands says so rather than confirming all of it (#232's contract, at batch
  // grain). The rows themselves come back from the server revalidation the action ran.
  async function runBatch(
    verb: "Updated" | "Removed",
    action: (fd: FormData) => Promise<LedgerSelectionEditResult>,
    extra: Record<string, string>
  ): Promise<void> {
    const fd = new FormData();
    fd.set("date", date);
    fd.set("serving_ids", picked.servings.join(","));
    fd.set("dose_log_ids", picked.doses.join(","));
    for (const [key, value] of Object.entries(extra)) fd.set(key, value);
    setBusy(true);
    try {
      const result = await action(fd);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      if (result.applied === 0) {
        toast(result.refused[0]?.reason ?? "Nothing changed.", {
          tone: "error",
        });
        return;
      }
      toast(
        result.refused.length === 0
          ? `${verb} ${result.applied} ${result.applied === 1 ? "row" : "rows"}.`
          : `${verb} ${result.applied} of ${result.applied + result.refused.length} — ${result.refused[0]!.reason}`,
        result.refused.length === 0 ? undefined : { tone: "error" }
      );
      leaveSelection();
    } catch {
      toast("Something went wrong — reload to see what changed.", {
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeSelection(): Promise<void> {
    // ONE confirmation for the batch (the ruling). The per-row ⋯ removal offers an Undo
    // toast instead; a batch trades that for the question asked once, and the rows are
    // still recoverable from the Trash, which is where both paths' captures land.
    const ok = await confirm({
      title: `Remove ${pickedCount} ${pickedCount === 1 ? "row" : "rows"}?`,
      message: "They move to the Trash, where they can be restored.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await runBatch("Removed", deleteLedgerSelection, {});
  }

  const pending = (dose: PendingDayDose) =>
    !resolved.has(occurrenceKey(date, dose.doseId));

  // Beyond `DOSE_LOG_DATE_WINDOW_DAYS` the write cores refuse, so the row states what
  // the day owed and offers nothing — a control whose every tap would be refused is
  // not an affordance, it is a lie the surface tells.
  function readOnlyDoseRow(dose: PendingDayDose) {
    return (
      <li
        key={dose.doseId}
        data-testid={`ledger-due-dose-${dose.doseId}`}
        className={LOGGED_EVENT_ROW}
      >
        <LoggedEventRow icon={<DoseGlyph />}>{dose.name}</LoggedEventRow>
        <span className={LOGGED_EVENT_TRAILING}>Not recorded</span>
      </li>
    );
  }

  function doseTapRow(dose: PendingDayDose) {
    const key = occurrenceKey(date, dose.doseId);
    return (
      <li
        key={dose.doseId}
        data-testid={`ledger-due-dose-${dose.doseId}`}
        className={LOGGED_EVENT_ROW}
      >
        <LoggedEventRow icon={<DoseGlyph />}>
          {dose.name}
          {dose.detail ? (
            <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
              {dose.detail}
            </span>
          ) : null}
          {notes[key] && (
            <span
              data-testid={`ledger-dose-note-${dose.doseId}`}
              className="block text-xs font-medium text-rose-600 dark:text-rose-400"
            >
              {notes[key]}
            </span>
          )}
        </LoggedEventRow>
        {/* ONE CONTROL, ANY WRITABLE DAY (#4424 ruling 3). This row used to pick
            between the tri-state and a hand-rolled Take/Skip pair on `isToday`,
            because `setDoseStatus` stamped today; the control carries the row's day
            now, so the flag that selected a layout is gone rather than moved. */}
        <DoseStatusControl
          doseId={dose.doseId}
          date={date}
          taken={false}
          skipped={false}
          variant="circle"
          onSettled={(result) =>
            result.ok ? markResolved([dose.doseId]) : note(dose.doseId, result.error)
          }
        />
      </li>
    );
  }

  function renderRow(row: LedgerRow) {
    if (row.kind === "serving") {
      const clock = historyClock(row.hhmm, row.clockKind, prefs);
      return (
        <li
          key={row.id}
          data-testid={`ledger-serving-${row.eventId}`}
          data-slot={row.bucket}
          data-group={row.slug}
          aria-busy={removingServingId === row.eventId || undefined}
          className={`${LOGGED_EVENT_ROW}${
            removingServingId === row.eventId ? " opacity-50" : ""
          }`}
        >
          {pickBox("servings", row.eventId, `Select the ${row.name} serving`)}
          <LoggedEventRow
            icon={
              <FoodGroupIcon
                slug={row.slug}
                className="h-4 w-4 shrink-0 text-slate-400"
              />
            }
          >
            {row.name}
          </LoggedEventRow>
          <span className={LOGGED_EVENT_TRAILING}>{clock}</span>
          <OverflowMenu
            // The name says WHICH time it names: "logged at" over an eating time was a
            // wrong claim (#2227), so the two clocks read differently here exactly as
            // they did on the list this row replaces.
            itemName={
              row.clockKind === "stated"
                ? `the ${row.name} serving eaten at ${row.hhmm}`
                : `the ${row.name} serving logged at ${row.hhmm}`
            }
            open={open.has(row.id)}
            onOpenChange={(next) => toggle(row.id)}
          >
            {({ close }) => (
              <>
                <button
                  type="button"
                  className={MENU_ITEM}
                  data-testid={`ledger-serving-correct-${row.eventId}`}
                  onClick={() => {
                    close();
                    onCorrectServing(row.eventId);
                  }}
                >
                  Correct this serving
                </button>
                <button
                  type="button"
                  className={MENU_ITEM_DANGER}
                  data-testid={`ledger-serving-remove-${row.eventId}`}
                  onClick={() => {
                    close();
                    onRemoveServing(row.eventId);
                  }}
                >
                  Remove this serving
                </button>
              </>
            )}
          </OverflowMenu>
        </li>
      );
    }

    if (row.kind === "dose") {
      return (
        <li
          key={row.id}
          data-testid={`ledger-dose-${row.logId}`}
          data-status={row.status}
          className={`${LOGGED_EVENT_ROW}${
            row.status === "skipped"
              ? " text-slate-500 dark:text-slate-400"
              : ""
          }`}
        >
          {/* Only a TAKEN row: a skip is re-answered on its own control, and both cores
              a batch could reach scope themselves to taken. */}
          {row.status === "taken"
            ? pickBox("doses", row.logId, `Select the ${row.name} dose`)
            : null}
          <LoggedEventRow icon={<DoseGlyph />}>
            {row.name}
            <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
              {/* A skip is a recorded event and states its own reason, so the row can
                  never read as "nothing happened here". */}
              {row.status === "skipped"
                ? row.skipReason
                  ? `Skipped — ${row.skipReason}`
                  : "Skipped"
                : row.detail}
            </span>
          </LoggedEventRow>
          <span className={LOGGED_EVENT_TRAILING}>
            {historyClock(row.hhmm, row.clockKind, prefs)}
          </span>
          {/* THE WAY BACK (#232's tri-state). A resolved dose is a statement somebody
              made with one tap, and taking it back has to be one tap too. This was
              TODAY ONLY on the reasoning that "the tri-state's CLEAR has no dated
              core" — the core took a day all along (`setDoseStatusCore` gates on
              `isDoseDateAccepted`, the ±2 window); it was the ACTION that stamped
              today. So a dose taken on the wrong past day could be logged from this
              ledger and not un-logged from it. Inside the write window every day's
              rows carry it now; beyond it nothing is offered, because nothing would
              be written. */}
          {doseWritable && (
            <DoseStatusControl
              doseId={row.doseId}
              date={date}
              taken={row.status === "taken"}
              skipped={row.status === "skipped"}
              variant="circle"
            />
          )}
        </li>
      );
    }

    if (row.kind === "stack") return renderStack(row);

    const doses = row.doses.filter(pending);
    if (doses.length === 0) return null;
    const ids = doses.map((d) => d.doseId);
    const expanded = open.has(row.id);
    return (
      <li key={row.id} className="border-t border-(--divider) first:border-t-0">
        <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
          <button
            type="button"
            data-testid={`ledger-due-group-${row.bucket}`}
            data-doses={ids.join(",")}
            aria-expanded={expanded}
            onClick={() => toggle(row.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-slate-800 dark:text-slate-100"
          >
            <IconChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              stroke={2}
            />
            <span className="min-w-0 flex-1 max-sm:truncate">
              {TIME_BUCKET_LABELS[row.bucket]} doses
              <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                {/* "due" is present tense. Past the write window the day is over and
                    nothing about it is still owed, so the row states what the record
                    holds instead of what the schedule wanted. */}
                {doses.length} {doseWritable ? "due" : "not recorded"}
              </span>
            </span>
          </button>
          {doseWritable && (
            <Button
              data-testid={`ledger-takeall-${row.bucket}`}
              aria-label={`Take all ${doses.length}: ${dosesPhrase(doses)}`}
              disabled={bulkBlocked(ids)}
              onClick={() => resolveAll(ids)}
            >
              Take all {doses.length}
            </Button>
          )}
        </div>
        {expanded && (
          <ul className="border-t border-(--divider)">
            {doses.map((dose) =>
              doseWritable ? doseTapRow(dose) : readOnlyDoseRow(dose)
            )}
          </ul>
        )}
      </li>
    );
  }

  function renderStack(row: LedgerStack) {
    const stillOpen = row.open.filter(pending);
    const expanded = open.has(row.id);
    const label = stackLabel({ ...row, open: stillOpen });
    return (
      <li key={row.id} className="border-t border-(--divider) first:border-t-0">
        <div className="flex min-h-11 items-center gap-2 px-3 py-1.5">
          <button
            type="button"
            data-testid={`ledger-stack-${row.id}`}
            data-stack={row.stack}
            data-label={label}
            aria-expanded={expanded}
            onClick={() => toggle(row.id)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-slate-800 dark:text-slate-100"
          >
            <IconChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${
                expanded ? "rotate-180" : ""
              }`}
              stroke={2}
            />
            <span className="min-w-0 flex-1 max-sm:truncate">
              {row.stack}
              <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                {label}
              </span>
            </span>
          </button>
          <span className={LOGGED_EVENT_TRAILING}>
            {historyClock(row.hhmm, row.clockKind, prefs)}
          </span>
        </div>
        {expanded && (
          <ul className="border-t border-(--divider)">
            {row.written.map((dose) => (
              <li
                key={dose.id}
                data-testid={`ledger-dose-${dose.logId}`}
                data-status={dose.status}
                className={LOGGED_EVENT_ROW}
              >
                {dose.status === "taken"
                  ? pickBox("doses", dose.logId, `Select the ${dose.name} dose`)
                  : null}
                <LoggedEventRow icon={<DoseGlyph />}>
                  {dose.name}
                  <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                    {dose.detail}
                  </span>
                </LoggedEventRow>
              </li>
            ))}
            {stillOpen.map((dose) =>
              doseWritable ? doseTapRow(dose) : readOnlyDoseRow(dose)
            )}
          </ul>
        )}
      </li>
    );
  }

  // Is there anything a selection could act on? A day of nothing but due doses offers no
  // Select control at all — an affordance whose every target is absent is a lie the
  // surface tells (the readOnlyDoseRow reasoning, applied to the header).
  const selectableCount = groups.reduce(
    (total, group) =>
      total +
      group.rows.reduce((n, row) => {
        if (row.kind === "serving") return n + 1;
        if (row.kind === "dose") return n + (row.status === "taken" ? 1 : 0);
        if (row.kind === "stack")
          return n + row.written.filter((d) => d.status === "taken").length;
        return n;
      }, 0),
    0
  );

  const totals = groups.reduce(
    (acc, group) => ({
      servings: acc.servings + group.servings,
      doses: acc.doses + group.doses,
    }),
    { servings: 0, doses: 0 }
  );
  const census = dayCountsLabel(totals.servings, totals.doses);

  return (
    <section data-testid="day-ledger" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="section-label">Ledger</h3>
        <span className="flex items-center gap-3">
          <p
            data-testid="day-ledger-census"
            className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
          >
            {census}
            {dayContext ? ` · ${dayContext}` : ""}
          </p>
          {selectableCount > 0 && (
            <Button
              data-testid="ledger-select-toggle"
              onClick={() =>
                selecting ? leaveSelection() : setSelecting(true)
              }
            >
              {selecting ? "Cancel" : "Select"}
            </Button>
          )}
        </span>
      </div>
      {selecting && (
        <div
          data-testid="ledger-selection-bar"
          className="flex flex-wrap items-center gap-2 rounded-md border border-(--divider) bg-slate-50 px-3 py-2 dark:bg-slate-900"
        >
          <span
            data-testid="ledger-selection-count"
            className="text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200"
          >
            {pickedCount} selected
          </span>
          <Button
            data-testid="ledger-selection-set-time"
            disabled={pickedCount === 0 || busy}
            onClick={() => setSheet(sheet === "time" ? null : "time")}
          >
            Set time…
          </Button>
          <Button
            data-testid="ledger-selection-move-day"
            disabled={pickedCount === 0 || busy || moveDays.length === 0}
            onClick={() => setSheet(sheet === "day" ? null : "day")}
          >
            Move to day…
          </Button>
          <Button
            data-testid="ledger-selection-delete"
            disabled={pickedCount === 0 || busy}
            onClick={() => void removeSelection()}
          >
            Delete
          </Button>
          {sheet === "time" && (
            <span className="flex items-center gap-2">
              {/* ONE time for the batch, in the app's one time vocabulary. The wall
                  clock is what travels; the core re-anchors it on the day being
                  rendered, so a time that has not happened yet is refused THERE by the
                  same gate every other stated instant passes, rather than talked out
                  of here. */}
              <WhenControl
                mode="state"
                grain="minute"
                timeRequired
                value={batchWhen}
                onChange={setBatchWhen}
                minDate={date}
                maxDate={date}
                timeLabel="Time for the selected rows"
                testId="ledger-selection-when"
              />
              <Button
                data-testid="ledger-selection-time-apply"
                disabled={busy || batchWhen.statedAt === null}
                onClick={() =>
                  void runBatch("Updated", setLedgerSelectionTime, {
                    time: statedHhmm(batchWhen.statedAt, tz),
                  })
                }
              >
                Apply
              </Button>
            </span>
          )}
          {sheet === "day" && (
            <span className="flex items-center gap-2">
              <select
                aria-label="Day to move the selected rows to"
                data-testid="ledger-selection-day-select"
                className="input"
                value={batchDay}
                onChange={(event) => setBatchDay(event.target.value)}
              >
                <option value="">Choose a day…</option>
                {moveDays.map((day) => (
                  <option key={day.date} value={day.date}>
                    {day.label}
                  </option>
                ))}
              </select>
              <Button
                data-testid="ledger-selection-day-apply"
                disabled={busy || batchDay === ""}
                onClick={() =>
                  void runBatch("Updated", moveLedgerSelectionToDay, {
                    to_date: batchDay,
                  })
                }
              >
                Apply
              </Button>
            </span>
          )}
        </div>
      )}
      {groups.length === 0 ? (
        <EmptyState
          compact
          testId="day-ledger-empty"
          message="Nothing logged yet."
        />
      ) : (
        groups.map((group) => {
          const warnings = keepApart.find(
            (entry) => entry.bucket === group.bucket
          )?.content;
          return (
            <section
              key={group.bucket}
              data-testid={`ledger-group-${group.bucket
                .toLowerCase()
                .replaceAll(" ", "-")}`}
            >
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <h4 className="section-label">
                  {TIME_BUCKET_LABELS[group.bucket]}
                </h4>
                <span
                  data-testid={`ledger-group-count-${group.bucket
                    .toLowerCase()
                    .replaceAll(" ", "-")}`}
                  className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
                >
                  {dayCountsLabel(group.servings, group.doses)}
                </span>
              </div>
              {/* Keep-apart guidance is rendered WHERE THE DUE DOSES ARE (#3987's
                  anti-drop gate): it is current safety advice about what to take
                  together, so it belongs beside the taps, not on a management list. */}
              {warnings}
              {/* Named so "the ledger's rows" is addressable as itself rather than as
                  "the first `ul` inside the section", which is what the chrome
                  measurement in e2e/day-ledger.spec.ts used to rely on. That is a
                  robustness improvement and NOT a diagnosed fix — see the spec, which
                  carries the honest account of what is and is not known. */}
              <ul data-testid="ledger-rows" className={LOGGED_EVENT_LIST}>
                {group.rows.map(renderRow)}
              </ul>
            </section>
          );
        })
      )}
    </section>
  );
}

function DoseGlyph() {
  return (
    <IconPill className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
  );
}
