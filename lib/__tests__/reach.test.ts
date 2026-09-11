import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { perTestCeiling } from "../../vitest.timeouts";
import { hops, reach, terminalSet } from "../../scripts/reach-graph";

// WHAT A SHARED DERIVATION REACHES, PINNED (#5680).
//
// A converted derivation is only as safe as the reviewer's list of who consumes
// it, and four hand-written lists on #5645 were each short by a hop — always the
// same way: the nearest surface named, the value travelling further, across a
// barrel or a module boundary, into something that renders or sends. These four
// are those symbols. Each pin is the FULL terminal set the walker finds on the
// current tree (`npx tsx scripts/reach.ts <module> <symbol>` prints the paths),
// plus the hop the table missed, pinned as a hop because the same terminal can be
// reachable by another path and the set alone would not notice the hop gone.
//
// A pin that goes red is the point: a new consumer of one of these, or a consumer
// removed, is a deliberate act that re-pins here with the change that made it.

const FIXTURES = [
  {
    symbol: "usualRoutineDayOffers",
    file: "lib/queries/usual-routine.ts",
    // Every one of these was absent from the PR body: a writing control on
    // History, the food bar's seeded offers, and the action the bar re-reads through.
    terminals: [
      "action app/(app)/actions.ts usualRoutineOffersOn",
      "render app/(app)/history/page.tsx renderHistory",
      "render app/(app)/nutrition/FoodTab.tsx FoodTab",
    ],
    missed: [],
  },
  {
    symbol: "pendingDayDoses",
    file: "lib/queries/usual-routine.ts",
    terminals: [
      "action app/(app)/actions.ts logUsualRoutine",
      "action app/(app)/actions.ts usualRoutineOffersOn",
      "action app/(app)/log-sheet-actions.ts loadLogSheetContext",
      "action app/(app)/nutrition/intake-actions.ts resolveDayDoses",
      "action app/(app)/quick-entry-actions.ts loadQuickEntry",
      "render app/(app)/history/page.tsx renderHistory",
      "render app/(app)/nutrition/FoodTab.tsx FoodTab",
      "render app/(app)/nutrition/ManageTab.tsx ManageTab",
      "render app/(app)/page.tsx renderDashboard",
      "route app/api/telegram/webhook/route.ts POST",
      "send lib/notifications/reconcile.ts reconcilePointer",
      "send lib/notifications/reconcile.ts reconcileProse",
      "send lib/notifications/refill.ts applyRefillReceiptPlan",
      "send lib/notifications/refill.ts handleOrderedRefillCallback",
      "send lib/notifications/refill.ts handleReceivedCallback",
      "send lib/notifications/refill.ts handleReceivedReply",
      "send lib/notifications/telegram-callbacks.ts handleAllTaken",
      "send lib/notifications/telegram-callbacks.ts handleDoseTap",
      "send lib/notifications/telegram-callbacks.ts handleFoodExpand",
      "send lib/notifications/telegram-callbacks.ts handleFoodLog",
      "send lib/notifications/telegram-callbacks.ts handleFoodProtein",
      "send lib/notifications/telegram-callbacks.ts handleStackTaken",
      "send lib/notifications/telegram-callbacks.ts handleStillGoingTap",
      "send lib/notifications/telegram-callbacks.ts handleUsualRoutineTap",
      "send lib/notifications/telegram-callbacks.ts rebuildDoseSession",
      "send lib/notifications/telegram-quick-log.ts handleFoodCommand",
      "send lib/notifications/telegram-quick-log.ts handlePracticeDoneTap",
      "send lib/notifications/telegram-quick-log.ts handleSymptomPick",
      "send lib/notifications/telegram-time-correction.ts rebuildDose",
      "send lib/notifications/telegram-time-correction.ts rebuildFood",
      "send lib/notifications/telegram-time-correction.ts rebuildPractice",
      "send lib/notifications/telegram.ts rebuildMessage",
      "send lib/notifications/tick.ts tickProfile",
    ],
    missed: [
      // The whole usualRoutineDayOffers branch above, entered through the offer.
      "lib/queries/usual-routine.ts#getUsualRoutineOffer -> lib/queries/usual-routine.ts#usualRoutineDayOffers",
      // The priority-1 host: the plan enters the tick's merged dose reminder, which
      // sends — not only the priority-2 food nudge the table named.
      "lib/notifications/usual-routine-plan.ts#planUsualRoutine -> lib/notifications/tick.ts#tickProfile",
    ],
  },
  {
    // File-local: the walker starts from a non-exported declaration.
    symbol: "scheduledDoseRows",
    file: "lib/queries/upcoming/intake-safety.ts",
    terminals: [
      "action app/(app)/log-sheet-actions.ts loadLogSheetContext",
      "action app/(app)/medical/document-actions.ts applyReprocessPreview",
      "action app/(app)/medical/document-actions.ts reprocessAllDocuments",
      "action app/(app)/medical/document-actions.ts reprocessDocumentFromRaw",
      "action app/(app)/medical/document-actions.ts uploadMedicalDocument",
      "action app/(app)/quick-entry-actions.ts loadQuickEntry",
      "action app/(app)/trends/actions.ts generateForDate",
      "render app/(app)/household/page.tsx HouseholdPage",
      "render app/(app)/integrations/calendar-feed/page.tsx CalendarFeedPage",
      "render app/(app)/medications/page.tsx MedicationsPage",
      "render app/(app)/page.tsx Dashboard",
      "render app/(app)/page.tsx renderDashboard",
      "render app/(app)/upcoming/page.tsx UpcomingPage",
      "render app/(app)/upcoming/page.tsx UpcomingTail",
      "route app/api/calendar/[token]/route.ts GET",
      "route app/api/calendar/family/[token]/route.ts GET",
      "route app/api/documents/route.ts POST",
      "route app/api/telegram/webhook/route.ts POST",
      "route app/share-target/route.ts POST",
      "send lib/notifications/digest-data.ts runDigest",
      "send lib/notifications/reconcile.ts reconcilePointer",
      "send lib/notifications/tick.ts tickProfile",
    ],
    missed: [
      // The dashboard gather's second caller, one line below the one written down,
      // and through it the whole Upcoming page.
      "lib/queries/attention.ts#collectAttentionDashboardData -> lib/queries/attention.ts#collectAttentionModel",
      "lib/queries/attention.ts#collectMultiProfileAttention -> app/(app)/upcoming/page.tsx#UpcomingPage",
    ],
  },
  {
    symbol: "getIntakeOffersForSlot",
    file: "lib/queries/intake/offers.ts",
    // Sends only, through its `getOfferedIntakeForSlot` shape as well. The Upcoming
    // and ICS rows the table gave this gather were never a consumer relation: they
    // belong to scheduledDoseRows above, and no binding leads from here to either.
    terminals: [
      "route app/api/telegram/webhook/route.ts POST",
      "send lib/notifications/digest-data.ts refreshDigestOfferTail",
      "send lib/notifications/digest-data.ts runDigest",
      "send lib/notifications/reconcile.ts reconcilePointer",
      "send lib/notifications/telegram-quick-log.ts handleOfferTailTap",
      "send lib/notifications/telegram-quick-log.ts handlePrnLogTap",
      "send lib/notifications/telegram-quick-log.ts handleTuneTap",
      "send lib/notifications/telegram-quick-log.ts rebuildOfferListWithChips",
      "send lib/notifications/tick.ts runManualNotification",
      "send lib/notifications/tick.ts tickProfile",
    ],
    missed: [],
  },
];

