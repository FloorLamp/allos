import type Database from "better-sqlite3";
import type { Migration } from "../runner";

export function up(db: Database.Database): void {
  // Existing messages have no declared chat subject; preserve their attribution.
  db.exec(`ALTER TABLE notify_messages
    ADD COLUMN chat_wide INTEGER NOT NULL DEFAULT 0 CHECK(chat_wide IN (0, 1))`);
}

export const migration: Migration = {
  name: "20260908-notify-message-chat-subject",
  up,
};
