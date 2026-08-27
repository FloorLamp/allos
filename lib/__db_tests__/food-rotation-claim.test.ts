// DB INTEGRATION TIER — rotatePointer claims before it strips (#2827).
//
// ── PART A: the measured race, through the real lock ─────────────────────────
//
// `closeSuperseded` claims with the #1788 compare-and-swap before editing;
// `rotatePointer` used to strip blind and then delete the pointer row with a
// plain DELETE. The suspected interleaving: the hourly sweep reads the food
// pointer, the rotation strips/deletes it, and the sweep's in-flight edit then
// puts a live keyboard back on the message the rotation just closed — with the
// row gone, NOTHING can ever strip it again, and its tokens carry their
// send-time date (the wrong-day tap #947 exists to prevent).
//
// The fixture below drives that interleaving DETERMINISTICALLY through the real
// claim machinery ("the lock" — the writeTx compare-and-swap in
// lib/notifications/message-pointers.ts), with barriers at the only places an
// in-process interleave can happen: the stubbed network awaits. The verdict it
// measured: REACHABLE. The sweep's own claim defends only the orderings where
// the rotation's row-write lands BEFORE the sweep's claim; a rotation whose
// blind strip was in flight while the sweep read, claimed and rebuilt produced
// exactly the stranded keyboard above. So per the issue's closed outcome,
// `rotatePointer` now acquires the same claim vocabulary before stripping: the
// claim (a versioned row delete) lands before any network call, the sweep then
// finds no row and edits nothing, and a rotation that LOST the row to a writer
// that moved it performs no edit at all — a typed no-op.
//
// The residual both vocabularies share (documented at rotatePointer): a claim
// taken while another claimant's edit is already in flight on the network is
// invisible to either side's witness. That window is one network call wide and
// stays inside the #1788 convergence posture; it is not asserted away here.
//
// ── PART B: one classifier, one retention interpretation ─────────────────────
//
// A failed strip used to keep the pointer row unconditionally — three days of
// hourly retries against a message Telegram said was deleted. It now goes
// through `classifyTelegramFailure` exactly as the sweep and `closeSuperseded`
// do: permanent retires the row in the same call, transient restores it for the
// next sweep, unknown follows the classifier's conservative transient branch.
// The cases iterate the SHARED fixture list (telegram-failure-fixtures.ts) that
// kind-supersede.test.ts also runs, so the two strip paths cannot drift.
//
// Every value is synthetic. No PHI.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";
import { TELEGRAM_FAILURE_FIXTURES } from "./telegram-failure-fixtures";

import { db, today } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { getFoodNudgePointer } from "@/lib/settings/notifications";
import { dispatch, getNotifyError } from "@/lib/notifications";
import {
  editMessageTextRaw,
  editMessageReplyMarkupRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import {
  claimMessagePointerKeyboard,
  liveMessagePointersForKind,
} from "@/lib/notifications/message-pointers";
import { rotatePointer } from "@/lib/notifications/telegram";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { buildFoodNudge } from "@/lib/notifications/food";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

beforeAll(() => stubTelegramSends());

const sendMock = vi.mocked(sendMessageRaw);
const editTextMock = vi.mocked(editMessageTextRaw);
const stripMock = vi.mocked(editMessageReplyMarkupRaw);

const CHAT = "5550412";
let p: SeededProfile;
let t: string;

function addServing(group = "leafy_greens"): void {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
  ).run(p.profileId, t, group);
}

function liveFoodPointers() {
  return liveMessagePointersForKind(p.profileId, CHAT, "food");
}

async function sendNudge(): Promise<number> {
  const before = sendMock.mock.calls.length;
  await dispatch(p.profileId, buildFoodNudge(p.profileId, "Morning", t)!);
  expect(sendMock.mock.calls.length).toBe(before + 1);
  const last = sendMock.mock.results[sendMock.mock.results.length - 1];
  return (await last.value) as number;
}