describe("what a shared derivation reaches (#5680)", () => {
  it.each(FIXTURES)("$symbol", ({ file, symbol, terminals, missed }) => {
    const result = reach(file, symbol);
    expect(terminalSet(result)).toEqual(terminals);
    expect(hops(result)).toEqual(expect.arrayContaining(missed));
  });
});

// WHAT THE CLI HANDS A CALLER THROUGH A PIPE (#5804).
//
// `scripts/reach.ts --json` is read as a child process — by the merge gate's
// reach row, and by anyone piping it to `jq`. It used to `console.log` the
// document and `process.exit(0)` in the next statement; on a pipe that write is
// asynchronous, so anything past the buffer was dropped and the caller saw
// status 0 over a half-written document. The gate reported it as
// `Unterminated string in JSON at position 146176`, which reads like a walker
// fault and sends the reader to the wrong file.
//
// WHY THE READER HOLDS THE PIPE (#5831). Whether a child that exits on its
// write loses bytes is a race between that exit and the reader's drain, so a
// test that needs the loss to happen is asserting the machine's luck: the
// earlier version of this block did, and both arms of it — the control AND the
// subject — went the wrong way on CI while passing everywhere else.
//
// This reader refuses to drain instead. Node pulls from a child pipe only while
// something consumes it, so holding stdout unread fills the OS buffer and leaves
// the rest of the write unfinishable: a child that exits in the next statement
// MUST lose what did not fit, and one that waits for stdout to flush delivers
// all of it the moment reading starts. That is a harsher reader than the merge
// gate's, deliberately — the difference #5804 is about becomes the only outcome
// rather than the likely one.
//
// Nothing below asserts WHERE a cut lands, or what `size` is. `size` is a walk
// over most of the app and moves with everyone's work; all it has to be is
// bigger than a pipe buffer, which the control establishes rather than assumes.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PIPE_MS = perTestCeiling(3, "green"); // ~12.3 s observed, 2026-09-11

