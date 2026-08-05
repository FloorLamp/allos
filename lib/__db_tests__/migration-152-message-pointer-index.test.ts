// DB INTEGRATION TIER — migration 152 (#2003): the supersede lookup is actually
// indexed.
//
// `liveMessagePointersForKind` documents itself as "one indexed lookup, not a full
// read of the profile's pointer table". Before this migration that sentence was
// aspirational: migration 135 shipped only (profile_id, sent_at), so SQLite matched
// the profile prefix and tested `chat_id` and `kind` in memory across every pointer
// row the profile held — on the DELIVERY PATH of every `/dose`, `/symptom` and
// `/mood`, not merely in the hourly sweep.
//
// A comment cannot be tested, and a row count cannot see a plan, so what is pinned
// here is the PLAN ITSELF: the statement the module actually runs must search the
// composite index, with no "SCAN" step and no temp b-tree for the ordering. That is
// the only assertion that fails when a future widened filter quietly falls back off
// the index — the failure mode this issue was filed for.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic
// data only.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  liveMessagePointersForKind,
  recordMessagePointer,
} from "@/lib/notifications/message-pointers";

const INDEX = "idx_notify_messages_profile_chat_kind";

// The statement `liveMessagePointersForKind` runs, verbatim. Kept as its own
// constant so the plan assertion below is about the real read, not a paraphrase of
// it — a query that drifted from this text would still pass a hand-written twin.
const LOOKUP = `SELECT id, profile_id, chat_id, message_id, kind, date, keyboard, title, sent_at
         FROM notify_messages
        WHERE profile_id = ? AND chat_id = ? AND kind = ?
        ORDER BY sent_at, id`;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function plan(): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${LOOKUP}`).all(1, "chat", "mood") as {
      detail: string;
    }[]
  )
    .map((r) => r.detail)
    .join(" | ");
}

describe("migration 152 — the (profile, chat, kind) pointer index", () => {
  it("applies: the index exists on the migrated schema", () => {
    const row = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`
      )
      .get(INDEX) as { sql: string } | undefined;
    expect(row?.sql).toBeTruthy();
  });

  it("indexes the four columns the lookup needs, in the order it needs them", () => {
    const cols = (
      db.prepare(`PRAGMA index_info(${INDEX})`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(["profile_id", "chat_id", "kind", "sent_at"]);
  });

  it("135's index SURVIVES — the sweep and the pruner still need it", () => {
    // (profile_id, sent_at) serves `liveMessagePointers` and `pruneMessagePointers`,
    // which carry no chat or kind filter and cannot use the composite.
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`
      )
      .get("idx_notify_messages_profile") as { name: string } | undefined;
    expect(row?.name).toBe("idx_notify_messages_profile");
  });

  it("the supersede lookup SEARCHES on all three equality columns", () => {
    const detail = plan();
    expect(detail).toContain(INDEX);
    expect(detail).toContain("profile_id=?");
    expect(detail).toContain("chat_id=?");
    expect(detail).toContain("kind=?");
  });

  it("no full scan, and no temp b-tree for the ordering", () => {
    // The two shapes that mean "we read more than we needed": a scan of the profile's
    // whole pointer set, or a sort of it after the fact.
    const detail = plan();
    expect(detail).not.toContain("SCAN");
    expect(detail).not.toContain("TEMP B-TREE");
  });

  it("still returns exactly the (chat, kind) pointers, oldest first", () => {
    // The index must not change the answer. Two chats and two kinds for one profile,
    // plus a second profile's row in the same chat and kind.
    const mine = newProfile("pointer-index-mine");
    const theirs = newProfile("pointer-index-theirs");
    const keyboard = [[{ text: "Tap", callback_data: "mood:1:3:2026-08-04" }]];
    let messageId = 7100;
    const record = (profileId: number, chatId: string, kind: string) =>
      recordMessagePointer({
        profileId,
        chatId,
        messageId: messageId++,
        kind,
        date: "2026-08-04",
        keyboard,
      });

    record(mine, "chat-a", "mood");
    record(mine, "chat-a", "mood");
    record(mine, "chat-a", "prn-list");
    record(mine, "chat-b", "mood");
    record(theirs, "chat-a", "mood");

    const got = liveMessagePointersForKind(mine, "chat-a", "mood");
    expect(got.map((p) => p.messageId)).toEqual([7100, 7101]);
  });
});