// Drain microtasks so an in-flight dispatch reaches its held network call.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeAll(() => {
  p = seedProfile("rotation-claim");
  t = today(p.profileId);
  setSetting("telegram_bot_token", "test-bot-token");
  seedLoginTelegram(p.profileId, CHAT);
});

beforeEach(() => {
  sendMock.mockClear();
  editTextMock.mockClear();
  stripMock.mockClear();
  editTextMock.mockImplementation(async () => {});
  stripMock.mockImplementation(async () => {});
  db.prepare("DELETE FROM notify_messages WHERE profile_id = ?").run(
    p.profileId
  );
  db.prepare(
    "DELETE FROM food_daily_totals WHERE profile_id = ? AND date = ?"
  ).run(p.profileId, t);
  db.prepare(
    "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'food_nudge_last_message'"
  ).run(p.profileId);
  db.prepare("DELETE FROM notify_lifecycle").run();
  setSetting("notify_last_error", "");
  setSetting("notify_last_error_at", "");
  setSetting("notify_last_error_channel", "");
  addServing();
});

// ── Part A: the barrier fixture ──────────────────────────────────────────────

describe("rotation racing the sweep, through the real claim (#2827 A)", () => {
  it("a rotation whose strip is in flight has already claimed the row — the sweep edits nothing", async () => {
    // Send 1: a live food keyboard, pointer row + settings pointer recorded.
    const msg1 = await sendNudge();
    expect(liveFoodPointers().map((x) => x.messageId)).toEqual([msg1]);

    // The ledger moves, so the sweep now WANTS to rebuild message 1 (the food
    // family re-renders and edits whenever the render differs — the exact edit
    // that used to re-arm a stripped keyboard, #2749).
    addServing();

    // Send 2 with the STRIP held at the barrier: the rotation's DB section has
    // run (claim = versioned row delete), its network edit has not landed.
    const releases: (() => void)[] = [];
    stripMock.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve))
    );
    const send2 = dispatch(
      p.profileId,
      buildFoodNudge(p.profileId, "Morning", t)!
    );
    await settle();
    expect(stripMock).toHaveBeenCalledTimes(1);
    expect(String(stripMock.mock.calls[0][0])).toBe(CHAT);
    expect(stripMock.mock.calls[0][1]).toBe(msg1);

    // THE BARRIER'S QUESTION. The sweep runs NOW, mid-strip. Before the claim,
    // message 1's row was still present here (the old code deleted it only
    // after the strip resolved): the sweep claimed it, rebuilt message 1 with a
    // live keyboard, and the rotation then deleted the row — a keyboard nothing
    // could ever strip again. With the claim, the row is already gone, so the
    // sweep has nothing to reconcile for message 1.
    editTextMock.mockClear();
    await reconcileProfileMessages(p.profileId);
    const editsOnMsg1 = editTextMock.mock.calls.filter((c) => c[1] === msg1);
    expect(editsOnMsg1).toEqual([]);

    // Release the strip: it lands LAST, so the final state of message 1 is the
    // stripped (button-less) one — at most ONE edit ever touched it.
    releases.forEach((release) => release());
    await send2;
    expect(stripMock).toHaveBeenCalledTimes(1);

    // The bookkeeping agrees with the chat: one live pointer, the new message's;
    // the settings pointer names the new message.
    const live = liveFoodPointers();
    expect(live).toHaveLength(1);
    expect(live[0].messageId).toBeGreaterThan(msg1);
    expect(getFoodNudgePointer(p.profileId)?.messageId).toBe(live[0].messageId);
  });

  it("the sweep claiming FIRST makes the rotation's loss a typed no-op — no edit at all", async () => {
    // The other order at the same barrier: the sweep's claim lands between the
    // rotation's witness read and its own claim. In-process those two are one
    // synchronous section, so the cross-process shape is driven through the
    // rotation's injected settings write — the seam between the read and the
    // claim — using the REAL compare-and-swap on the real row.
    const msg1 = await sendNudge();
    const row = liveFoodPointers()[0];

    stripMock.mockClear();
    const outcome = await rotatePointer(
      "food nudge",
      p.profileId,
      () => ({ chatId: CHAT, messageId: msg1 + 1 }),
      () => ({ chatId: CHAT, messageId: msg1 }),
      () => {
        // The sweep wins the row in between: its keyboard claim moves the
        // version witness, exactly as reconcileOne's claim-first arm does.
        expect(
          claimMessagePointerKeyboard(p.profileId, row.id, row.version, [
            [{ text: "sweep", callback_data: "noop" }],
          ])
        ).toBe(true);
      }
    );

    // The loser performs no edit: no strip call, and the row stays exactly as
    // the winning claimant left it.
    expect(outcome).toBe("claim-lost");
    expect(stripMock).not.toHaveBeenCalled();
    expect(liveFoodPointers().map((x) => x.messageId)).toEqual([msg1]);
  });

  it("a strip target with no pointer row is still stripped blind — the settings pointer is its only closer", async () => {
    const msg1 = await sendNudge();
    // Best-effort bookkeeping failed at send time: no row was ever recorded.
    db.prepare("DELETE FROM notify_messages WHERE profile_id = ?").run(
      p.profileId
    );
    stripMock.mockClear();
    const outcome = await rotatePointer(
      "food nudge",
      p.profileId,
      () => ({ chatId: CHAT, messageId: msg1 + 1 }),
      () => ({ chatId: CHAT, messageId: msg1 }),
      () => {}
    );
    expect(outcome).toBe("stripped");
    expect(stripMock).toHaveBeenCalledTimes(1);
  });
});