// Long enough to outlast `process.exit` in the statement after a `console.log`,
// which is the only thing it has to cover: a child still holding an unfinished
// write is blocked on the full pipe and will not exit until reading starts.
const HELD_MS = 500;

/**
 * Run a command and read its stdout only after it has stopped writing, so a
 * child that leaves before stdout drains cannot deliver what it queued.
 */
async function readAfterTheWriteIsStuck(
  command: string,
  args: readonly string[]
): Promise<{ status: number | null; stdout: string }> {
  const child = spawn(command, [...args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // stderr is a line at most and is drained throughout: only stdout is held.
  child.stderr.resume();
  const exited = once(child, "exit");
  // Hold stdout unread. Whichever comes first — the child giving up and exiting,
  // or it blocking on a pipe it cannot finish filling — reading is safe after.
  await once(child.stdout, "readable");
  await Promise.race([exited, delay(HELD_MS)]);

  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
  const [status] = (await exited) as [number | null];
  return { status, stdout: Buffer.concat(chunks).toString("utf8") };
}

/** The #5804 shape, as a child of its own: write `bytes`, then leave or wait. */
const writeThen = (bytes: number, exit: boolean) =>
  `console.log("x".repeat(${bytes}));${exit ? " process.exit(0);" : ""}`;

describe("the --json CLI over a pipe (#5804)", () => {
  // Reached by most of the app, so its answer is far larger than any pipe
  // buffer. If that stops being true the control below says so.
  const FILE = "lib/date.ts";
  const SYMBOL = "hhmmToMinutes";

  it(
    "delivers the whole document, not the part that fit",
    async () => {
      const walked = reach(FILE, SYMBOL);
      const complete = JSON.stringify({
        start: walked.start,
        terminals: terminalSet(walked),
        hops: hops(walked),
      });
      const size = Buffer.byteLength(complete);

      // THE CONTROL, ON THE HARNESS AND THE FIXTURE. Two children differing only
      // by the `process.exit` #5804 removed, each writing this walk's own answer.
      // The reader has to separate them: if it does not, the fixture is smaller
      // than a pipe buffer or the hold is not holding, and the subject below
      // would pass over a regressed CLI. Both arms are forced, not raced.
      const [cut, whole] = await Promise.all([
        readAfterTheWriteIsStuck(process.execPath, [
          "-e",
          writeThen(size, true),
        ]),
        readAfterTheWriteIsStuck(process.execPath, [
          "-e",
          writeThen(size, false),
        ]),
      ]);
      expect(cut.status).toBe(0);
      expect(whole.status).toBe(0);
      expect(Buffer.byteLength(cut.stdout)).toBeLessThan(size);
      expect(Buffer.byteLength(whole.stdout)).toBeGreaterThan(size);

      const run = await readAfterTheWriteIsStuck("npx", [
        "tsx",
        "scripts/reach.ts",
        FILE,
        SYMBOL,
        "--json",
      ]);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(JSON.parse(complete));
    },
    PIPE_MS
  );
});
