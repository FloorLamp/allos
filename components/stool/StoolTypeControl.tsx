"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import BristolStoolIcon from "@/components/BristolStoolIcon";
import { useWritePipeline } from "@/components/useWritePipeline";
import { useTimeStatement } from "@/components/TimeStatement";
import { useToast } from "@/components/Toast";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatClockValue } from "@/lib/format-date";
import { undoRefusalText, type UndoOffer } from "@/lib/undo-offer";
import { BRISTOL_STOOL_TYPES, bristolReceiptLines } from "@/lib/bristol-stool";
import {
  correctStoolReading,
  deleteStoolReading,
  loadStoolDay,
  logStoolForm,
  type StoolDayReading,
  type StoolReadingReceipt,
} from "@/app/(app)/stool-actions";
import RollingNumber from "@/components/RollingNumber";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import { microMotionPlan } from "@/lib/micro-motion";
import { useOptionalDayContext } from "@/components/DayContext";
import { OFFLINE_OTHER_SUBJECT_MESSAGE } from "@/lib/offline/queue";

// THE STOOL DOMAIN'S ROW CONTROL (#4424 ruling 7), named by
// `LOG_MANIFEST.stool.pieces.rowControl`: the Bristol Stool Form Scale as seven one-tap
// buttons over the day's running count. As `QuickStoolForm` it hand-rolled the commit
// dance — ledger wiring, the offline decision, the enqueue, the refused-capture
// sentence, the toast. `useWritePipeline` owns all of that now (#3276); what is left is
// what this domain's tap MEANS.
//
// WHY SEVEN BUTTONS AND NOT A SLIDER OR A NUMBER FIELD. The scale is CATEGORICAL-
// ORDINAL: the types are ordered, but the distance between them is not a quantity, and
// a slider invites the value between two of them that the scale does not define. Seven
// discrete targets also make the whole vocabulary visible at once, which is what makes
// a self-reported type comparable week to week — nobody remembers what "type 5" means,
// they recognize it.
//
// The number is therefore never TYPED here, which is the guard against a 0 or an 8 that
// matters most; `parseBristolType` re-asks in the action and again in the write core
// for a crafted post.
//
// EACH BUTTON CARRIES THE SCALE'S OWN DESCRIPTION as its accessible name, so a screen
// reader hears "Type 3, like a sausage but with cracks on the surface" rather than the
// two-word caption that has to fit on a phone. The glyph is decorative and hidden.
//
// **The sheet stays open after a tap**, like the food bar and the practice list: several
// movements a day is ordinary, and a person correcting a mis-tap should not have to
// reopen the sheet. The day's running count sits under the row so a second tap is
// informed. NO VERDICT — the count is a count, and nothing here says a type is good or
// bad (#2785 ships a recording surface; a finding is a later decision under the
// findings doctrine).
//
// ── THE SHEET STATES THE DAY (#5663 ruling 1, owner 2026-09-11) ──────────────
//
// The owner's report was "quicklogging stool provides no feedback or description": a
// tap moved a count, painted 300ms of motion and sent a toast that named a NUMBER, and
// the sentence that says what that number means lived behind the title row's info
// glyph (#5756) and in an accessible name. The ruling is not "the latest receipt and a
// count" — it is THE WHOLE DAY, on the sheet: each of today's entries as its own
// receipt row, newest first, two lines each, with one count line beneath.
//
//     Type 6 · Mushy
//     Fluffy pieces with ragged edges, a mushy stool · 8:31am      [Undo]
//     Type 3 · Cracked
//     Like a sausage but with cracks on the surface · 6:02am
//     2 today
//
// THE ROWS COME FROM THE SERVER, never from arithmetic on a client copy. The write
// answers with the day's readings and `loadStoolDay` re-reads them, for the reason
// `QuickPracticeList` re-reads its own: the sheet's props were gathered when it opened,
// and a movement removed from the record behind it would leave a receipt standing for a
// reading that is gone. The optimistic channel still carries the COUNT alone (#3728),
// which is the value a tap can honestly guess.
//
// AND THE `undo: null` DECLARATION IS RETIRED. It was declared rather than forgotten
// ("the record's ⋯ is where a movement is removed"), and the ruling reverses it: the
// record is another page, and the moment to catch a mis-tap is here. The inverse is the
// record's OWN — `deleteStoolReading` for a reading this tap added, `correctStoolReading`
// back to the previous type when this tap corrected one — so nothing was added to the
// write side to make the offer legitimate under lib/undo-offer.ts. The ERROR
// announcement's `undo: null` below stays: a refusal wrote nothing, and `undoToastPlan`
// refuses an Undo on an error tone anyway.
//
// UNDO RIDES THE NEWEST ROW, and only while that row is one THIS MOUNT landed. #2642 is
// "act, then undo" — an Undo beside a reading logged three hours ago and gathered from
// the store is a delete wearing the word, and the record's ⋯ is where a delete belongs.
export default function StoolTypeControl({
  todayCount,
  today,
  subjectProfileId,
}: {
  // How many Bristol readings this profile already has for today, from the server.
  todayCount: number;
  // The acting profile's today (YYYY-MM-DD) — the day the count counts and the day
  // the action files a tap under, so the "happened earlier" statement is anchored on
  // the SERVER's day rather than on a browser that may have crossed midnight.
  // `TAP_REACH` files this as a `today` tap; a BACKFILL states its day on `StoolForm`.
  today: string;
  // The quick-log sheet's chosen subject (#4932), when it is not the acting profile.
  // Posted as `profile_id` and re-gated by `logStoolForm`'s own `gateItemProfile`
  // call. Offline capture REFUSES rather than queues (see `offline` below) — the
  // same reason `OfflineDecision`'s comment gives: the replay carries no target
  // profile and would land on the wrong person.
  subjectProfileId?: number;
}) {
  // THE DAY COUNT IS THE OPTIMISTIC VALUE (#3728), declared to the pipeline rather than
  // painted and unwound here. Seven buttons write ONE count, so the ending a refusal
  // takes is not "the value this tap fired from" — a sibling type's reading may have
  // landed meanwhile — and that judgement is the pipeline's now.
  const pipeline = useWritePipeline<"stool-form", number>("stool-form");
  const toast = useToast();
  const prefs = useFormatPrefs();
  const dayContext = useOptionalDayContext();
  const writeDate = dayContext?.parts.day ?? today;
  const isPrimaryDay = dayContext
    ? dayContext.parts.day === dayContext.today
    : true;
  const [count, setCount] = useState(todayCount);
  const reducedMotion = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reducedMotion);
  const [settlingType, setSettlingType] = useState<number | null>(null);
  const [settleRuns, setSettleRuns] = useState<Record<number, number>>({});
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Happened earlier?" (#3273), through the shared statement (#4426). A tap still
  // writes the tap instant — the one-tap ledger is the point — and this is the escape
  // hatch for the log that arrives late, the ordinary case for a bowel movement
  // (#2785's grain argument). A day EARLIER than today is the record's door, not this
  // tap's (`TAP_REACH`).
  const statement = useTimeStatement({
    day: writeDate,
    required: !isPrimaryDay,
    timeLabel: "Time it happened",
    testId: "stool-when",
  });
  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    []
  );

  function settle(type: number) {
    if (!settlePlan.animate) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setSettlingType(type);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setSettlingType(null);
    }, settlePlan.ms);
  }
  // Follow the server whenever it disagrees — a reading can be removed elsewhere (the
  // record's ⋯ now does), and a count frozen at mount would claim a day that moved.
  const [serverCount, setServerCount] = useState(todayCount);
  if (serverCount !== todayCount) {
    setServerCount(todayCount);
    setCount(todayCount);
  }
  // THE DAY'S ENTRIES, AS THE SHEET LISTS THEM (#5663) — newest first, exactly as the
  // server hands them over. Never re-sorted or spliced here: a row is an address, and a
  // client-side edit of this list is a second opinion about what the store holds.
  const [readings, setReadings] = useState<StoolDayReading[]>([]);
  // THE READING THIS MOUNT LAST LANDED, which is what makes the newest row's Undo an
  // undo rather than a delete — and which of the two inverses it is.
  const [landed, setLanded] = useState<StoolReadingReceipt | null>(null);
  const [undoing, setUndoing] = useState(false);
  // Receipts do not survive a change of SUBJECT or DAY: re-pointed at another person or
  // another date, this is not the surface that earned them, and a row about someone
  // else's reading is the one thing a shared sheet must never print (#5738 makes the
  // same argument for the toast's slot). The re-read below then fills the new day in.
  const receiptScope = `${subjectProfileId ?? ""}:${writeDate}`;
  const [scope, setScope] = useState(receiptScope);
  if (scope !== receiptScope) {
    setScope(receiptScope);
    setReadings([]);
    setLanded(null);
    setUndoing(false);
  }

  // THE READ THE MOUNT DID NOT DO. `loadQuickEntry` gathers a COUNT for this body, which
  // was the whole receipt while the receipt was a count; the rows are asked for here,
  // on mount and after an inverse. A dropped read leaves the rows as they were and says
  // nothing — this is not a write, so there is no promise to walk back.
  //
  // IT DOES NOT TOUCH THE COUNT. The count is the pipeline's optimistic value (#3728),
  // and a read that landed while a tap was in flight would paint over the +1 the tap
  // had already shown. The caller that knows no write is outstanding — the inverse
  // below, which has just finished one — adopts the figure from the answer it gets.
  //
  // AND A SLOW READ NEVER OVERWRITES A FRESHER ANSWER. The mount's read and a tap race
  // by construction — the sheet opens and a finger lands — and a read that resolves
  // second would put the day back as it was before the tap, rows and all. Every
  // publication takes a ticket; a read applies only while its own is still the latest
  // one issued, so a write's answer (which takes a ticket too, below) shuts out every
  // read that was already in flight.
  const publication = useRef(0);
  const reread = useCallback(async () => {
    const ticket = (publication.current += 1);
    const fd = new FormData();
    fd.set("date", writeDate);
    if (subjectProfileId != null)
      fd.set("profile_id", String(subjectProfileId));
    const day = await loadStoolDay(fd).catch(() => null);
    if (day && publication.current === ticket) setReadings(day.readings);
    return day;
  }, [writeDate, subjectProfileId]);
  useEffect(() => {
    void reread();
  }, [reread]);

  // The reading's own clock, through the login's 12h/24h seam (#964) rather than the
  // stored 24-hour spelling — a row is prose, not a stored value being edited.
  const clockOf = (hhmm: string) =>
    formatClockValue(hhmm, prefs.timeFormat, "", "lower-nospace");

  // THE INVERSE, PICKED BY WHAT THE WRITE ACTUALLY DID. Both halves are the record's own
  // row writes (#4433) — nothing stool-shaped is added for the undo — and both re-derive
  // server-side: `gateItemProfile` re-authorizes the subject and the target carries the
  // metric, so a stale offer refuses rather than reaching another row.
  function inverse(reading: StoolReadingReceipt): UndoOffer {
    const replaced = reading.replacedType;
    return {
      undoneMessage:
        replaced != null ? `Type ${replaced} restored.` : "Movement removed.",
      run: async () => {
        const fd = new FormData();
        fd.set("id", String(reading.id));
        if (subjectProfileId != null)
          fd.set("profile_id", String(subjectProfileId));
        if (replaced != null) {
          fd.set("type", String(replaced));
          const corrected = await correctStoolReading(fd);
          if (!corrected.ok) return { ok: false, reason: "changed" };
        } else {
          const removed = await deleteStoolReading(fd);
          // `undoId` null is the action's only refusal shape: the row is not this
          // profile's, not a Bristol row, or already gone.
          if (removed.undoId == null) return { ok: false, reason: "changed" };
        }
        // The store moved, so the rows are ASKED FOR again rather than patched. The
        // correction arm leaves the count alone and the delete arm moves it, and that
        // difference is the server's to state, not this component's to compute.
        setLanded(null);
        const day = await reread();
        if (day) setCount(day.dayCount);
        return { ok: true };
      },
    };
  }

  // The row's Undo and the toast's Undo are ONE act. `useUndoableAction` owns the
  // toast's half; this is the same offer run from the row, reporting through the same
  // shared refusal vocabulary so one failure cannot read two ways.
  async function undoFromRow(reading: StoolReadingReceipt) {
    if (undoing) return;
    const offer = inverse(reading);
    setUndoing(true);
    try {
      const outcome = await offer
        .run()
        .catch(() => ({ ok: false, reason: "failed" }) as const);
      if (outcome.ok) toast(offer.undoneMessage);
      else toast(undoRefusalText(outcome.reason), { tone: "error" });
    } finally {
      setUndoing(false);
    }
  }

  async function tap(type: number) {
    // The statement THIS tap consumes, read once — both as the wall time it posts and
    // as the value the spend below compares against.
    const stated = statement.at;
    if (!isPrimaryDay && !stated) return;
    const result = await pipeline.run({
      key: String(type),
      // OPTIMISTIC, THEN THE SERVER'S OWN TOTAL. The count stays this surface's state;
      // the pipeline paints the +1, adopts `dayCount`, and puts the settled count back
      // when nothing was written.
      optimistic: { from: count, to: count + 1, commit: setCount },
      // ONLY when a time was actually stated, and never a day: the ABSENCE of each
      // field leaves the instant to the clock seam and the day to the action's `today`,
      // so an untouched sheet posts precisely the body it always posted (#3273).
      fields: {
        type: String(type),
        date: writeDate,
        ...(stated ? { at: stated } : {}),
        ...(subjectProfileId != null
          ? { profile_id: String(subjectProfileId) }
          : {}),
      },
      action: logStoolForm,
      settle: (res) => {
        if (!res.ok)
          return {
            wrote: false,
            announce: { message: res.error, tone: "error", undo: null },
          };
        settle(type);
        // Rule 4 of the shared statement: restating a minute CORRECTS the row the
        // first tap wrote rather than adding one, so the sheet cannot stay armed.
        statement.spend(stated);
        // THE DAY, FROM THE WRITE'S OWN ANSWER. One round trip: the action already
        // read the day's rows to work out which one this tap touched, so the sheet's
        // rows are the store's, not a client list with a +1 spliced into it. It takes a
        // publication ticket, which is what retires a mount read still in flight.
        publication.current += 1;
        setReadings(res.readings);
        // WHICH ROW THIS TAP LANDED ON. Absent when the write changed nothing the
        // day's rows can show — a re-tap of the type already at that instant — and the
        // newest row then carries no Undo, because there is nothing this tap can take
        // back that it put there.
        setLanded(res.reading ?? null);
        const landedClock = res.reading
          ? clockOf(
              res.readings.find((row) => row.id === res.reading?.id)?.hhmm ?? ""
            )
          : "";
        return {
          wrote: true,
          // The server's own total for the day, adopted over the +1 this tap guessed:
          // another device, a Telegram tap or a queued replay may have moved it.
          value: res.dayCount,
          // WHAT LANDED, INCLUDING WHAT DID NOT (#4425). The stated time is judged at
          // the write boundary, and a time it refuses costs the statement rather than
          // the observation — so the sentence says the reading is filed at the moment
          // of the tap instead of the minute typed. The phrasing is this surface's own:
          // the user TYPED the time here, so the shared "your device's clock is ahead"
          // note would diagnose the wrong machine (lib/stated-time.ts says so).
          //
          // THE UNDO IS READ FROM THIS RUN'S ANSWER, never from the state the answer
          // sets: `setLanded` above is queued, and a settle that asked the component
          // what it already knows would offer the PREVIOUS tap's inverse.
          announce: {
            message: res.statedTimeRefused
              ? res.statedTimeRefused === "future"
                ? `Logged type ${res.type} now — ${stated} hasn't happened yet.`
                : `Logged type ${res.type} now — ${stated} isn't a time on this day.`
              : // Ruling 1's toast grammar, `<Thing> logged · <time>`, confirming the
                // sentence the row is already showing. The minute is the STORED
                // reading's, so the toast and the row cannot name different times, and
                // the two forks this replaced — "at 23:50" when a time was stated,
                // bare when it was not — collapse into the one the row already draws.
                `Type ${res.type} logged${landedClock ? ` · ${landedClock}` : ""}`,
            undo: res.reading ? inverse(res.reading) : null,
          },
        };
      },
      failureMessage: "Couldn't log that. Try again.",
      offline: () =>
        subjectProfileId != null
          ? {
              kind: "refuse",
              message: OFFLINE_OTHER_SUBJECT_MESSAGE,
            }
          : {
              kind: "capture",
              flow: "stool",
              date: writeDate,
              payload: { type, at: stated },
              keptMessage: "Saved offline — will sync when you reconnect.",
            },
    });
    // A capture wrote the administration too, so it spends the statement — the online
    // arm already did, inside `settle`.
    if (result === "captured") statement.spend(stated);
  }

  // THE ROWS AS RENDERED: the vocabulary's two lines per reading, and the Undo on the
  // newest one — offered only while that newest reading is the one THIS MOUNT landed,
  // so the word stays "undo" rather than becoming a delete on a row gathered from the
  // store (#2642: the offer rides the write).
  const receiptRows = readings.flatMap((reading) => {
    const lines = bristolReceiptLines(reading.type, clockOf(reading.hhmm));
    return lines
      ? [
          {
            id: reading.id,
            lines,
            undoable:
              landed &&
              landed.id === reading.id &&
              reading.id === readings[0].id
                ? landed
                : null,
          },
        ]
      : [];
  });

  return (
    <div data-testid="quick-entry-stool">
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {BRISTOL_STOOL_TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            data-testid={`stool-type-${t.type}`}
            onClick={() => void tap(t.type)}
            disabled={!isPrimaryDay && !statement.at}
            aria-label={`Type ${t.type}, ${t.description}`}
            className="group relative flex flex-col items-center gap-1 px-1 py-2 text-slate-700 dark:text-slate-200"
          >
            <span
              aria-hidden="true"
              data-testid={`stool-settle-${t.type}`}
              data-motion="settle"
              data-reduced-motion={reducedMotion ? "true" : "false"}
              data-settling={settlingType === t.type ? "true" : "false"}
              data-motion-runs={settleRuns[t.type] ?? 0}
              onAnimationStart={() =>
                setSettleRuns((runs) => ({
                  ...runs,
                  [t.type]: (runs[t.type] ?? 0) + 1,
                }))
              }
              className={`absolute inset-0 rounded-lg border border-(--border) bg-surface transition group-hover:border-slate-400 dark:group-hover:border-slate-500${
                settlingType === t.type ? ` ${settlePlan.className}` : ""
              }`}
            />
            <span className="relative flex flex-col items-center gap-1">
              <BristolStoolIcon type={t.type} />
              <span className="text-sm font-medium tabular-nums">{t.type}</span>
              <span className="text-center text-xs leading-tight text-slate-500 dark:text-slate-400">
                {t.label}
              </span>
            </span>
          </button>
        ))}
      </div>
      {/* This domain's action is the GRID, so #4426's "immediately right" has no one
          button to sit against; the door takes the first seat after it instead. */}
      <div className="mt-3 flex items-center gap-2">{statement.door}</div>
      {statement.reveal ? <div className="mt-2">{statement.reveal}</div> : null}
      {/* THE DAY'S ENTRIES, NEWEST FIRST. POLITE, NOT ASSERTIVE: the tap is the
          person's own act, so the list reading itself back queues behind what they are
          doing rather than interrupting it; the toast carries the same sentence for
          anyone who has already moved on. */}
      {receiptRows.length > 0 ? (
        <ul
          className="mt-3 space-y-2"
          data-testid="quick-entry-stool-receipts"
          aria-live="polite"
        >
          {receiptRows.map((row) => (
            <li
              key={row.id}
              data-testid="quick-entry-stool-receipt"
              data-reading-id={row.id}
              className="flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <p
                  className="text-sm font-medium text-slate-700 dark:text-slate-200"
                  data-testid="quick-entry-stool-receipt-heading"
                >
                  {row.lines.heading}
                </p>
                <p
                  className="text-sm text-slate-500 dark:text-slate-400"
                  data-testid="quick-entry-stool-receipt-facts"
                >
                  {row.lines.facts}
                </p>
              </div>
              {row.undoable ? (
                <button
                  type="button"
                  className="btn-ghost shrink-0 text-sm"
                  data-testid="quick-entry-stool-receipt-undo"
                  disabled={undoing}
                  onClick={() => row.undoable && void undoFromRow(row.undoable)}
                >
                  {undoing ? "Undoing…" : "Undo"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p
        data-testid="quick-entry-stool-count"
        className="mt-3 text-sm text-slate-500 dark:text-slate-400"
      >
        {/* THE RULED COUNT LINE: `2 today`, beneath the rows. The zero state keeps its
            own sentence — with no rows above it, `0 today` would be the sheet printing
            the absence of a fact beside a control that already says what a tap does
            (#5431's argument for dropping a zero count). */}
        <RollingNumber
          value={count}
          testId="quick-entry-stool-rolling-count"
          format={(value) =>
            value === 0 ? "Nothing logged today." : `${value} today`
          }
        />
      </p>
    </div>
  );
}