// ── Part B: permanent/transient through the shared classifier ────────────────

describe("strip failures split permanent/transient (#2827 B)", () => {
  for (const fixture of TELEGRAM_FAILURE_FIXTURES) {
    it(`${fixture.name}: ${
      fixture.classified === "permanent"
        ? "retires the pointer in the same call"
        : "keeps the pointer for the next sweep"
    }`, async () => {
      const msg1 = await sendNudge();
      addServing();
      stripMock.mockImplementation(async () => {
        throw fixture.make();
      });
      await sendNudge();

      const stillNamed = liveFoodPointers().some((x) => x.messageId === msg1);
      if (fixture.classified === "permanent") {
        // The message is gone for good: the row is retired NOW, not after three
        // days of doomed hourly retries.
        expect(stillNamed).toBe(false);
      } else {
        // The keyboard is still live in the chat, and the restored row is the
        // only record of it — the next sweep retries from it.
        expect(stillNamed).toBe(true);
        // And the sweep genuinely can: the ledger moved, so reconciliation
        // claims the restored row and edits message 1 (the retry the retention
        // interpretation promises), bounded by the pointer's own horizon.
        stripMock.mockImplementation(async () => {});
        editTextMock.mockClear();
        await reconcileProfileMessages(p.profileId);
        expect(editTextMock.mock.calls.some((c) => c[1] === msg1)).toBe(true);
      }
    });
  }

  it("a failed strip never turns a delivered nudge into a channel failure", async () => {
    await sendNudge();
    addServing();
    stripMock.mockImplementation(async () => {
      throw TELEGRAM_FAILURE_FIXTURES[0].make();
    });
    const results = await dispatch(
      p.profileId,
      buildFoodNudge(p.profileId, "Morning", t)!
    );
    expect(results.find((r) => r.id === "telegram")?.ok).toBe(true);
    expect(getNotifyError()).toBeNull();
  });

  it("a SUCCESSFUL strip leaves no pointer behind", async () => {
    const msg1 = await sendNudge();
    await sendNudge();
    expect(liveFoodPointers().some((x) => x.messageId === msg1)).toBe(false);
  });
});
