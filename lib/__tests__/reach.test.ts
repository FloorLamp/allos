import { describe, expect, it } from "vitest";
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
      "render app/(app)/history/page.tsx HistoryPage",
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
      "render app/(app)/history/page.tsx HistoryPage",
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
