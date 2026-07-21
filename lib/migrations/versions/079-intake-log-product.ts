import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Snapshot a medication's selected formulation/concentration on every administration
// row. `intake_items.product` remains the current formulation, while this column keeps
// historical doses accurate after the medication is edited to a different product.
// Existing rows receive the current product as the best available legacy value.
//
// The triggers cover every write path (web, offline replay, Telegram, seed, and future
// callers) without duplicating snapshot logic. A skipped scheduled row is refreshed
// when it later crosses into `taken`, so it captures the formulation actually used.
export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(intake_item_logs)`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "product")) {
    db.exec(`ALTER TABLE intake_item_logs ADD COLUMN product TEXT`);
  }

  db.exec(`
    UPDATE intake_item_logs
       SET product = (
         SELECT i.product FROM intake_items i WHERE i.id = intake_item_logs.item_id
       )
     WHERE product IS NULL;

    CREATE TRIGGER IF NOT EXISTS intake_log_snapshot_product_insert
    AFTER INSERT ON intake_item_logs
    FOR EACH ROW
    WHEN NEW.product IS NULL
    BEGIN
      UPDATE intake_item_logs
         SET product = (SELECT i.product FROM intake_items i WHERE i.id = NEW.item_id)
       WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS intake_log_snapshot_product_taken
    AFTER UPDATE OF status ON intake_item_logs
    FOR EACH ROW
    WHEN NEW.status = 'taken' AND OLD.status <> 'taken'
    BEGIN
      UPDATE intake_item_logs
         SET product = (SELECT i.product FROM intake_items i WHERE i.id = NEW.item_id)
       WHERE id = NEW.id;
    END;
  `);
}

export const migration: Migration = {
  id: 79,
  name: "079-intake-log-product",
  up,
};
