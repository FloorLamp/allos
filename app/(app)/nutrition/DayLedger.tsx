"use client";

import { useState, type ReactNode } from "react";
import { IconChevronDown, IconPill } from "@tabler/icons-react";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import { useLoggedViaStamp } from "@/components/LoggedViaSurface";
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
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import {
  OFFLINE_CAPTURE_REFUSED_MESSAGE,
  shouldQueueOffline,
} from "@/lib/offline/queue";
import { doseConfirmMessage, doseResolved } from "@/lib/dose-outcome-text";
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
import { resolveDayDoses } from "./intake-actions";

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
  /**
   * Whether the rendered day IS today, which decides WHICH write a single dose row
   * offers — not whether it offers one.
   *
   * TODAY gets the shared tri-state (`DoseStatusControl`): taken, deliberately
   * skipped, or CLEAR, each flipping back on a second press. That third state is the
   * one a dated action cannot reach — `resolveDayDoses` resolves, it does not
   * un-resolve — and losing it would mean a mis-tapped dose could not be taken back
   * from the surface that took it. A PAST day inside the window keeps the dated path,
   * which is exactly the seam the quick-log sheet already draws between `markTaken`
   * for today and `resolveDayDoses` for a day behind it.
   */
  isToday: boolean;
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
  onCorrectServing: (eventId: number) => void;
  onRemoveServing: (eventId: number) => void;
  removingServingId: number | null;
}

export default function DayLedger({
  date,
  groups,
  doseWritable,
  isToday,
  prefs,
  keepApart,
  dayContext,
  onCorrectServing,
  onRemoveServing,
  removingServingId,
}: DayLedgerProps) {
  const toast = useToast();
  const stampLoggedVia = useLoggedViaStamp();
  const { enqueue } = useOfflineQueue();
  // Two affordances, two ledgers (#2041): a bulk tap and the single taps beneath it are
  // different writes and neither may be absorbed by the other's cooldown.
  const single = useOptimisticLedger("dose-day");
  const bulk = useOptimisticLedger("dose-day-stack");
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

  // Post one dated resolution. The named ids are an UPPER BOUND: the action re-derives
  // the day's still-unresolved set and writes only the intersection, so this can never
  // ask for more than the label promised and never get more than the day still owes.
  async function post(
    doseIds: readonly number[],
    status: "taken" | "skipped"
  ): Promise<"wrote" | "nothing"> {
    const fd = stampLoggedVia(new FormData());
    fd.set("date", date);
    fd.set("status", status);
    fd.set("dose_ids", doseIds.join(","));
    const result = await resolveDayDoses(fd);
    if (!result.ok) {
      toast(result.error, { tone: "error" });
      return "nothing";
    }
    // Answered from the typed outcomes, never from the ask. A dose the day no longer
    // owes is simply absent from `result.doses`; one that refused is named where it
    // stands.
    for (const dose of result.doses) {
      if (!doseResolved(dose.outcome))
        note(dose.doseId, doseConfirmMessage(dose.outcome).text);
    }
    const landed = result.doses.filter((d) => doseResolved(d.outcome));
    if (landed.length === 0) {
      toast(
        result.doses.length === 0
          ? "Nothing left to log for that day."
          : doseConfirmMessage(result.doses[0]!.outcome).text,
        { tone: "error" }
      );
      return "nothing";
    }
    toast(
      landed.length === 1
        ? doseConfirmMessage(landed[0]!.outcome).text
        : `${landed.length} doses ${status === "taken" ? "logged" : "skipped"}.`
    );
    markResolved(landed.map((d) => d.doseId));
    return "wrote";
  }

  // A single dated tap may be CAPTURED offline: the queued intent carries its own day
  // and the replay re-checks the window with the predicate the core uses.
  async function queue(
    doseId: number,
    status: "taken" | "skipped"
  ): Promise<"wrote" | "nothing"> {
    const kept =
      (await enqueue(status === "taken" ? "dose" : "skip-dose", date, {
        doseId,
      })) === "kept";
    // READ THE ANSWER: the queue can refuse (logged out, no IndexedDB), and claiming a
    // save that did not happen is worse than the missing save (#3038).
    if (!kept) {
      toast(OFFLINE_CAPTURE_REFUSED_MESSAGE, { tone: "error" });
      return "nothing";
    }
    toast(
      status === "taken"
        ? "Dose saved offline — will sync when you reconnect."
        : "Skip saved offline — will sync when you reconnect."
    );
    markResolved([doseId]);
    return "wrote";
  }

  function resolveOne(doseId: number, status: "taken" | "skipped") {
    void single.tap<"wrote" | "nothing">({
      key: `${doseId}->${status}`,
      write: async () => {
        const online =
          typeof navigator === "undefined" || navigator.onLine !== false;
        if (!online) return queue(doseId, status);
        try {
          return await post([doseId], status);
        } catch (err) {
          if (shouldQueueOffline(navigator.onLine !== false, err))
            return queue(doseId, status);
          toast("Couldn't update this dose. Try again.", { tone: "error" });
          return "nothing";
        }
      },
      settle: (outcome) =>
        outcome === "wrote" ? { kind: "keep" } : { kind: "rollback" },
      onError: () => {
        toast("Couldn't update this dose. Try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  function resolveAll(doseIds: readonly number[]) {
    void bulk.tap<"wrote" | "nothing">({
      key: doseIds.join(","),
      write: () => post(doseIds, "taken"),
      settle: (outcome) =>
        outcome === "wrote" ? { kind: "keep" } : { kind: "rollback" },
      onError: () => {
        // A THROW HERE IS NOT "NOTHING HAPPENED". The action resolves each dose in its
        // OWN transaction, so a failure on the third of five leaves the first two
        // committed WITH their supply decrements. We do not know what landed, so we say
        // that and point at the record rather than claiming either outcome.
        toast("Something went wrong — reload to see what was logged.", {
          tone: "error",
        });
        return { kind: "rollback" };
      },
    });
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
        {/* `gap-3`, not a tighter one: both verbs render the control box, whose
            `--control-reach` extends the hit region 6px per side, so anything under
            12px lets the two own the same point — and a mis-tap between taken and
            skipped is a real correctness cost (#3938). */}
        {isToday ? (
          <DoseStatusControl
            doseId={dose.doseId}
            taken={false}
            skipped={false}
            variant="circle"
          />
        ) : (
          <span className="flex shrink-0 items-center gap-3">
            <Button
              data-testid={`ledger-take-${dose.doseId}`}
              disabled={single.blocked(`${dose.doseId}->taken`)}
              onClick={() => resolveOne(dose.doseId, "taken")}
            >
              Take
            </Button>
            <Button
              data-testid={`ledger-skip-${dose.doseId}`}
              disabled={single.blocked(`${dose.doseId}->skipped`)}
              onClick={() => resolveOne(dose.doseId, "skipped")}
            >
              Skip
            </Button>
          </span>
        )}
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
          {/* THE WAY BACK (#232's tri-state, kept). A resolved dose is a statement
              somebody made with one tap, and taking it back has to be one tap too —
              the schedule this ledger replaces gave every one of today's rows this
              control, and losing it would make a mis-tap permanent on the surface
              that made it. Today only: the tri-state's CLEAR has no dated core. */}
          {isToday && (
            <DoseStatusControl
              doseId={row.doseId}
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
              disabled={bulk.blocked(ids.join(","))}
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
        <p
          data-testid="day-ledger-census"
          className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
        >
          {census}
          {dayContext ? ` · ${dayContext}` : ""}
        </p>
      </div>
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
